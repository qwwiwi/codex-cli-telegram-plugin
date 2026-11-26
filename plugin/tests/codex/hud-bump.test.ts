import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ContextHud, type HudTelegramApi } from '../../src/status/context-hud.js'
import { createLogger } from '../../src/log.js'

const OWNER = '123'

afterEach(() => { setSystemTime() })

// A fake Telegram chat: messages in send order, so "the HUD is at the bottom"
// means "the HUD id is the last key".
function fixture(failures: { delete?: boolean; unpin?: boolean; send?: boolean } = {}) {
  const gone = (desc: string): Error => Object.assign(new Error(desc), { error_code: 400, description: desc })
  const messages = new Map<number, string>()
  const calls: string[] = []
  let next = 100
  let renders = 0
  const api: HudTelegramApi = {
    async sendMessage(_chat, text) {
      calls.push('send')
      if (failures.send) throw new Error('send failed')
      messages.set(++next, text)
      return { message_id: next }
    },
    async editMessageText(_chat, id, text) {
      calls.push('edit:' + id)
      if (!messages.has(id)) throw gone('Bad Request: message to edit not found')
      messages.set(id, text)
    },
    async pinChatMessage(_chat, id) { calls.push('pin:' + id) },
    async unpinChatMessage(_chat, id) {
      calls.push('unpin:' + id)
      if (failures.unpin) throw new Error('unpin failed')
    },
    async deleteMessage(_chat, id) {
      calls.push('delete:' + id)
      if (failures.delete) throw new Error('message can\'t be deleted')
      messages.delete(id)
    },
  }
  const stateDir = mkdtempSync(join(tmpdir(), 'hud-bump-'))
  const hud = new ContextHud({
    api, log: createLogger('hud-bump-test'), sessionInfo: { get: () => ({}) }, windowTokens: 0,
    ownerChatIds: [OWNER], stateDir, enabled: true,
    render: () => ({ text: 'HUD ' + ++renders, keyboard: { inline_keyboard: [] } }),
  })
  const owner = (text: string): void => { messages.set(++next, text) }
  const persisted = (): number =>
    (JSON.parse(readFileSync(join(stateDir, `context-hud-${OWNER}.json`), 'utf8')) as { message_id: number }).message_id
  return { hud, api, messages, calls, owner, persisted }
}

test('bump moves the HUD card to the bottom of the chat and persists the new id', async () => {
  const { hud, messages, calls, owner, persisted } = fixture()
  setSystemTime(new Date(1_000_000))
  await hud.updateNow(OWNER)
  const first = persisted()
  owner('owner message')
  owner('agent reply')
  calls.length = 0

  await hud.bump(OWNER)

  const ids = [...messages.keys()]
  const bottom = ids.at(-1)!
  expect(messages.has(first)).toBe(false)
  expect(bottom).not.toBe(first)
  expect(messages.get(bottom)).toStartWith('HUD ')
  expect(calls).toEqual(['delete:' + first, 'send', 'pin:' + bottom])
  expect(persisted()).toBe(bottom)
})

test('[R04] a second owner message right after the first still moves the card below it', async () => {
  const { hud, messages, calls, owner, persisted } = fixture()
  setSystemTime(new Date(1_000_000))
  await hud.updateNow(OWNER)
  owner('message 1')
  await hud.bump(OWNER)
  const first = persisted()
  owner('message 2')
  setSystemTime(new Date(1_000_200))
  calls.length = 0

  await hud.bump(OWNER)

  const bottom = [...messages.keys()].at(-1)!
  expect(bottom).not.toBe(first)
  expect(messages.has(first)).toBe(false)
  expect(messages.get(bottom)).toStartWith('HUD ')
  expect(calls).toEqual(['delete:' + first, 'send', 'pin:' + bottom])
})

test('[R04] retire removes a card that landed below the answer and the turn-end refresh does not recreate it', async () => {
  const { hud, messages, calls, owner, persisted } = fixture()
  setSystemTime(new Date(1_000_000))
  owner('owner message')
  await hud.bump(OWNER)
  const late = persisted()
  // The late card landed after the answer went out.
  messages.delete(late)
  owner('agent reply')
  messages.set(late, 'HUD late')
  calls.length = 0

  await hud.retire(OWNER)
  await hud.updateNow(OWNER)

  expect(messages.has(late)).toBe(false)
  expect(calls).toEqual(['delete:' + late])
  expect([...messages.values()].at(-1)).toBe('agent reply')

  // The next owner message brings a fresh card back into place.
  owner('next owner message')
  await hud.bump(OWNER)
  expect([...messages.values()].at(-1)).toStartWith('HUD ')
})

test('a refused delete falls back to unpin and still sends a fresh card at the bottom', async () => {
  const { hud, messages, calls, owner, persisted } = fixture({ delete: true })
  setSystemTime(new Date(1_000_000))
  await hud.updateNow(OWNER)
  const first = persisted()
  owner('owner message')
  calls.length = 0

  await hud.bump(OWNER)

  const bottom = [...messages.keys()].at(-1)!
  expect(bottom).not.toBe(first)
  expect(calls).toEqual(['delete:' + first, 'unpin:' + first, 'send', 'pin:' + bottom])
  expect(persisted()).toBe(bottom)
})

test('bump never rejects when Telegram fails, and sends a card when none exists', async () => {
  const broken = fixture({ delete: true, unpin: true, send: true })
  setSystemTime(new Date(1_000_000))
  await expect(broken.hud.bump(OWNER)).resolves.toBeUndefined()

  const fresh = fixture()
  await fresh.hud.bump(OWNER)
  expect(fresh.calls).toEqual(['send', 'pin:101'])
  expect(fresh.persisted()).toBe(101)
})

test('a card the owner already deleted is replaced by a fresh one at the bottom', async () => {
  const { hud, messages, calls, owner, persisted } = fixture({ delete: true, unpin: true })
  setSystemTime(new Date(1_000_000))
  await hud.updateNow(OWNER)
  const first = persisted()
  messages.delete(first)
  owner('owner message')
  calls.length = 0

  await hud.bump(OWNER)

  const bottom = [...messages.keys()].at(-1)!
  expect(bottom).not.toBe(first)
  expect(messages.get(bottom)).toStartWith('HUD ')
  expect(persisted()).toBe(bottom)
})

test('F4: a replacement that failed to send is not recreated below the reply by the turn-end refresh', async () => {
  const failures: { send?: boolean } = {}
  const { hud, messages, calls, owner } = fixture(failures)
  setSystemTime(new Date(1_000_000))
  await hud.updateNow(OWNER)
  owner('owner message')
  failures.send = true
  await hud.bump(OWNER)
  failures.send = false
  owner('agent reply')
  calls.length = 0

  await hud.updateNow(OWNER)

  expect(calls).not.toContain('send')
  expect([...messages.values()].at(-1)).toBe('agent reply')

  // The next owner message bumps a fresh card into place again.
  setSystemTime(new Date(1_000_000 + 60_000))
  owner('next owner message')
  await hud.bump(OWNER)
  expect([...messages.values()].at(-1)).toStartWith('HUD ')
})
