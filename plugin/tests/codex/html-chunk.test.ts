// Long formatted replies are split into Telegram HTML parts. Telegram counts a message's length after
// entity parsing (`&amp;` is one character, tags are none) and rejects a part over 4096 characters, so each
// part must be valid HTML on its own, fit the limit as Telegram measures it, and lose no text.

import { expect, test } from 'bun:test'

import { resumeMessagePlan, splitMessage, splitMessageFrom, splitPlainFallback, splitPlainMessage } from '../../src/format/chunk.js'
import { splitMessageLegacy } from '../../src/format/chunk-legacy.js'
import { escapeHtml, markdownToTelegramHtml } from '../../src/format/html.js'
import { validateTelegramHtml } from '../../src/safety/html-validator.js'
import { redactOutboundText } from '../../src/safety/safe-telegram-api.js'

// Independent oracle for valid input: drop tags, decode the entities Telegram supports.
function visibleText(html: string): string {
  return html.replace(/<br\s*\/?>/giu, '\n').replace(/<[^>]*>/gu, '')
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/gu, '&')
}

// Deterministic PRNG so a failure reproduces.
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const words = ['Привет', 'text', '&', '<', '>', '"', 'a&b', '😀', 'x', '\n', '\n\n', ' ', 'длинное-слово', '&&&&&&&&']
const tags = ['b', 'i', 'u', 's', 'code', 'tg-spoiler', 'a href="https://example.com/?a=1&amp;b=2"',
  'blockquote expandable', 'pre', 'em', 'strong']

function randomHtml(next: () => number, depth = 0): string {
  let out = ''
  const parts = 1 + Math.floor(next() * 12)
  for (let part = 0; part < parts; part++) {
    if (depth < 3 && next() < 0.3) {
      const tag = tags[Math.floor(next() * tags.length)]!
      out += `<${tag}>` + randomHtml(next, depth + 1) + `</${tag.split(' ')[0]}>`
    } else {
      const count = 1 + Math.floor(next() * 30)
      for (let i = 0; i < count; i++) out += escapeHtml(words[Math.floor(next() * words.length)]!) + ' '
    }
  }
  return out
}

function expectSafeParts(html: string, max: number): void {
  const parts = splitMessage(html, max)
  for (const part of parts) {
    expect(visibleText(part).length).toBeLessThanOrEqual(max)
    expect(validateTelegramHtml(part).downgraded).toBe(false)
    expect(visibleText(part).trim().length).toBeGreaterThan(0)
  }
  // Trailing whitespace alone is not a part (Telegram trims message edges and refuses an empty one).
  expect(parts.map(visibleText).join('').trimEnd()).toBe(visibleText(html).trimEnd())
}

test('random formatted inputs split into valid parts within the limit that keep every character', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = prng(seed)
    let html = ''
    while (html.length < 2_000) html += randomHtml(next)
    const max = 40 + Math.floor(next() * 400)
    expectSafeParts(html, max)
  }
})

test('the Markdown renderer output of a long reply splits into valid parts within the Telegram limit', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const next = prng(seed)
    const lines: string[] = []
    while (lines.join('\n').length < 20_000) {
      const word = (): string => words[Math.floor(next() * words.length)]!.replace(/\n/gu, '')
      const line = Array.from({ length: 5 + Math.floor(next() * 40) }, word).join(' ')
      lines.push(next() < 0.3 ? `**${line}**` : next() < 0.5 ? `_${line}_` : line)
      if (next() < 0.3) lines.push('')
    }
    expectSafeParts(markdownToTelegramHtml(lines.join('\n')), 4000)
  }
})

test('a bold span of 5,000 ampersands splits on entity boundaries into bold parts within the limit', () => {
  const html = markdownToTelegramHtml('**' + '&'.repeat(5_000) + '**')
  const parts = splitMessage(html)
  expect(parts.length).toBe(2)
  for (const part of parts) {
    expect(part.startsWith('<b>')).toBe(true)
    expect(part.endsWith('</b>')).toBe(true)
    expect(visibleText(part).length).toBeLessThanOrEqual(4000)
  }
  expectSafeParts(html, 4000)
})

test('a bold span of 900 ampersands is one part: Telegram counts each entity as one character', () => {
  const html = markdownToTelegramHtml('**' + '&'.repeat(900) + '**')
  expect(html.length).toBeGreaterThan(4096)
  expect(splitMessage(html)).toEqual([html])
})

test('a cut never lands inside an opening tag or an entity', () => {
  for (let offset = 0; offset < 12; offset++) {
    const html = 'x'.repeat(30 + offset) + '<b>bold &amp; more</b> tail &quot;quoted&quot; end'
    expectSafeParts(html, 32)
  }
})

test('plain text splits by its raw length and never gets tags inserted', () => {
  const text = ('<b>не тег</b> &amp; ' + 'слово '.repeat(10) + '\n').repeat(60)
  const parts = splitPlainMessage(text, 200)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(200)
  expect(parts.join('')).toBe(text)
})

test('a paragraph cut keeps the closing tags that follow it in the same part', () => {
  const html = '<b>' + 'a'.repeat(30) + '\n\n</b>' + 'b'.repeat(30)
  expect(splitMessage(html, 40)).toEqual(['<b>' + 'a'.repeat(30) + '\n\n</b>', 'b'.repeat(30)])
})

test('the plain fallback of a downgraded part is no longer than its Telegram length', () => {
  const invalid = '<b>' + '&amp;'.repeat(1_000) + '<div>'
  const validated = validateTelegramHtml(invalid)
  expect(validated.downgraded).toBe(true)
  expect(validated.text).toBe('&'.repeat(1_000) + '<div>')
  expect(validated.text).not.toContain('&amp;')
})

test('local Markdown links keep their label and escaped path without downgrading surrounding HTML', () => {
  const html = markdownToTelegramHtml('**See** [Runbook](file:///tmp/runbook.md) [Local](/tmp/a&b.ts:21) [Docs](https://example.org)')
  expect(html).toBe('<b>See</b> Runbook (<code>file:///tmp/runbook.md</code>) Local (<code>/tmp/a&amp;b.ts:21</code>) <a href="https://example.org">Docs</a>')
  expect(validateTelegramHtml(html).downgraded).toBe(false)
})

test('local Markdown paths preserve backticks, asterisks and underscores as literal text', () => {
  const html = markdownToTelegramHtml('[`Open`](/tmp/`draft`/*plan*/_v2_.md) `[example](/tmp/file)`')
  expect(html).toBe('<code>Open</code> (<code>/tmp/`draft`/*plan*/_v2_.md</code>) <code>[example](/tmp/file)</code>')
  expect(validateTelegramHtml(html).downgraded).toBe(false)
})

test('a downgraded raw HTML link keeps its destination in the plain fallback, within the Telegram limit', () => {
  // The destinations are added only while the fallback stays within Telegram's limit.
  const long = 'x'.repeat(4_000) + '<a href="file:///a">a</a><a href="file:///bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">b</a>'
  const bounded = validateTelegramHtml(long)
  expect(bounded.downgraded).toBe(true)
  expect(bounded.text.length).toBeLessThanOrEqual(4096)
  expect(bounded.text).toContain('a (file:///a)')
  expect(bounded.text.endsWith('b')).toBe(true)
})

test('a preformatted block keeps every whitespace character across parts', () => {
  const html = '<pre>start\n' + ' '.repeat(4_000) + '\nend</pre>'
  const parts = splitMessage(html)
  expect(parts.length).toBeGreaterThan(1)
  for (const part of parts) {
    expect(validateTelegramHtml(part).downgraded).toBe(false)
    expect(visibleText(part).length).toBeLessThanOrEqual(4000)
    // Telegram refuses a message that shows only whitespace.
    expect(visibleText(part).trim().length).toBeGreaterThan(0)
  }
  expect(parts.map(visibleText).join('')).toBe(visibleText(html))
})

test('an unpartitionable preformatted span signals document fallback', () => {
  const html = '<pre>start\n' + ' '.repeat(8_100) + '\nend</pre>'
  expect(() => splitMessage(html)).toThrow('Preformatted whitespace requires a document')
})

test('790 preformatted words followed by 5000 spaces fit in Telegram text parts', () => {
  const words = Array(790).fill('word').join(' ')
  expectSafeParts('<pre>' + words + ' '.repeat(5000) + '</pre>', 4000)
})

test('receipt recovery cuts the original HTML before applying new configured redactions', () => {
  const changed = 'new&value'
  const crossing = 'cross&boundary'
  const html = '<b>' + escapeHtml(changed) + 'б'.repeat(3978) + escapeHtml(crossing) +
    ' keep this ' + escapeHtml(changed) + '</b>'
  const originalCut = splitMessageLegacy(html).ends[0]!
  const secrets = [changed, crossing]
  expect(originalCut).toBeGreaterThan(html.indexOf('cross'))
  expect(originalCut).toBeLessThan(html.indexOf('boundary'))
  const resumed = splitMessageFrom(html, originalCut, 4000, {
    redact: body => redactOutboundText(body, 'HTML', secrets), secrets,
  })
  expect(resumed).toEqual(['<b> keep this [REDACTED]</b>'])
})

test('the old saved plan preserves the receipt boundary and masks a secret across reopened tags', () => {
  const secret = 'cross&boundary'
  const chunks = ['<b>already sent cross&amp;</b>', '<b>boundary keep</b>']
  const pending = resumeMessagePlan(chunks, 1, {
    secrets: [secret], redact: html => redactOutboundText(html, 'HTML', [secret]),
  })
  expect(pending).toEqual(['<b> keep</b>'])
})

test('plain fallback keeps every expanded URL when the labels already fill a Telegram message', () => {
  const url = 'https://example.com/runbook?a=1&b=2'
  const html = 'x'.repeat(4050) + '<a href="' + escapeHtml(url) + '">read this</a>'
  const parts = splitPlainFallback(html)
  expect(parts.length).toBe(2)
  expect(parts.every(part => part.length <= 4096)).toBe(true)
  expect(parts.join('')).toBe('x'.repeat(4050) + 'read this (' + url + ')')
  expect(parts[1]).toContain(url)
})
