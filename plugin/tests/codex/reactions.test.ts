import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeEnvSchema } from '../../src/config.js'
import { AgentChatActions } from '../../src/codex/chat-actions.js'
import {
  ackInbound, ackReactionMode, DEFAULT_REACTION_PALETTE, parseReactionPalette, reactionInstructions,
} from '../../src/codex/reactions.js'

const token = '100001:fake-token-with-enough-characters'

function recordingApi() {
  const reactions: unknown[][] = []
  const unexpected = async () => { throw new Error('Unexpected Telegram call') }
  return {
    reactions,
    api: {
      sendMessage: async () => ({ message_id: 24 }), editMessageText: unexpected,
      pinChatMessage: unexpected, unpinChatMessage: unexpected,
      async setMessageReaction(...args: unknown[]) { reactions.push(args) },
    },
  }
}

function hint(result: { contentItems: [{ text: string }] }): string {
  return String(JSON.parse(result.contentItems[0].text).hint ?? '')
}

test('[R02] KROT_ACK_REACTION=off or unset: an inbound owner message gets no automatic reaction, also after an upgrade', async () => {
  const { api, reactions } = recordingApi()
  const mode = ackReactionMode({ KROT_ACK_REACTION: 'off' })
  expect(mode).toBe('off')
  expect(await ackInbound(api, '123', 12, mode)).toBe(false)
  // An existing install upgraded without the variable in its plugin/.env switches the automatic 👀 off too.
  expect(ackReactionMode({})).toBe('off')
  expect(await ackInbound(api, '123', 13, ackReactionMode({}))).toBe(false)
  expect(reactions).toEqual([])
})

test('[R02] an explicit KROT_ACK_REACTION=eyes keeps the 👀 on every inbound owner message', async () => {
  const { api, reactions } = recordingApi()
  expect(ackReactionMode({ KROT_ACK_REACTION: 'eyes' })).toBe('eyes')
  expect(await ackInbound(api, '123', 12, ackReactionMode({ KROT_ACK_REACTION: 'eyes' }))).toBe(true)
  expect(reactions).toEqual([['123', 12, '👀']])
})

test('[R02] the reaction settings are validated at startup against Telegram\'s reaction list', () => {
  const env = { TELEGRAM_BOT_TOKEN: token }
  expect(DEFAULT_REACTION_PALETTE).toEqual(['👍', '❤', '🔥', '🎉', '😁', '🤔', '👏', '🙏', '💯', '🤝'])
  expect(parseReactionPalette(undefined)).toEqual(DEFAULT_REACTION_PALETTE)
  expect(parseReactionPalette(' 🔥, ❤️ ,👀')).toEqual(['🔥', '❤', '👀'])
  expect(() => parseReactionPalette('🔥,🦖')).toThrow('🦖')
  expect(() => parseReactionPalette('🔥,🔥')).toThrow()
  expect(() => parseReactionPalette('')).toThrow()
  expect(RuntimeEnvSchema.safeParse({ ...env, KROT_REACTION_PALETTE: '🔥,👍' }).success).toBe(true)
  expect(RuntimeEnvSchema.safeParse({ ...env, KROT_REACTION_PALETTE: '🔥,🦖' }).success).toBe(false)
  expect(RuntimeEnvSchema.safeParse({ ...env, KROT_ACK_REACTION: 'off' }).success).toBe(true)
  expect(RuntimeEnvSchema.safeParse({ ...env, KROT_ACK_REACTION: 'sometimes' }).success).toBe(false)
})

test('[R02] the model reacts with 🔥 from the palette on an owner message', async () => {
  const { api, reactions } = recordingApi()
  const actions = new AgentChatActions(api, '123')
  actions.rememberOwner(12)
  const result = await actions.call('fire', { action: 'react', target: 12, emoji: '🔥' }, () => true)
  expect(result.success).toBe(true)
  expect(reactions).toEqual([['123', 12, '🔥']])
  expect(actions.hasReacted(12)).toBe(true)
})

test('[R02] the model cannot react with an emoji outside the palette, with a hint naming the palette', async () => {
  const { api, reactions } = recordingApi()
  const actions = new AgentChatActions(api, '123', { reactionPalette: ['🔥', '👍'] })
  actions.rememberOwner(12)
  // 👎 is a valid Telegram reaction but not in this palette; 🦖 is not a Telegram reaction at all.
  for (const [key, emoji] of [['thumbs-down', '👎'], ['dino', '🦖'], ['eyes', '👀']] as const) {
    const result = await actions.call(key, { action: 'react', target: 12, emoji }, () => true)
    expect(result.success).toBe(false)
    expect(hint(result)).toContain('палитр')
    expect(hint(result)).toContain('🔥 👍')
  }
  expect(reactions).toEqual([])
})

test('[R02] the model reacts at most once per message and only on owner messages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'krot-reactions-'))
  try {
    const { api, reactions } = recordingApi()
    const actions = new AgentChatActions(api, '123', { root })
    actions.rememberOwner(12)
    actions.remember(24, true, true)
    expect((await actions.call('one', { action: 'react', target: 12, emoji: '👍' }, () => true)).success).toBe(true)
    const again = await actions.call('two', { action: 'react', target: 12, emoji: '🎉' }, () => true)
    expect(again.success).toBe(false)
    expect(hint(again)).toContain('уже')
    const own = await actions.call('own', { action: 'react', target: 'last_reply', emoji: '👍' }, () => true)
    expect(own.success).toBe(false)
    expect(hint(own)).toContain('владельца')
    // The one-reaction guard and the owner mark survive a restart.
    const restarted = new AgentChatActions(api, '123', { root })
    expect((await restarted.call('three', { action: 'react', target: 12, emoji: '🔥' }, () => true)).success).toBe(false)
    restarted.rememberOwner(13)
    expect((await restarted.call('four', { action: 'react', target: 13, emoji: '🔥' }, () => true)).success).toBe(true)
    expect(reactions).toEqual([['123', 12, '👍'], ['123', 13, '🔥']])
  } finally { rmSync(root, { force: true, recursive: true }) }
})

test('[R02] the agent is told the palette with a meaning for each emoji and to react rarely', () => {
  const text = reactionInstructions(DEFAULT_REACTION_PALETTE)
  for (const emoji of DEFAULT_REACTION_PALETTE) expect(text).toContain(emoji + ' — ')
  expect(text).toContain('редко')
  expect(text).toContain('не на каждое сообщение')
  expect(reactionInstructions(['🦄'])).toContain('🦄')
})
