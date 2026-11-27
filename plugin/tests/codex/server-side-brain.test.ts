import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from 'grammy/types'

import { AppConfigSchema } from '../../src/config.js'
import { createLogger } from '../../src/log.js'
import { redactSecrets } from '../../src/safety/redact.js'
import { createBrainBridge } from '../../src/codex/brain-bridge.js'
import { foreignProvenance, hasForeignReply, hasMemoryCue } from '../../src/codex/brain-origin.js'
import { formatReminder, sideOwnerTurn } from '../../src/codex/format-reminder.js'
import { CodexInbox } from '../../src/codex/inbox.js'
import { prepareInbound } from '../../src/codex/media.js'
import { hideLeaseCompletions } from '../../src/codex/lease.js'
import { SideRegistry, sideInstructions, taskTitle } from '../../src/codex/parallel.js'
import { agentBody, ownerProvenance } from '../../src/codex/provenance.js'
import { RenderEyes, renderNote } from '../../src/codex/render-eyes.js'
import { object } from '../../src/codex/rpc.js'
import { CodexSession } from '../../src/codex/session.js'
import { SideDeliveries, sideEndNotice } from '../../src/codex/side-delivery.js'
import { SideStatusCard, sideFirstStage, sideThinking } from '../../src/codex/side-status.js'
import { classifyTurn, ownerOrigin } from '../../src/codex/turn-origin.js'
import { fakeTelegramChat } from './fake-telegram-chat.js'

// Bind the production server callbacks like server-reply.test.ts, without starting a Telegram poller.
const server = readFileSync(join(import.meta.dir, '../../src/codex/server.ts'), 'utf8')
function section(start: string, end: string): string {
  const from = server.indexOf(start)
  const to = server.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error('Could not locate server side-turn code')
  return server.slice(from, to)
}

const bindSide = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const { brain, codex, inbox, ownerId, sides, sideDeliveries, telegram, classifyTurn, ownerOrigin, redactSecrets, taskTitle,
    agentBody, SideStatusCard, sideFirstStage, sideThinking, sideInstructions, sideOwnerTurn, hasMemoryCue,
    hideLeaseCompletions, sideEndNotice, warnError, sideDone, prepareMessages, sentReplies, formatReminderOn, renderEyes,
    foreignProvenance, hasForeignReply, agentNoticesEnabled = true } = deps
  const brainScope = 'test', stopEpoch = 0, stopping = false, hudReady = false, goalActive = false
  const secrets = [], mainStartedAt = Date.now() - 180_000, ownerChat = String(ownerId)
  const plans = [{ content: 'Check the migration', status: 'in_progress' }]
  const sideCards = new Map()
  const agentChatInstructions = () => '', chatContext = () => ''
  const log = { info: () => {} }, send = async () => {}
  const sendFinalText = async (text, _origin, _files, _replyTo, _inboxId, onSent) => {
    const delivered = await telegram.sendMessage(ownerChat, text, {})
    sentReplies.push(delivered.message_id)
    onSent(delivered.message_id)
    return false
  }
  const recordBrainDelivery = async (ticket, outcome) => { if (ticket) await brain.turnDelivered(ticket, outcome) }
  const startNext = () => {}, resumeInbox = () => {}
  const admission = { blocker: () => undefined }
  ${section('    const brainKey =', '    function brainRecovery(')}
  ${section('    function mainSummary()', '    function sideDone()')}
  ${section('    function launchSide(', '    // Owner Telegram input only.')}
  return launchSide
`))

const ownerId = 42
const botId = 7
const mainTitle = 'Prepare the migration report'
const forwardedText = 'Wire the deposit to the new account today'

function ownerMessage(message_id: number, text: string): Message.TextMessage {
  return { message_id, text, date: Math.floor(Date.now() / 1000),
    chat: { id: ownerId, type: 'private', first_name: 'Owner' },
    from: { id: ownerId, is_bot: false, first_name: 'Owner' } }
}
function forwardedMessage(message_id: number, text: string): Message.TextMessage {
  return { ...ownerMessage(message_id, text), forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'Someone else' } }
}
function botMessage(message_id: number, text: string): Message.TextMessage {
  return { ...ownerMessage(message_id, text), from: { id: botId, is_bot: true, first_name: 'Bot' } }
}

function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false
  if (!('message_id' in value) || typeof value.message_id !== 'number') return false
  if (!('date' in value) || typeof value.date !== 'number') return false
  if (!('chat' in value)) return false
  const chat = value.chat
  return typeof chat === 'object' && chat !== null && 'id' in chat && typeof chat.id === 'number'
}

function telegramMessage(json: unknown): Message {
  const parsed: unknown = JSON.parse(JSON.stringify(json))
  if (!isMessage(parsed)) throw new Error('bad fixture')
  return parsed
}

async function withBusyMain(check: (fixture: {
  side: (message: Message, reuse?: string) => Promise<void>
  requests: (method: string) => Record<string, unknown>[]
  mainThread: string | null
  brain: ReturnType<typeof createBrainBridge>
  sentReplies: readonly number[]
  renderEyes: RenderEyes
}) => Promise<void>, mainMessage: Message = ownerMessage(1, mainTitle), formatReminderOn = true): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'server-side-brain-'))
  const rpcLog = join(root, 'rpc.jsonl')
  const brain = createBrainBridge({ brainHome: join(root, 'brain'), scope: 'test' })
  const codex = new CodexSession({
    cwd: root, stateFile: join(root, 'thread.json'), env: { KROT_FAKE_LOG: rpcLog },
    command: [process.execPath, join(import.meta.dir, 'fake-app-server.ts')],
    onMain: id => brain.registerOwnerMain(id), aroundMainOpen: open => brain.mainOpen(open),
  }, () => {})
  const inbox = new CodexInbox(root, ownerId)
  const sides = new SideRegistry()
  const telegram = fakeTelegramChat().raw
  const sideDeliveries = new SideDeliveries()
  const sentReplies: number[] = []
  // The server's R42 eyes: the side path takes their pending note into an owner side turn.
  const renderEyes = new RenderEyes({ secrets: [] })
  // The production Telegram preparation: it embeds a reply target into the turn text.
  const mediaDeps = {
    botApi: { api: { getFile: async () => { throw new Error('No downloads in this test') } } },
    botToken: 'test-token', inboxDir: root, config: AppConfigSchema.parse({ bot_id: botId }), env: {},
    downloadFile: async () => { throw new Error('No downloads in this test') }, log: createLogger('test'),
  }
  const prepareMessages = (messages: readonly Message[]) => prepareInbound(messages, mediaDeps, { id: botId, username: 'test_bot' })
  try {
    expect(brain.enabled).toBe(true)
    brain.attach(codex)
    await codex.initialize()
    expect((await codex.run('Previous main turn')).status).toBe('completed')
    const started = Promise.withResolvers<void>()
    const main = codex.run('wait', [], () => started.resolve())
    try {
      await Promise.race([started.promise, main.then(() => { throw new Error('The main turn ended before the side launch') })])
      inbox.receive(mainMessage, ownerProvenance)
      inbox.take()
      // The main turn started with its classified origin, as the main path records it.
      inbox.start(mainMessage.message_id, classifyTurn([mainMessage], ownerId, ownerProvenance,
        { brain: true, key: 'test:' + mainMessage.message_id }))
      const side = async (message: Message, reuse?: string) => {
        const done = Promise.withResolvers<void>()
        const errors: string[] = []
        const launch: unknown = bindSide({
          brain, codex, inbox, ownerId, sides, sideDeliveries, telegram, classifyTurn, ownerOrigin, redactSecrets,
          taskTitle, agentBody, SideStatusCard, sideFirstStage, sideThinking, sideInstructions, sideOwnerTurn,
          hasMemoryCue, hideLeaseCompletions, sideEndNotice, sideDone: done.resolve, prepareMessages, sentReplies,
          formatReminderOn, renderEyes, foreignProvenance, hasForeignReply,
          warnError: (error: unknown, text: string) => { errors.push(`${text}: ${String(error)}`) },
        })
        if (typeof launch !== 'function') throw new Error('Could not bind the server side callback')
        expect(launch(message, reuse, ownerProvenance)).toBe(true)
        await done.promise
        expect(errors).toEqual([])
      }
      const requests = (method: string) => readFileSync(rpcLog, 'utf8').trim().split('\n')
        .map(line => object(JSON.parse(line))).filter(entry => entry.method === method).map(entry => object(entry.params))
      await check({ side, requests, mainThread: codex.currentThread, brain, sentReplies, renderEyes })
    } finally {
      await codex.stop()
      await main
    }
  } finally {
    codex.close()
    rmSync(root, { recursive: true, force: true })
  }
}

function prompt(params: Record<string, unknown> | undefined): unknown {
  return Array.isArray(params?.input) ? object(params.input[0]).text : undefined
}

test('[R02] default Brain gives an owner side turn the live main task title, step and elapsed time', async () => {
  await withBusyMain(async ({ side, requests }) => {
    await side(ownerMessage(2, 'How far along is the report?'))
    expect(prompt(requests('turn/start').at(-1))).toContain(`«${mainTitle}», текущий шаг: «Check the migration», идёт 3 мин.`)
  })
})

test('Brain owner side turns start with the same static guidance when the format reminder is off', async () => {
  const prefixes: string[] = []
  for (const title of [mainTitle, 'Review the release notes']) {
    await withBusyMain(async ({ side, requests }) => {
      await side(ownerMessage(2, 'How far along is it?'))
      const text = prompt(requests('turn/start').at(-1))
      if (typeof text !== 'string') throw new Error('The side turn did not send a prompt')
      expect(text).not.toContain(formatReminder)
      const summary = `\n«${title}», текущий шаг: «Check the migration», идёт `
      expect(text).toContain(summary)
      prefixes.push(text.slice(0, text.indexOf(summary)))
    }, ownerMessage(1, title), false)
  }
  expect(prefixes[0]).toContain('Ответь на новое сообщение владельца сам и быстро')
  expect(prefixes[0]).toContain('Рабочая папка общая')
  expect(prefixes[1]).toBe(prefixes[0])
})

test('[R14] default Brain opens an owner side as an ephemeral fork and reuses it for an owner reply', async () => {
  await withBusyMain(async ({ side, requests, mainThread }) => {
    await side(ownerMessage(2, 'How far along is the report?'))
    expect(requests('thread/fork')).toMatchObject([
      { threadId: mainThread, ephemeral: true, excludeTurns: true, lastTurnId: 'turn-1' },
    ])
    expect(requests('thread/start')).toHaveLength(1)
    const thread = requests('turn/start').at(-1)?.threadId
    if (typeof thread !== 'string' || thread === mainThread) throw new Error('The owner side thread was not opened')
    await side(ownerMessage(3, 'Add a short example'), thread)
    expect(requests('turn/start').at(-1)?.threadId).toBe(thread)
    expect(requests('thread/fork')).toHaveLength(1)
  })
})

test('[R14] default Brain keeps a quoted side reply out of the owner fork and hides the main summary', async () => {
  await withBusyMain(async ({ side, requests }) => {
    await side(ownerMessage(2, 'How far along is the report?'))
    const thread = requests('turn/start').at(-1)?.threadId
    if (typeof thread !== 'string') throw new Error('The owner side thread was not opened')
    await side({ ...ownerMessage(3, 'External note'), entities: [{ type: 'blockquote', offset: 0, length: 13 }] }, thread)
    expect(requests('thread/fork')).toHaveLength(1)
    expect(requests('thread/start')).toHaveLength(2)
    const quoted = requests('turn/start').at(-1)
    expect(quoted?.threadId).not.toBe(thread)
    expect(prompt(quoted)).toContain('«основная задача»')
    expect(prompt(quoted)).not.toContain(mainTitle)
    expect(prompt(quoted)).not.toContain('Check the migration')
  })
})

function expectNeutralSummary(params: Record<string, unknown> | undefined): void {
  const text = prompt(params)
  expect(text).toContain('«основная задача»')
  expect(text).not.toContain(mainTitle)
  expect(text).not.toContain('Check the migration')
}

test('[R14] default Brain never puts an isolated main turn into an owner side summary', async () => {
  await withBusyMain(async ({ side, requests }) => {
    await side(ownerMessage(2, 'How far along is it?'))
    const text = prompt(requests('turn/start').at(-1))
    expect(text).toContain('«основная задача»')
    expect(text).not.toContain(forwardedText)
    expect(text).not.toContain('Check the migration')
  }, forwardedMessage(1, forwardedText))
})

test('[R14] default Brain isolates a forwarded side turn next to the quoted one', async () => {
  await withBusyMain(async ({ side, requests }) => {
    await side(forwardedMessage(2, forwardedText))
    expect(requests('thread/fork')).toHaveLength(0)
    expect(requests('thread/start')).toHaveLength(2)
    const forwarded = requests('turn/start').at(-1)
    expect(prompt(forwarded)).toContain(forwardedText)
    expectNeutralSummary(forwarded)
  })
})

test('[R14] default Brain runs an owner reply to a forward as a guest side, without a fork or the main summary', async () => {
  await withBusyMain(async ({ side, requests, brain }) => {
    await side(forwardedMessage(2, forwardedText))
    const guest = requests('turn/start').at(-1)?.threadId
    if (typeof guest !== 'string') throw new Error('The guest side thread was not opened')
    expect(await brain.isSafeSide(guest, 'guest')).toBe(true)
    // The side registry maps the forward to its guest thread, so the reply is routed there.
    await side(telegramMessage({
      ...ownerMessage(3, 'What do you think about it?'),
      reply_to_message: forwardedMessage(2, forwardedText),
    }), guest)
    expect(requests('thread/fork')).toHaveLength(0)
    const reply = requests('turn/start').at(-1)
    expect(reply?.threadId).toBe(guest)
    expect(prompt(reply)).toContain('What do you think about it?')
    expectNeutralSummary(reply)
  })
})

test('[R14] default Brain isolates a fresh owner side reply to a foreign message', async () => {
  const targets = [
    forwardedMessage(9, forwardedText),
    { ...ownerMessage(9, forwardedText), entities: [{ type: 'blockquote', offset: 0, length: 5 }] },
    { ...ownerMessage(9, forwardedText), from: { id: 77, is_bot: false, first_name: 'Someone else' } },
    botMessage(9, forwardedText),
  ]
  for (const target of targets) {
    await withBusyMain(async ({ side, requests }) => {
      await side(telegramMessage({
        ...ownerMessage(3, 'What do you think about it?'),
        reply_to_message: target,
      }))
      expect(requests('thread/fork')).toHaveLength(0)
      expect(requests('thread/start')).toHaveLength(2)
      expectNeutralSummary(requests('turn/start').at(-1))
    })
  }
})

test('[R14] default Brain keeps the owner fork for a reply to its own side answer', async () => {
  await withBusyMain(async ({ side, requests, sentReplies }) => {
    await side(ownerMessage(2, 'How far along is the report?'))
    const thread = requests('turn/start').at(-1)?.threadId
    const answer = sentReplies.at(-1)
    if (typeof thread !== 'string' || answer === undefined) throw new Error('The owner side did not answer')
    await side(telegramMessage({
      ...ownerMessage(3, 'Add a short example'),
      reply_to_message: botMessage(answer, 'side: the report'),
    }), thread)
    expect(requests('thread/fork')).toHaveLength(1)
    const reply = requests('turn/start').at(-1)
    expect(reply?.threadId).toBe(thread)
    expect(prompt(reply)).toContain(`«${mainTitle}»`)
  })
})

test('[R14] default Brain gives a forked owner side no write permit and clears the live main permit', async () => {
  await withBusyMain(async ({ side, requests, brain, mainThread }) => {
    if (!mainThread) throw new Error('The main thread was not opened')
    // The main owner turn holds a live write permit, minted through the production start path.
    const ticket = await brain.turnStarting({ key: 'test:1', origin: 'owner-direct', inputKind: 'text',
      input: mainTitle, cue: false, sessionId: mainThread })
    if (!ticket) throw new Error('The main turn was not bound')
    await brain.turnStarted(ticket, 'turn-main')
    expect((await brain.permits.all()).map(permit => permit.turn_id)).toEqual(['turn-main'])
    await side(ownerMessage(2, 'How far along is the report?'))
    expect(requests('thread/fork')).toHaveLength(1)
    expect(prompt(requests('turn/start').at(-1))).not.toContain('--permit')
    expect(await brain.permits.all()).toEqual([])
  })
})

test('[R14] default Brain keeps an owner reply to his inline-bot message in its guest side, without a fork or the main summary', async () => {
  await withBusyMain(async ({ side, requests, brain }) => {
    const inline = telegramMessage({ ...ownerMessage(2, forwardedText), via_bot: { id: 99, is_bot: true, first_name: 'Inline' } })
    await side(inline)
    expect(requests('thread/fork')).toHaveLength(0)
    const guest = requests('turn/start').at(-1)?.threadId
    if (typeof guest !== 'string') throw new Error('The guest side thread was not opened')
    expect(await brain.isSafeSide(guest, 'guest')).toBe(true)
    // The side registry maps the inline-bot message to its guest thread, so the reply is routed there.
    await side(telegramMessage({
      ...ownerMessage(3, 'What do you think about it?'),
      reply_to_message: inline,
    }), guest)
    expect(requests('thread/fork')).toHaveLength(0)
    const reply = requests('turn/start').at(-1)
    expect(reply?.threadId).toBe(guest)
    expect(prompt(reply)).toContain('What do you think about it?')
    expectNeutralSummary(reply)
  })
})

test('[R14] one provenance rule isolates every foreign marker on an incoming message and on a side reply target', async () => {
  // Loaded at run time so that a missing export fails this test alone, not the whole file.
  const { classifyBrainOrigin, foreignProvenance } = await import('../../src/codex/brain-origin.js')
  const plain = ownerMessage(9, forwardedText)
  expect(foreignProvenance(telegramMessage(plain), ownerId)).toBe(false)
  const markers: Record<string, unknown> = {
    forward: { ...plain, forward_origin: { type: 'hidden_user', date: 1, sender_user_name: 'Someone else' } },
    automaticForward: { ...plain, is_automatic_forward: true },
    blockquote: { ...plain, entities: [{ type: 'blockquote', offset: 0, length: 5 }] },
    expandableBlockquote: { ...plain, entities: [{ type: 'expandable_blockquote', offset: 0, length: 5 }] },
    otherSender: { ...plain, from: { id: 77, is_bot: false, first_name: 'Someone else' } },
    botSender: { ...plain, from: { id: botId, is_bot: true, first_name: 'Bot' } },
    otherChat: { ...plain, chat: { id: -100, type: 'supergroup', title: 'Group' } },
    senderChat: { ...plain, sender_chat: { id: -100, type: 'channel', title: 'Channel' } },
    viaBot: { ...plain, via_bot: { id: 99, is_bot: true, first_name: 'Inline' } },
    businessBot: { ...plain, sender_business_bot: { id: 98, is_bot: true, first_name: 'Business' } },
    businessConnection: { ...plain, business_connection_id: 'connection' },
    topic: { ...plain, message_thread_id: 5 },
  }
  for (const [marker, target] of Object.entries(markers)) {
    const incoming = telegramMessage(target)
    const reply = telegramMessage({ ...ownerMessage(3, 'What do you think about it?'), reply_to_message: target })
    expect([marker, foreignProvenance(incoming, ownerId)]).toEqual([marker, true])
    expect([marker, classifyBrainOrigin(incoming, ownerId).isolate]).toEqual([marker, true])
    expect([marker, classifyBrainOrigin(reply, ownerId, { side: true }).isolate]).toEqual([marker, true])
    // The real side path: a fresh guest thread, no fork of the main thread, no main summary.
    await withBusyMain(async ({ side, requests }) => {
      await side(reply)
      expect([marker, requests('thread/fork').length]).toEqual([marker, 0])
      expect(requests('thread/start')).toHaveLength(2)
      expectNeutralSummary(requests('turn/start').at(-1))
    })
  }
})

test('[R42] an owner side turn carries the pending render note once', async () => {
  await withBusyMain(async ({ side, requests, renderEyes }) => {
    // A previous reply whose HTML Telegram refused: it went out as plain text.
    renderEyes.record({ source: 'Итог **важно**', parts: [{ format: 'plain', text: 'Итог **важно**', messageId: 90 }], brokenHtml: 1 })
    const note = renderNote([{ kind: 'broken_tags', shown: 'простой текст', expected: 'форматирования: HTML-теги не сошлись', literal: false }])
    await side(ownerMessage(2, 'How far along is the report?'))
    expect(prompt(requests('turn/start').at(-1))).toContain(note)
    // Once: the side turn took the note.
    expect(renderEyes.takeNote()).toBe('')
  })
})

test('[R42] with Brain off a forwarded or foreign-reply side turn neither sees nor takes the owner render note', async () => {
  const note = renderNote([{ kind: 'broken_tags', shown: 'простой текст', expected: 'форматирования: HTML-теги не сошлись', literal: false }])
  const foreign: Message[] = [
    forwardedMessage(2, forwardedText),
    telegramMessage({ ...ownerMessage(3, 'What do you think about it?'), reply_to_message: forwardedMessage(1, forwardedText) }),
  ]
  for (const message of foreign) {
    await withBusyMain(async ({ side, requests, brain, renderEyes }) => {
      // Brain off: the classification never isolates, so the note must be gated on provenance alone.
      // The owner's `/memory off`: the bridge exposes no direct switch.
      expect((await brain.memoryCommand({ args: 'off', ownerPrivateChat: true })).text).toBe('Brain выключен.')
      expect(brain.enabled).toBe(false)
      renderEyes.record({ source: 'Итог **важно**', parts: [{ format: 'plain', text: 'Итог **важно**', messageId: 90 }], brokenHtml: 1 })
      await side(message)
      const text = prompt(requests('turn/start').at(-1))
      expect([message.message_id, typeof text === 'string' && text.includes(note)]).toEqual([message.message_id, false])
      // The note waits for the owner's next own turn.
      expect([message.message_id, renderEyes.takeNote()]).toEqual([message.message_id, note])
    })
  }
})
