import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AccessButton } from '../../src/access/controller.js'
import { CHAT_CALLBACK, GroupController, type ChatMemberEvent } from '../../src/access/groups.js'
import { AccessStore } from '../../src/access/store.js'

const OWNER = 1001
const MEMBER = 2002
const STRANGER = 4004
const GROUP = -100777
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

interface Sent { chat: string; text: string; keyboard?: AccessButton[][] }

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'krot-access-groups-'))
  dirs.push(dir)
  let now = Date.parse('2026-11-26T10:00:00Z')
  const clock = () => now
  const store = new AccessStore({ stateDir: dir, ownerId: String(OWNER), envMembers: [String(MEMBER)], now: clock })
  const sent: Sent[] = []
  const left: string[] = []
  const groups = new GroupController({
    store, stateDir: dir, ownerId: String(OWNER), now: clock,
    async send(chat, text, keyboard) { sent.push({ chat, text, ...(keyboard ? { keyboard } : {}) }) },
    async leave(chat) { left.push(chat) },
  })
  const audit = (): Array<Record<string, unknown>> => {
    const folder = join(dir, 'audit')
    return readdirSync(folder).flatMap(name => readFileSync(join(folder, name), 'utf8').trim().split('\n'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
  }
  const event = (fromId: number, oldStatus: string, newStatus: string, extra: Partial<ChatMemberEvent> = {}): ChatMemberEvent => ({
    chatId: GROUP, chatType: 'supergroup', title: 'Команда', fromId, oldStatus, newStatus, ...extra,
  })
  return { dir, store, sent, left, groups, audit, event, advance: (ms: number) => { now += ms } }
}

const card = (sent: Sent[]) => sent.filter(item => item.chat === String(OWNER) && item.keyboard).at(-1)!

test('[S2] a group added by a listed user sends the owner a card; members mode approves it', async () => {
  const h = harness()
  await h.groups.memberUpdate(h.event(MEMBER, 'left', 'member'))
  expect(h.store.chat(String(GROUP))).toBeUndefined()
  const sentCard = card(h.sent)
  expect(sentCard.text).toContain(String(GROUP))
  expect(sentCard.text).toContain('Команда')
  expect(sentCard.text).toContain(String(MEMBER))
  const buttons = sentCard.keyboard!.flat().map(button => button.callback_data)
  expect(buttons).toEqual([
    'krot:chat:members:' + GROUP, 'krot:chat:open:' + GROUP, 'krot:chat:deny:' + GROUP,
  ])
  for (const data of buttons) expect(CHAT_CALLBACK.test(data)).toBe(true)
  // A press from anyone but the owner in the owner chat changes nothing.
  expect(await h.groups.callback(buttons[0]!, MEMBER, MEMBER)).toBeUndefined()
  expect(await h.groups.callback(buttons[0]!, OWNER, GROUP)).toBeUndefined()
  expect(h.store.chat(String(GROUP))).toBeUndefined()
  expect(await h.groups.callback(buttons[0]!, OWNER, OWNER)).toContain('Команда')
  expect(h.store.chat(String(GROUP))).toMatchObject({ mode: 'members', topics: 'per-topic', title: 'Команда' })
  expect(h.store.pendingChats()).toEqual([])
  // The card is single use.
  expect(await h.groups.callback(buttons[1]!, OWNER, OWNER)).toBe('Запрос уже закрыт.')
  expect(h.store.chat(String(GROUP))?.mode).toBe('members')
  expect(h.audit().map(line => line.event)).toEqual(['chat.pending', 'chat.approve'])
  expect(h.left).toEqual([])
  // Approval survives a restart.
  const reloaded = new AccessStore({ stateDir: h.dir, ownerId: String(OWNER), envMembers: [] })
  expect(reloaded.chat(String(GROUP))?.mode).toBe('members')
})

test('[S2] open and deny buttons', async () => {
  const h = harness()
  await h.groups.memberUpdate(h.event(OWNER, 'kicked', 'administrator'))
  await h.groups.callback('krot:chat:open:' + GROUP, OWNER, OWNER)
  expect(h.store.chat(String(GROUP))?.mode).toBe('open')

  const d = harness()
  await d.groups.memberUpdate(d.event(OWNER, 'left', 'member'))
  expect(await d.groups.callback('krot:chat:deny:' + GROUP, OWNER, OWNER)).toContain('Отклонено')
  expect(d.store.chat(String(GROUP))).toBeUndefined()
  expect(d.store.pendingChats()).toEqual([])
  expect(d.left).toEqual([String(GROUP)])
})

test('[S2] a group added by a stranger is left at once without a card', async () => {
  const h = harness()
  await h.groups.memberUpdate(h.event(STRANGER, 'left', 'member'))
  expect(h.left).toEqual([String(GROUP)])
  expect(h.sent).toEqual([])
  expect(h.store.pendingChats()).toEqual([])
  expect(h.audit()).toMatchObject([{ event: 'chat.leave', user_id: String(STRANGER), chat_id: String(GROUP), reason: 'unknown_adder' }])
})

test('[S2] channels are left and private member updates are ignored', async () => {
  const h = harness()
  await h.groups.memberUpdate(h.event(OWNER, 'left', 'administrator', { chatType: 'channel' }))
  expect(h.left).toEqual([String(GROUP)])
  await h.groups.memberUpdate(h.event(MEMBER, 'member', 'kicked', { chatType: 'private', chatId: MEMBER }))
  expect(h.left).toEqual([String(GROUP)])
  expect(h.sent).toEqual([])
})

test('[S2] my_chat_member removed or kicked drops the approval and tells the owner', async () => {
  const h = harness()
  await h.groups.memberUpdate(h.event(OWNER, 'left', 'member'))
  await h.groups.callback('krot:chat:members:' + GROUP, OWNER, OWNER)
  // A promotion inside the group is not a new join: no second card.
  const cards = h.sent.length
  await h.groups.memberUpdate(h.event(OWNER, 'member', 'administrator'))
  expect(h.sent.length).toBe(cards)
  await h.groups.memberUpdate(h.event(MEMBER, 'administrator', 'kicked'))
  expect(h.store.chat(String(GROUP))).toBeUndefined()
  expect(h.sent.at(-1)).toMatchObject({ chat: String(OWNER) })
  expect(h.sent.at(-1)!.text).toContain('Команда')
  expect(h.audit().at(-1)).toMatchObject({ event: 'chat.remove', chat_id: String(GROUP), reason: 'kicked' })
  // Re-adding asks again.
  await h.groups.memberUpdate(h.event(OWNER, 'kicked', 'member'))
  expect(h.store.pendingChats().map(chat => chat.id)).toEqual([String(GROUP)])
  // Leaving while pending clears the pending entry.
  await h.groups.memberUpdate(h.event(OWNER, 'member', 'left'))
  expect(h.store.pendingChats()).toEqual([])
})

test('[S2] an unapproved group is left after 24 hours', async () => {
  const h = harness()
  await h.groups.memberUpdate(h.event(OWNER, 'left', 'member'))
  h.advance(23 * 3_600_000)
  await h.groups.sweep()
  expect(h.left).toEqual([])
  h.advance(2 * 3_600_000)
  await h.groups.sweep()
  expect(h.left).toEqual([String(GROUP)])
  expect(h.store.pendingChats()).toEqual([])
  expect(await h.groups.callback('krot:chat:members:' + GROUP, OWNER, OWNER)).toBe('Запрос уже закрыт.')
})

test('[S2] /chats lists approved and pending groups; /chats remove leaves the group', async () => {
  const h = harness()
  await h.groups.memberUpdate(h.event(OWNER, 'left', 'member'))
  await h.groups.callback('krot:chat:members:' + GROUP, OWNER, OWNER)
  await h.groups.memberUpdate(h.event(OWNER, 'left', 'member', { chatId: -100555, title: 'Ждёт' }))
  await h.groups.ownerCommand('')
  const list = h.sent.at(-1)!.text
  expect(list).toContain(String(GROUP))
  expect(list).toContain('members')
  expect(list).toContain('-100555')
  expect(list).toContain('Ждёт')
  await h.groups.ownerCommand('remove ' + GROUP)
  expect(h.store.chat(String(GROUP))).toBeUndefined()
  expect(h.left).toEqual([String(GROUP)])
  expect(h.audit().at(-1)).toMatchObject({ event: 'chat.remove', chat_id: String(GROUP), reason: 'owner' })
  await h.groups.ownerCommand('remove 12abc')
  expect(h.sent.at(-1)!.text).toContain('/chats remove')
  await h.groups.ownerCommand('remove -100123')
  expect(h.sent.at(-1)!.text).toContain('нет')
})

test('[S2] a group upgraded to a supergroup keeps its approval under the new id', async () => {
  const h = harness()
  await h.groups.memberUpdate(h.event(OWNER, 'left', 'member', { chatId: -5555, chatType: 'group' }))
  await h.groups.callback('krot:chat:open:-5555', OWNER, OWNER)
  await h.groups.migrate(-5555, -1005555)
  expect(h.store.chat('-5555')).toBeUndefined()
  expect(h.store.chat('-1005555')?.mode).toBe('open')
  // An unknown chat's migration does nothing.
  await h.groups.migrate(-7777, -1007777)
  expect(h.store.chat('-1007777')).toBeUndefined()
})

test('[S2] a broken access.json refuses group approval', async () => {
  const h = harness()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(h.dir, 'access.json'), '{broken')
  const store = new AccessStore({ stateDir: h.dir, ownerId: String(OWNER), envMembers: [] })
  expect(store.addPendingChat(String(GROUP), { title: 'x', added_by: String(OWNER) }).ok).toBe(false)
  expect(store.chat(String(GROUP))).toBeUndefined()
})
