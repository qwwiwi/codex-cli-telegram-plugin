import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessStore } from '../../src/access/store.js'
import { accessSettings, assertSingleOwnerEnv } from '../../src/access/env.js'

const dirs: string[] = []
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-access-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const OWNER = '1001'
const warnings: string[] = []
function store(dir: string, envMembers: readonly string[] = []): AccessStore {
  return new AccessStore({ stateDir: dir, ownerId: OWNER, envMembers, warn: message => warnings.push(message) })
}

test('[S1] a missing access.json means owner only: the existing single-owner install keeps working unchanged', () => {
  const dir = stateDir()
  const access = store(dir)
  expect(access.roleOf(OWNER)).toBe('owner')
  expect(access.roleOf('2002')).toBeUndefined()
  expect(access.list().map(entry => entry.id)).toEqual([OWNER])
  // Reading never creates the file.
  expect(existsSync(join(dir, 'access.json'))).toBe(false)
})

test('[S1] adds are unlimited, survive a reload and are written atomically with mode 0600', () => {
  const dir = stateDir()
  const access = store(dir)
  for (let i = 0; i < 300; i += 1) expect(access.add(String(5000 + i), 'member', 'chat').ok).toBe(true)
  expect(access.add('9009', 'guest', 'chat', 'Иван\u0007 '.repeat(20)).ok).toBe(true)
  const file = join(dir, 'access.json')
  expect(statSync(file).mode & 0o777).toBe(0o600)
  // No temp file is left next to the state file.
  expect(readdirSync(dir).filter(name => name.includes('.tmp'))).toEqual([])
  const reloaded = store(dir)
  expect(reloaded.roleOf('5299')).toBe('member')
  expect(reloaded.roleOf('9009')).toBe('guest')
  const note = reloaded.list().find(entry => entry.id === '9009')?.note ?? ''
  expect(note.length).toBeLessThanOrEqual(64)
  expect(/\p{Cc}/u.test(note)).toBe(false)
  expect(reloaded.list()).toHaveLength(302)
})

test('[S1] the state file can never hold an owner: role owner, owner ID and bad IDs are refused', () => {
  const dir = stateDir()
  const access = store(dir)
  expect(access.add(OWNER, 'member', 'chat')).toEqual({ ok: false, reason: 'owner' })
  expect(access.add('-100123', 'member', 'chat')).toEqual({ ok: false, reason: 'bad_id' })
  expect(access.add('0', 'member', 'chat')).toEqual({ ok: false, reason: 'bad_id' })
  expect(access.add('12a', 'member', 'chat')).toEqual({ ok: false, reason: 'bad_id' })
  // A hand-edited file that grants role owner fails closed to owner only.
  writeFileSync(join(dir, 'access.json'), JSON.stringify({
    version: 1, users: { '2002': { role: 'owner', added_at: '2026-11-26T10:00:00Z', added_by: 'chat' } },
  }), { mode: 0o600 })
  const tampered = store(dir)
  expect(tampered.roleOf('2002')).toBeUndefined()
  expect(tampered.roleOf(OWNER)).toBe('owner')
  expect(tampered.degraded).toBe(true)
})

test('[S1] a corrupt access.json fails closed to owner only and is never overwritten', () => {
  const dir = stateDir()
  const file = join(dir, 'access.json')
  writeFileSync(file, '{"version":1,"users":{"2002":', { mode: 0o600 })
  warnings.length = 0
  const access = store(dir)
  expect(access.roleOf('2002')).toBeUndefined()
  expect(access.roleOf(OWNER)).toBe('owner')
  expect(access.degraded).toBe(true)
  expect(warnings.length).toBeGreaterThan(0)
  expect(access.add('3003', 'member', 'chat')).toEqual({ ok: false, reason: 'degraded' })
  expect(readFileSync(file, 'utf8')).toBe('{"version":1,"users":{"2002":')
})

test('[S1] env members (KROT_MEMBER_USER_IDS) are members that cannot be removed or re-roled from chat', () => {
  const dir = stateDir()
  const access = store(dir, ['4004'])
  expect(access.roleOf('4004')).toBe('member')
  expect(access.remove('4004')).toEqual({ ok: false, reason: 'env' })
  expect(access.setRole('4004', 'guest')).toEqual({ ok: false, reason: 'env' })
  expect(access.add('4004', 'guest', 'chat')).toEqual({ ok: false, reason: 'env' })
  expect(access.list().find(entry => entry.id === '4004')?.source).toBe('env')
})

test('[S1] remove and role change apply to state users and report unknown IDs', () => {
  const dir = stateDir()
  const access = store(dir)
  access.add('2002', 'member', 'chat')
  expect(access.setRole('2002', 'guest')).toEqual({ ok: true, previous: 'member' })
  expect(store(dir).roleOf('2002')).toBe('guest')
  expect(access.add('2002', 'member', 'chat')).toEqual({ ok: false, reason: 'exists' })
  expect(access.remove('2002')).toEqual({ ok: true, previous: 'guest' })
  expect(store(dir).roleOf('2002')).toBeUndefined()
  expect(access.remove('2002')).toEqual({ ok: false, reason: 'unknown' })
  expect(access.setRole('2002', 'member')).toEqual({ ok: false, reason: 'unknown' })
  expect(access.remove(OWNER)).toEqual({ ok: false, reason: 'owner' })
})

test('[S1] keys owned by later slices (chats, guest_mode) survive a write', () => {
  const dir = stateDir()
  const file = join(dir, 'access.json')
  writeFileSync(file, JSON.stringify({
    version: 1, users: {}, chats: { '-1001234': { mode: 'members' } }, guest_mode: { enabled: false, audience: 'allowlist' },
  }), { mode: 0o600 })
  store(dir).add('2002', 'member', 'chat')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  expect(saved.chats).toEqual({ '-1001234': { mode: 'members' } })
  expect(saved.guest_mode).toEqual({ enabled: false, audience: 'allowlist' })
})

test('[S1] invites: single use, expire after 10 minutes, stored only as a SHA-256 hash, >=40 bits', () => {
  const dir = stateDir()
  let now = Date.parse('2026-11-26T10:00:00Z')
  const access = new AccessStore({ stateDir: dir, ownerId: OWNER, envMembers: [], now: () => now })
  const code = access.createInvite('guest')
  expect(code).toMatch(/^[A-Z2-9]{10}$/)
  const saved = readFileSync(join(dir, 'access.json'), 'utf8')
  expect(saved.includes(code)).toBe(false)
  expect(access.redeemInvite(code.toLowerCase())).toBe('guest')
  expect(access.redeemInvite(code)).toBeUndefined()
  const late = access.createInvite('member')
  now += 10 * 60_000 + 1
  expect(access.redeemInvite(late)).toBeUndefined()
  expect(access.redeemInvite('')).toBeUndefined()
  // Redeeming a code grants nothing by itself.
  expect(access.list().map(entry => entry.id)).toEqual([OWNER])
})

test('[S1] env: with the flag off the public settings are ignored, so a stray value never blocks the single-owner start', () => {
  const off = { enabled: false, envMembers: [], startIdReply: true }
  expect(accessSettings({ KROT_START_ID_REPLY: 'maybe' })).toEqual(off)
  expect(accessSettings({ KROT_MEMBER_USER_IDS: '2002,-5' })).toEqual(off)
  expect(accessSettings({ KROT_MULTIUSER: '0', KROT_START_ID_REPLY: 'maybe', KROT_MEMBER_USER_IDS: 'abc' })).toEqual(off)
  // A valid member list is not activated by itself either.
  expect(accessSettings({ KROT_MEMBER_USER_IDS: '2002', KROT_START_ID_REPLY: 'off' })).toEqual(off)
})

test('[S1] env: flag off by default, member CSV is validated, the owner stays a single env ID', () => {
  expect(accessSettings({})).toEqual({ enabled: false, envMembers: [], startIdReply: true })
  expect(accessSettings({ KROT_MULTIUSER: '1', KROT_MEMBER_USER_IDS: ' 2002, 3003 ', KROT_START_ID_REPLY: 'off' }))
    .toEqual({ enabled: true, envMembers: ['2002', '3003'], startIdReply: false })
  expect(() => accessSettings({ KROT_MULTIUSER: 'yes' })).toThrow('KROT_MULTIUSER')
  expect(() => accessSettings({ KROT_MULTIUSER: '1', KROT_MEMBER_USER_IDS: '2002,-5' })).toThrow('KROT_MEMBER_USER_IDS')
  expect(() => accessSettings({ KROT_MULTIUSER: '1', KROT_START_ID_REPLY: 'maybe' })).toThrow('KROT_START_ID_REPLY')
  expect(() => assertSingleOwnerEnv([1001, 2002], true)).toThrow('KROT_MEMBER_USER_IDS')
  expect(() => assertSingleOwnerEnv([1001], true)).not.toThrow()
  // Flag off: the existing startup check keeps its own message.
  expect(() => assertSingleOwnerEnv([1001, 2002], false)).not.toThrow()
})

test('S4 R3: every saved access change is reported, so the public lane can drop work of a removed user', () => {
  const dir = stateDir()
  let changes = 0
  const access = new AccessStore({ stateDir: dir, ownerId: OWNER, envMembers: [], onChange: () => { changes++ } })
  expect(access.add('2002', 'member', OWNER).ok).toBe(true)
  expect(changes).toBe(1)
  expect(access.setRole('2002', 'guest').ok).toBe(true)
  expect(access.remove('2002').ok).toBe(true)
  expect(changes).toBe(3)
  // A refused change is not one.
  expect(access.remove('2002').ok).toBe(false)
  expect(changes).toBe(3)
})
