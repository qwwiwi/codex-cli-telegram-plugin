// O1-14: restrict calls to the owner sinks and the owner origin constructors.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dir, '..', '..', 'src')

// Allowed places per raw call. `conversation-export.ts` only renders history: a file marker becomes a
// placeholder line there and nothing is sent.
const sinks: Array<{ call: RegExp; allowed: readonly string[] }> = [
  { call: /\.\s*recordQuestion\s*\(/gu, allowed: ['codex/lease.ts', 'codex/owner-effects.ts'] },
  { call: /\.\s*setPendingOwnerTask\s*\(/gu, allowed: ['codex/owner-effects.ts'] },
  { call: /\bextractAttachments\s*\(/gu, allowed: ['codex/attachments.ts', 'codex/owner-effects.ts', 'codex/conversation-export.ts'] },
  { call: /\.\s*openQuestions\s*\(/gu, allowed: ['codex/brain-bridge.ts', 'codex/owner-effects.ts'] },
  { call: /\bsessions\s*\.\s*register\s*\(/gu, allowed: ['codex/brain-bridge.ts'] },
  { call: /\bmainOrigin\s*\(/gu, allowed: ['codex/turn-origin.ts', 'codex/server.ts', 'codex/questions.ts'] },
  { call: /\blegacyOwnerOrigin\s*\(/gu, allowed: ['codex/turn-origin.ts', 'codex/inbox.ts'] },
]

function* sourceFiles(parent = ''): Generator<string> {
  for (const entry of readdirSync(join(dir, parent), { withFileTypes: true })) {
    const name = parent ? parent + '/' + entry.name : entry.name
    if (entry.isDirectory()) yield* sourceFiles(name)
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(name)) yield name
  }
}

function ownerSinkViolations(name: string, source: string): string[] {
  const found: string[] = []
  for (const { call, allowed } of sinks) {
    if (allowed.includes(name)) continue
    for (const match of source.matchAll(call)) {
      const line = source.slice(0, match.index).split('\n').length
      found.push(name + ':' + line + ' ' + match[0].replace(/\s+/gu, ' '))
    }
  }
  return found
}

test('the census detects multiline owner sinks on any receiver and owner origin constructors', () => {
  const source = [
    'leases', '  .recordQuestion(1, prompt)',
    'registry . recordQuestion', '  (2, secondPrompt)',
    'other', '  .openQuestions', '  (thread, prompts)',
    'mainOrigin', '  (thread)',
    'legacyOwnerOrigin', '  (1)',
  ].join('\n')
  const file = 'safety/nested/example.ts'
  expect(ownerSinkViolations(file, source)).toEqual([
    file + ':2 .recordQuestion(',
    file + ':3 . recordQuestion (',
    file + ':6 .openQuestions (',
    file + ':8 mainOrigin (',
    file + ':10 legacyOwnerOrigin (',
  ])
})

test('O1-14 owner sinks are called only from owner-effects.ts and roles are written only by registerThread', () => {
  const found: string[] = []
  for (const name of sourceFiles()) {
    found.push(...ownerSinkViolations(name, readFileSync(join(dir, name), 'utf8')))
  }
  expect(found).toEqual([])
  // Inside the bridge the one registry write lives in registerThread.
  const bridge = readFileSync(join(dir, 'codex', 'brain-bridge.ts'), 'utf8')
  const write = /\bsessions\s*\.\s*register\s*\(/gu
  expect([...bridge.matchAll(write)]).toHaveLength(1)
  const body = /async function registerThread\([\s\S]*?\n  \}/u.exec(bridge)?.[0] ?? ''
  expect([...body.matchAll(write)]).toHaveLength(1)
})
