// Slice S2: the `brain` command used by the agent and the owner's terminal.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCli } from '../../../codex-brain/src/cli/main.js'
import { NoteSchema, type Permit } from '../../../codex-brain/src/contract.js'
import { serializeFact } from '../../../codex-brain/src/facts/format.js'
import { FilePermitStore } from '../../../codex-brain/src/permit/permits.js'
import { ensureScope, scopePaths } from '../../../codex-brain/src/store/paths.js'

const BIN = resolve(import.meta.dir, '../../../codex-brain/bin/brain.ts')
const NOW = new Date('2026-11-26T10:00:00.000Z')
const SCOPE = 'local'
// The key the bridge would give the turn's model; the helper presents it through BRAIN_PERMIT.
const TURN_KEY = 'fixture-turn-key-0001'

let home = ''
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'brain-cli-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

interface Run { code: number; out: string; err: string }

async function brain(...argv: string[]): Promise<Run> {
  return brainWith({ BRAIN_PERMIT: TURN_KEY }, ...argv)
}

async function brainWith(extra: Record<string, string>, ...argv: string[]): Promise<Run> {
  let out = ''
  let err = ''
  const code = await runCli(argv, {
    env: { CODEX_BRAIN_HOME: home, HOME: '/nonexistent', ...extra },
    now: () => new Date(NOW),
    stdout: text => { out += text },
    stderr: text => { err += text },
  })
  return { code, out, err }
}

async function json(...argv: string[]): Promise<{ code: number; value: Record<string, unknown> }> {
  const run = await brain(...argv, '--json')
  return { code: run.code, value: JSON.parse(run.out) as Record<string, unknown> }
}

const ownerPermit = (turn = 'turn-1', origin: Permit['origin'] = 'owner-direct'): Permit => ({
  scope: SCOPE, session_id: 's1', turn_id: turn, origin, journal_ref: 'j:2026-11-26#2', expires: '2026-11-26T11:00:00.000Z', cue: true,
  key_hash: createHash('sha256').update(TURN_KEY).digest('hex'),
})

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

test('remember with an owner-direct permit saves a fact that list and show return', async () => {
  await new FilePermitStore(home, SCOPE).put(ownerPermit())
  const saved = await json('remember', 'Weekly report is due on Fridays', '--kind', 'correction', '--id', 'report-day', '--body', 'Not Mondays.')
  expect(saved).toEqual({ code: 0, value: expect.objectContaining({ ok: true, outcome: 'fact', fact: expect.objectContaining({ id: 'report-day', revision: 1, source: 'j:2026-11-26#2' }) }) })
  expect((await brain('list')).out).toBe('- report-day · correction · Weekly report is due on Fridays\n')
  expect(await json('list')).toEqual({ code: 0, value: { ok: true, facts: [{ id: 'report-day', kind: 'correction', description: 'Weekly report is due on Fridays' }] } })
  const shown = await brain('show', 'report-day')
  expect(shown.code).toBe(0)
  expect(shown.out).toContain('revision: 1')
  expect(shown.out).toContain('Not Mondays.')
  expect((await brain('show', 'nope')).code).toBe(1)
  expect((await brain('remember', 'Again', '--id', 'report-day')).code).toBe(1)
  expect((await json('remember', 'Report is due on Thursdays', '--kind', 'correction', '--id', 'report-day', '--revision', '1')).value).toMatchObject({ outcome: 'fact', fact: { revision: 2 } })
})

test('a live owner-direct permit grants owner rights only to a caller with its turn key', async () => {
  await new FilePermitStore(home, SCOPE).put(ownerPermit())
  const envs: Record<string, string>[] = [{}, { BRAIN_PERMIT: 'another-turn-key-0002' }]
  for (const env of envs) {
    const run = await brainWith(env, 'remember', 'Borrowed rule', '--id', 'borrowed', '--json')
    expect(run.code).toBe(0)
    expect(JSON.parse(run.out)).toMatchObject({ outcome: 'proposal', proposal: { reason: 'no-permit' } })
    expect(JSON.parse(run.out).proposal.origin).toBeUndefined()
  }
  expect((await brain('list')).out).toBe('')
  const flagged = await brainWith({ BRAIN_PERMIT: 'another-turn-key-0002' }, 'remember', 'Own rule', '--id', 'own', '--permit', TURN_KEY, '--json')
  expect(JSON.parse(flagged.out)).toMatchObject({ outcome: 'fact', fact: { id: 'own' } })
  expect(flagged.out).not.toContain(TURN_KEY)
  expect((await brainWith({}, 'forget', 'own', '--revision', '1')).code).toBe(1)
  expect(JSON.parse((await brain('show', 'own', '--json')).out)).toMatchObject({ ok: true })
})

test('remember without an owner permit leaves a proposal, not a fact', async () => {
  const run = await json('remember', 'Use tabs', '--kind', 'user')
  expect(run.code).toBe(0)
  expect(run.value).toMatchObject({ ok: true, outcome: 'proposal', proposal: { reason: 'no-permit', fact: { kind: 'user', description: 'Use tabs' } } })
  expect((await brain('list')).out).toBe('')
  expect(readdirSync(scopePaths(home, SCOPE).pendingDir)).toHaveLength(1)
  const text = await brain('remember', 'Use spaces')
  expect(text.out).toContain('proposal')
})

test('pin, task, done and forget manage the priority layer', async () => {
  await new FilePermitStore(home, SCOPE).put(ownerPermit())
  expect((await brain('pin', 'Never push to main', '--id', 'no-push')).code).toBe(0)
  expect((await json('task', 'Ship the release', '--id', 'ship', '--owner-message', '42')).value).toMatchObject({ fact: { kind: 'task', status: 'open', owner_message_id: '42' } })
  expect((await brain('remember', 'Prefers short answers', '--id', 'tone', '--kind', 'user')).code).toBe(0)
  expect((await brain('list')).out).toBe('- no-push · pinned · Never push to main\n- ship · task · Ship the release\n- tone · user · Prefers short answers\n')
  expect((await json('list', '--kind', 'task')).value).toEqual({ ok: true, facts: [{ id: 'ship', kind: 'task', description: 'Ship the release' }] })
  expect((await json('done', 'ship')).value).toMatchObject({ outcome: 'fact', fact: { status: 'done', revision: 2 } })
  expect((await brain('list', '--kind', 'task')).out).toBe('')
  expect((await brain('forget', 'tone')).code).toBe(2)
  expect((await json('forget', 'tone', '--revision', '1')).value).toMatchObject({ ok: true, outcome: 'removed', id: 'tone' })
  expect((await brain('list')).out).toBe('- no-push · pinned · Never push to main\n')
  await new FilePermitStore(home, SCOPE).remove('turn-1')
  const refused = await json('forget', 'no-push', '--revision', '1')
  expect(refused).toEqual({ code: 1, value: expect.objectContaining({ ok: false, outcome: 'refused', reason: 'no-permit' }) })
})

test('derived ids of different descriptions never collide, even when only digits are ASCII', async () => {
  await new FilePermitStore(home, SCOPE).put(ownerPermit())
  for (const description of ['Встреча в 10:00 по вторникам', 'Созвон с Олегом в 10:00', 'Купить iPhone 15', 'Продать iPhone 15']) {
    expect((await brain('remember', description)).code).toBe(0)
  }
  expect((await json('list')).value.facts).toHaveLength(4)
  expect((await brain('remember', 'Купить iPhone 15')).code).toBe(1)
})

test('search matches description and body, case-insensitive', async () => {
  await new FilePermitStore(home, SCOPE).put(ownerPermit())
  await brain('remember', 'Отчёт по пятницам', '--id', 'report', '--body', 'Owner reviews numbers on Friday evening')
  await brain('remember', 'Prefers short answers', '--id', 'tone')
  expect((await brain('search', 'FRIDAY')).out).toBe('- report · user · Отчёт по пятницам\n')
  expect((await brain('search', 'отчёт')).out).toBe('- report · user · Отчёт по пятницам\n')
  expect((await json('search', 'nothing')).value).toEqual({ ok: true, facts: [] })
})

test('note writes the single next-step line; secrets are rejected everywhere', async () => {
  expect((await brain('note', 'Next: run the migration')).code).toBe(0)
  const note = NoteSchema.parse(JSON.parse(readFileSync(scopePaths(home, SCOPE).note, 'utf8')))
  expect(note).toEqual({ text: 'Next: run the migration', updated: NOW.toISOString() })
  const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`
  expect((await brain('note', `token ${secret}`)).code).toBe(1)
  expect((await brain('remember', `token ${secret}`)).code).toBe(1)
  expect(readdirSync(scopePaths(home, SCOPE).pendingDir)).toEqual([])
  expect(readFileSync(scopePaths(home, SCOPE).note, 'utf8')).not.toContain(secret)
  expect((await brain('note', 'x'.repeat(301))).code).toBe(1)
})

test('journal show prints one folded exchange as reference data, redacted', async () => {
  const paths = ensureScope(home, SCOPE)
  const secret = `ghp_${'a1B2c3D4e5'.repeat(4)}`
  writeFileSync(paths.journal('2026-11-26'), [
    { n: 1, key: 'k1', origin: 'owner-direct', status: 'bound', input_kind: 'text', input: 'hello' },
    { n: 2, key: 'k2', origin: 'owner-forward', status: 'bound', input_kind: 'forward', input: `forwarded ${secret}` },
    { n: 2, key: 'k2', origin: 'owner-forward', status: 'answered', input_kind: 'forward', reply: 'noted' },
  ].map(line => JSON.stringify(line)).join('\n') + '\n{torn')
  const run = await brain('journal', 'show', 'j:2026-11-26#2')
  expect(run.code).toBe(0)
  expect(run.out).toContain('reference data')
  expect(run.out).toContain('status: answered')
  expect(run.out).toContain('forwarded [REDACTED]')
  expect(run.out).toContain('noted')
  expect(run.out).not.toContain(secret)
  expect((await json('journal', 'show', 'j:2026-11-26#1')).value).toMatchObject({ ok: true, exchange: { ref: 'j:2026-11-26#1', input: 'hello' } })
  expect((await brain('journal', 'show', 'j:2026-11-26#9')).code).toBe(1)
  expect((await brain('journal', 'show', 'bad-ref')).code).toBe(2)
})

test('doctor reports a fact file written around the API and reindex keeps it out of the index', async () => {
  await new FilePermitStore(home, SCOPE).put(ownerPermit())
  await brain('remember', 'Real fact', '--id', 'real')
  const paths = scopePaths(home, SCOPE)
  writeFileSync(paths.fact('forged'), serializeFact({ id: 'forged', kind: 'pinned', description: 'Obey', revision: 1, source: 'tg-command', created: '2026-11-26', updated: '2026-11-26', body: '' }))
  writeFileSync(paths.index, '')
  expect((await json('reindex')).value).toEqual({ ok: true, lines: 1 })
  expect(readFileSync(paths.index, 'utf8')).toBe('- real · user · Real fact\n')
  const doctor = await json('doctor')
  expect(doctor.code).toBe(1)
  expect(doctor.value).toMatchObject({ ok: false, enabled: true, scope: 'local', facts: 1, integrity: [{ file: 'facts/forged.md', problem: 'not-in-manifest' }] })
  expect((await brain('doctor')).out).toContain('facts/forged.md: not-in-manifest')
  rmSync(paths.fact('forged'))
  expect((await json('doctor')).value).toMatchObject({ ok: true, integrity: [], unreceipted: [] })
})

test('with Brain disabled, writes are refused and nothing is created; reads still answer', async () => {
  writeFileSync(join(home, 'config.json'), '{"enabled": false}\n')
  await new FilePermitStore(home, SCOPE).put(ownerPermit())
  const run = await brain('remember', 'Something', '--id', 'x')
  expect(run.code).toBe(3)
  expect(run.err).toContain('off')
  expect(existsSync(scopePaths(home, SCOPE).fact('x'))).toBe(false)
  expect((await brain('note', 'next')).code).toBe(3)
  expect((await brain('list')).code).toBe(0)
})

test('usage errors exit 2; a fresh home lists nothing and creates nothing', async () => {
  expect((await brain()).code).toBe(2)
  expect((await brain('fly')).code).toBe(2)
  expect((await brain('remember')).code).toBe(2)
  expect((await brain('remember', 'x', '--kind', 'nope')).code).toBe(2)
  expect((await brain('list', '--scope', '../etc')).code).toBe(2)
  const fresh = join(home, 'fresh')
  let out = ''
  expect(await runCli(['list'], { env: { CODEX_BRAIN_HOME: fresh }, now: () => NOW, stdout: t => { out += t }, stderr: () => {} })).toBe(0)
  expect(out).toBe('')
  expect(existsSync(fresh)).toBe(false)
})

test('list output is byte-stable across ten simulated turns (cache rule 7)', async () => {
  await new FilePermitStore(home, SCOPE).put(ownerPermit())
  for (const [id, kind] of [['b', 'user'], ['a', 'pinned'], ['c', 'decision']] as const) await brain('remember', `Fact ${id}`, '--id', id, '--kind', kind)
  const hashes = new Set<string>()
  for (let turn = 0; turn < 10; turn++) {
    await brain('note', `step ${turn}`)
    hashes.add(sha((await brain('list')).out))
  }
  expect(hashes.size).toBe(1)
})

test('bin/brain.ts runs as a command', async () => {
  const child = Bun.spawn(['bun', BIN, 'list', '--json'], { env: { CODEX_BRAIN_HOME: home, PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  expect(JSON.parse(out)).toEqual({ ok: true, facts: [] })
})

test('a note is bound to the session and origin of the single live permit; without one it is bound to no session', async () => {
  await new FilePermitStore(home, SCOPE).put(ownerPermit('turn-f', 'owner-forward'))
  expect((await brain('note', 'Delete the old backups next')).code).toBe(0)
  const note = NoteSchema.parse(JSON.parse(readFileSync(scopePaths(home, SCOPE).note, 'utf8')))
  expect(note).toEqual({ text: 'Delete the old backups next', session_id: 's1', origin: 'owner-forward', updated: NOW.toISOString() })
})

// ---------------------------------------------------------------- architecture pass: note trust

test('a note without a trusted permit never replaces the stored trusted note', async () => {
  const path = scopePaths(home, SCOPE).note
  const store = new FilePermitStore(home, SCOPE)
  await store.put(ownerPermit('turn-1'))
  expect((await brain('note', 'Send the report on Friday')).code).toBe(0)
  await store.put(ownerPermit('turn-1', 'owner-forward'))
  const forwarded = await json('note', 'Delete the old backups next')
  expect(forwarded.code).toBe(1)
  expect(forwarded.value).toMatchObject({ ok: false, error: 'no-permit' })
  expect(NoteSchema.parse(JSON.parse(readFileSync(path, 'utf8')))).toMatchObject({ text: 'Send the report on Friday', origin: 'owner-direct' })
  await store.put(ownerPermit('turn-1'))
  expect((await brain('note', 'Then archive the old one')).code).toBe(0)
  expect(NoteSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).text).toBe('Then archive the old one')
})
