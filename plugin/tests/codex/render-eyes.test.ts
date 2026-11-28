import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'

import { RenderEyes, renderHistoryFiles, type RenderDiff, type RenderHistoryFiles, type ShownPart } from '../../src/codex/render-eyes.js'
import { createLogger } from '../../src/log.js'

const filename = 'render-diffs.json'

test('[R42] loading legacy render history atomically purges excerpts once and keeps current diffs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-render-history-'))
  try {
    const file = join(dir, filename)
    const current: RenderDiff = { ts: '2026-11-27T11:20:00.000Z', messageIds: [300], formats: ['HTML'],
      collapsedBlankLines: 0, degradations: [{ kind: 'raw_markup', code: 'tag' }] }
    const legacy = { ...current, messageIds: [299],
      degradations: [{ kind: 'raw_markup', shown: '<id blue>', expected: 'formatting', literal: false }] }
    writeFileSync(file, JSON.stringify({ diffs: [legacy, current] }))
    const originalInode = statSync(file).ino
    expect(new RenderEyes({ file }).recent()).toEqual([current])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ diffs: [current] })
    expect(readdirSync(dir)).toEqual([filename])
    const rewrittenInode = statSync(file).ino
    expect(rewrittenInode).not.toBe(originalInode)
    expect(new RenderEyes({ file }).recent()).toEqual([current])
    expect(statSync(file).ino).toBe(rewrittenInode)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test.each([
  ['invalid JSON', '{"diffs": [damaged content'],
  ['invalid shape', '{"diffs": "damaged content"}'],
])('[R42] loading corrupt render history (%s) moves it aside and warns once', (_label, body) => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-render-history-'))
  try {
    const file = join(dir, filename)
    writeFileSync(file, body)
    const warnings: unknown[] = []
    const stream = new Writable({ write(_chunk, _encoding, done) { done() } })
    const log = createLogger('test', { stream, sink: (level, _name, message, context) => {
      if (level === 'warn') warnings.push({ message, context })
    } })
    expect(new RenderEyes({ file, log }).recent()).toEqual([])
    expect(existsSync(file)).toBe(false)
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    const [moved] = files
    if (!moved) throw new Error('Missing corrupt history backup')
    expect(moved.startsWith(filename + '.corrupt-')).toBe(true)
    expect(readFileSync(join(dir, moved), 'utf8')).toBe(body)
    expect(new RenderEyes({ file, log }).recent()).toEqual([])
    expect(warnings).toEqual([{ message: expect.stringMatching(/corrupt render history/i), context: { area: 'render' } }])
    expect(JSON.stringify(warnings)).not.toContain('damaged content')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Replaces the history the way another writer would: a new file renamed over the old one.
function replaceHistory(file: string, body: string): void {
  writeFileSync(file + '.replacement', body)
  renameSync(file + '.replacement', file)
}

// A history read that lets another writer replace the file right after it was read, once.
function replacedAfterRead(body: string): RenderHistoryFiles {
  let replaced = false
  return { ...renderHistoryFiles, read(path) {
    const read = renderHistoryFiles.read(path)
    if (!replaced) {
      replaced = true
      replaceHistory(path, body)
    }
    return read
  } }
}

const newer: RenderDiff = { ts: '2026-11-27T11:30:00.000Z', messageIds: [301], formats: ['plain'],
  collapsedBlankLines: 0, degradations: [] }

test('[R42] a history replaced after it was read is judged again, never overwritten by the migration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-render-history-'))
  try {
    const file = join(dir, filename)
    const current: RenderDiff = { ts: '2026-11-27T11:20:00.000Z', messageIds: [300], formats: ['HTML'],
      collapsedBlankLines: 0, degradations: [] }
    const legacy = { ...current, messageIds: [299],
      degradations: [{ kind: 'raw_markup', shown: '<id blue>', expected: 'formatting', literal: false }] }
    writeFileSync(file, JSON.stringify({ diffs: [legacy, current] }))
    const replacement = JSON.stringify({ diffs: [current, newer] })
    expect(new RenderEyes({ file, files: replacedAfterRead(replacement) }).recent()).toEqual([newer, current])
    expect(readFileSync(file, 'utf8')).toBe(replacement)
    expect(readdirSync(dir)).toEqual([filename])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[R42] a corrupt history replaced by a valid one after it was read is never moved aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-render-history-'))
  try {
    const file = join(dir, filename)
    writeFileSync(file, '{"diffs": [damaged')
    const replacement = JSON.stringify({ diffs: [newer] })
    expect(new RenderEyes({ file, files: replacedAfterRead(replacement) }).recent()).toEqual([newer])
    expect(readFileSync(file, 'utf8')).toBe(replacement)
    expect(readdirSync(dir)).toEqual([filename])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[R42] no save replaces a corrupt history until it is moved aside', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-render-history-'))
  try {
    const file = join(dir, filename)
    const body = '{"diffs": [damaged'
    writeFileSync(file, body)
    let denied = 2
    const files: RenderHistoryFiles = { ...renderHistoryFiles, rename(from, to) {
      if (to.includes('.corrupt-') && denied > 0) {
        denied -= 1
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      renderHistoryFiles.rename(from, to)
    } }
    const eyes = new RenderEyes({ file, files })
    const part: ShownPart = { format: 'plain', text: 'plain' }
    eyes.record({ source: 'plain', parts: [{ ...part, messageId: 401 }] })
    await new Promise(resolve => setImmediate(resolve))
    // The quarantine failed again: the corrupt file stays as it was and nothing replaced it.
    expect(readdirSync(dir)).toEqual([filename])
    expect(readFileSync(file, 'utf8')).toBe(body)
    eyes.record({ source: 'plain', parts: [{ ...part, messageId: 402 }] })
    await new Promise(resolve => setImmediate(resolve))
    const backup = readdirSync(dir).find(name => name.startsWith(filename + '.corrupt-'))
    if (!backup) throw new Error('Missing corrupt history backup')
    expect(readFileSync(join(dir, backup), 'utf8')).toBe(body)
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved).toMatchObject({ diffs: [{ messageIds: [401] }, { messageIds: [402] }] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('[R42] an unreadable history blocks every save until it can be read, then keeps its diffs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'krot-render-history-'))
  try {
    const file = join(dir, filename)
    const kept: RenderDiff = { ts: '2026-11-27T11:20:00.000Z', messageIds: [300], formats: ['HTML'],
      collapsedBlankLines: 0, degradations: [] }
    const body = JSON.stringify({ diffs: [kept] })
    writeFileSync(file, body)
    let denied = 2
    const files: RenderHistoryFiles = { ...renderHistoryFiles, read(path) {
      if (denied > 0) {
        denied -= 1
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
      return renderHistoryFiles.read(path)
    } }
    const eyes = new RenderEyes({ file, files })
    const part: ShownPart = { format: 'plain', text: 'plain' }
    eyes.record({ source: 'plain', parts: [{ ...part, messageId: 401 }] })
    await new Promise(resolve => setImmediate(resolve))
    // Still unreadable at the first save: the history on disk is left exactly as it was.
    expect(readFileSync(file, 'utf8')).toBe(body)
    eyes.record({ source: 'plain', parts: [{ ...part, messageId: 402 }] })
    await new Promise(resolve => setImmediate(resolve))
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved).toMatchObject({ diffs: [{ messageIds: [300] }, { messageIds: [401] }, { messageIds: [402] }] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
