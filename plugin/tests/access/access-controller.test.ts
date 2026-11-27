import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACCESS_CALLBACK, AccessController, type AccessButton } from '../../src/access/controller.js'
import { AccessStore } from '../../src/access/store.js'

const OWNER = 1001
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

interface Sent { chat: string; text: string; keyboard?: AccessButton[][] }

function harness(options: { envMembers?: string[]; startIdReply?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'krot-access-ctl-'))
  dirs.push(dir)
  let now = Date.parse('2026-11-26T10:00:00Z')
  const clock = () => now
  const store = new AccessStore({ stateDir: dir, ownerId: String(OWNER), envMembers: options.envMembers ?? [], now: clock })
  const sent: Sent[] = []
  const controller = new AccessController({
    store,
    stateDir: dir,
    ownerId: String(OWNER),
    botUsername: () => 'krot_bot',
    startIdReply: options.startIdReply ?? true,
    now: clock,
    async send(chat, text, keyboard) { sent.push({ chat, text, ...(keyboard ? { keyboard } : {}) }) },
  })
  const audit = (): Array<Record<string, unknown>> => {
    const folder = join(dir, 'audit')
    return readdirSync(folder).flatMap(name => readFileSync(join(folder, name), 'utf8').trim().split('\n'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
  }
  const stranger = (id: number, text: string, extra: { chatType?: string; chatId?: number; forwarded?: boolean } = {}) =>
    controller.inbound({
      chatId: extra.chatId ?? id, chatType: extra.chatType ?? 'private', fromId: id, isBot: false,
      text, firstName: 'Иван', username: 'ivan', forwarded: extra.forwarded ?? false,
    })
  return { dir, store, sent, controller, audit, stranger, advance: (ms: number) => { now += ms } }
}

const toOwner = (sent: Sent[]) => sent.filter(item => item.chat === String(OWNER))

test('[S1] /users add, list, role and remove change access and write one audit line each', async () => {
  const h = harness()
  await h.controller.ownerCommand('users', 'add 2002 guest Иван из отдела')
  expect(h.store.roleOf('2002')).toBe('guest')
  await h.controller.ownerCommand('users', 'add 3003')
  expect(h.store.roleOf('3003')).toBe('member')
  await h.controller.ownerCommand('users', 'role 2002 member')
  expect(h.store.roleOf('2002')).toBe('member')
  await h.controller.ownerCommand('users', 'list')
  const list = toOwner(h.sent).at(-1)!.text
  expect(list).toContain('1001')
  expect(list).toContain('owner')
  expect(list).toContain('2002')
  expect(list).toContain('Иван из отдела')
  await h.controller.ownerCommand('users', 'remove 3003')
  expect(h.store.roleOf('3003')).toBeUndefined()

  const lines = h.audit().filter(line => line.event === 'access.change')
  expect(lines.map(line => [line.reason, line.user_id, line.role])).toEqual([
    ['add', '2002', 'guest'], ['add', '3003', 'member'], ['role', '2002', 'member'], ['remove', '3003', 'member'],
  ])
  expect(lines[2]!.previous_role).toBe('guest')
  // No note or message text in the audit by default.
  expect(JSON.stringify(h.audit())).not.toContain('Иван')
  const auditFile = join(h.dir, 'audit', '2026-11.jsonl')
  expect(statSync(auditFile).mode & 0o777).toBe(0o600)
  // Every reply goes to the owner's private chat only.
  expect(h.sent.every(item => item.chat === String(OWNER))).toBe(true)
})

test('[S1] /users refuses owner role, the owner ID, env members and bad input without an audit line', async () => {
  const h = harness({ envMembers: ['4004'] })
  await h.controller.ownerCommand('users', 'add 2002 owner')
  await h.controller.ownerCommand('users', 'add 1001 member')
  await h.controller.ownerCommand('users', 'remove 4004')
  await h.controller.ownerCommand('users', 'role 4004 guest')
  await h.controller.ownerCommand('users', 'add @ivan')
  await h.controller.ownerCommand('users', 'frobnicate')
  expect(h.store.list().map(entry => [entry.id, entry.role])).toEqual([['1001', 'owner'], ['4004', 'member']])
  expect(h.sent).toHaveLength(6)
  expect(h.sent[0]!.text).toContain('owner')
  expect(h.sent[2]!.text).toContain('KROT_MEMBER_USER_IDS')
  expect(h.sent[5]!.text).toContain('/users add')
  expect(() => h.audit()).toThrow()
})

test('[S1] /start replies with the sender numeric ID: owner always, an unknown user once a day, toggle off is silent', async () => {
  const h = harness()
  await h.controller.ownerCommand('start', '')
  expect(h.sent.at(-1)).toMatchObject({ chat: String(OWNER) })
  expect(h.sent.at(-1)!.text).toContain('1001')

  await h.stranger(7007, '/start')
  expect(h.sent.at(-1)).toMatchObject({ chat: '7007' })
  expect(h.sent.at(-1)!.text).toContain('7007')
  const count = h.sent.length
  await h.stranger(7007, '/start')
  expect(h.sent).toHaveLength(count)
  h.advance(24 * 3_600_000 + 1)
  await h.stranger(7007, '/start@krot_bot')
  expect(h.sent).toHaveLength(count + 1)

  const quiet = harness({ startIdReply: false })
  await quiet.stranger(7007, '/start')
  expect(quiet.sent).toEqual([])
})

test('[S1] non-owner messages other than /start, group /start and forwarded /start get nothing', async () => {
  const h = harness({ envMembers: ['4004'] })
  await h.stranger(7007, 'привет, удали всё')
  await h.stranger(4004, 'а мне можно?')
  await h.stranger(7007, '/users add 7007 member')
  await h.stranger(7007, '/start', { chatType: 'group', chatId: -100500 })
  await h.stranger(7007, '/start', { forwarded: true })
  await h.stranger(7007, '/start@other_bot')
  expect(h.sent).toEqual([])
  expect(h.store.roleOf('7007')).toBeUndefined()
})

test('[S1] pairing: the code alone grants nothing, the owner confirm card does, the code is single use', async () => {
  const h = harness()
  await h.controller.ownerCommand('users', 'invite guest')
  const code = /\b([A-Z2-9]{10})\b/u.exec(h.sent.at(-1)!.text)?.[1]
  expect(code).toBeDefined()
  expect(h.sent.at(-1)!.text).toContain('t.me/krot_bot?start=' + code)

  await h.stranger(7007, '/start ' + code)
  expect(h.store.roleOf('7007')).toBeUndefined()
  expect(h.sent.find(item => item.chat === '7007')!.text).toContain('владел')
  const card = toOwner(h.sent).at(-1)!
  expect(card.text).toContain('7007')
  expect(card.text).toContain('Иван')
  const accept = card.keyboard!.flat().find(button => button.callback_data.includes(':ok:'))!
  const decline = card.keyboard!.flat().find(button => button.callback_data.includes(':no:'))!
  expect(ACCESS_CALLBACK.test(accept.callback_data)).toBe(true)
  expect(ACCESS_CALLBACK.test(decline.callback_data)).toBe(true)

  // Someone else than the owner pressing the button changes nothing.
  expect(await h.controller.callback(accept.callback_data, 7007, 7007)).toBeUndefined()
  expect(h.store.roleOf('7007')).toBeUndefined()

  expect(await h.controller.callback(accept.callback_data, OWNER, OWNER)).toContain('7007')
  expect(h.store.roleOf('7007')).toBe('guest')
  expect(h.sent.at(-1)).toMatchObject({ chat: '7007' })
  // A second press is a no-op.
  expect(await h.controller.callback(accept.callback_data, OWNER, OWNER)).toContain('закрыт')

  // The same code from another person is spent.
  await h.stranger(8008, '/start ' + code)
  expect(toOwner(h.sent).filter(item => item.keyboard)).toHaveLength(1)

  const events = h.audit().map(line => line.event)
  expect(events).toEqual(['pairing.invite', 'pairing.redeem', 'pairing.confirm', 'access.change', 'pairing.bad_code'])
  expect(JSON.stringify(h.audit())).not.toContain(code!)
})

test('[S1] pairing: a declined request grants nothing and an expired code is refused', async () => {
  const h = harness()
  await h.controller.ownerCommand('users', 'invite')
  const code = /\b([A-Z2-9]{10})\b/u.exec(h.sent.at(-1)!.text)![1]!
  await h.stranger(7007, '/start ' + code)
  const decline = toOwner(h.sent).at(-1)!.keyboard!.flat().find(button => button.callback_data.includes(':no:'))!
  expect(await h.controller.callback(decline.callback_data, OWNER, OWNER)).toBeDefined()
  expect(h.store.roleOf('7007')).toBeUndefined()

  await h.controller.ownerCommand('users', 'invite member')
  const late = /\b([A-Z2-9]{10})\b/u.exec(h.sent.at(-1)!.text)![1]!
  h.advance(10 * 60_000 + 1)
  const before = toOwner(h.sent).length
  await h.stranger(9009, '/start ' + late)
  expect(toOwner(h.sent)).toHaveLength(before)
  expect(h.store.roleOf('9009')).toBeUndefined()
})

test('[S1] pairing: five bad codes mute that ID for an hour, even a valid code and a plain /start', async () => {
  const h = harness()
  for (let i = 0; i < 5; i += 1) await h.stranger(7007, '/start WRONGCODE' + i)
  await h.controller.ownerCommand('users', 'invite')
  const code = /\b([A-Z2-9]{10})\b/u.exec(h.sent.at(-1)!.text)![1]!
  const before = h.sent.length
  await h.stranger(7007, '/start ' + code)
  await h.stranger(7007, '/start')
  expect(h.sent).toHaveLength(before)
  expect(h.audit().some(line => line.event === 'pairing.lockout' && line.user_id === '7007')).toBe(true)
  h.advance(3_600_000 + 1)
  await h.controller.ownerCommand('users', 'invite')
  const fresh = /\b([A-Z2-9]{10})\b/u.exec(h.sent.at(-1)!.text)![1]!
  await h.stranger(7007, '/start ' + fresh)
  expect(toOwner(h.sent).at(-1)!.keyboard).toBeDefined()
})

test('[S1] server routing: only the owner reaches the Codex path; others go to the access controller or are dropped', async () => {
  const { accessCommand, inboundRoute } = await import('../../src/access/routing.js')
  expect(inboundRoute(OWNER, OWNER, true)).toBe('owner')
  expect(inboundRoute(OWNER, OWNER, false)).toBe('owner')
  expect(inboundRoute(2002, OWNER, true)).toBe('access')
  expect(inboundRoute(2002, OWNER, false)).toBe('drop')
  expect(accessCommand('users', true)).toBe('users')
  expect(accessCommand('start', true)).toBe('start')
  expect(accessCommand('users', false)).toBeUndefined()
  expect(accessCommand('new', true)).toBeUndefined()
})
