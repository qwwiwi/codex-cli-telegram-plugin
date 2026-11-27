import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Message } from 'grammy/types'
import type { MediaInput } from '../../src/codex/media.js'

// Bind the production server callbacks without starting a Telegram poller.
const server = readFileSync(join(import.meta.dir, '../../src/codex/server.ts'), 'utf8')
function section(start: string, end: string): string {
  const from = server.indexOf(start)
  const to = server.indexOf(end, from + start.length)
  if (from < 0 || to < 0) throw new Error('Could not locate the server voice or stop path')
  return server.slice(from, to)
}

const bind = new Function('deps', new Bun.Transpiler({ loader: 'ts' }).transformSync(`
  const { message, prepareMessages, stopSide, startTurn, finishInbox, warnError } = deps
  const noop = () => {}
  let task, cancelMedia, mainStartedAt, stopEpoch = 0
  const stopping = false, goalActive = false, ownerId = 42, selfRestartEnabled = false
  const restartHandoff = undefined, goalStarting = undefined, proxy = false
  const bridgeRestart = { cancel: noop }, ownerEffects = { withdrawPendingTask: noop }
  const questions = { cancel: noop }, approvals = undefined, sides = { size: 1 }
  const codex = { stopSide, sideRunning: sides.size, stop: async () => false, run: startTurn, runSide: startTurn }
  const work = { begin: noop, finish: noop, hasBackground: false }
  const send = async () => {}, finishMirror = noop, hudAnchor = { refresh: noop }
  const admission = { blocker: () => false }, queueNotices = { pickedUp: noop }, controls = {}
  const isRestartVerificationMessage = () => false
  const ready = [[message]]
  const inbox = {
    take: () => ready.shift(), cancelContinuation: noop, provenance: () => ({ origin: 'owner' }),
    start: noop, finish: finishInbox,
  }
  const bot = { botInfo: { id: 7 } }
  const classifyTurn = () => ({ origin: 'owner-direct', role: 'owner', isolate: false })
  const ownerOrigin = origin => origin, turnIntent = () => ({}), questionFallback = () => ({})
  const brainKey = noop, brainInput = noop, ownerWords = noop
  const brain = { enabled: true, execution: () => ({ run: run => run() }) }
  const ownerTurn = noop, formatReminderOn = false, leases = { instructions: noop }, chatContext = noop
  const config = { ask_user_question: { enabled: false } }
  const autonomyInstructions = '', renderEyes = { takeNote: noop }, agentChatInstructions = noop
  const agentChat = { flush: async () => {}, componentDelivery: noop, componentTexts: noop }
  const log = { info: noop }, recordBrainDelivery = async () => {}
  ${section('    function cancelPendingBridgeRestart()', '    async function handleMemory(')}
  ${section('    function startNext()', '    for (const [id, messages] of Object.entries(inbox.recoveredAlbums))')}
  return action => {
    if (action === 'stop') return stop()
    startNext()
    return task
  }
`))

test('/stop prevents a transcribed owner voice from starting a turn while the side stop is pending', async () => {
  const message: Message.VoiceMessage = {
    message_id: 1, date: 1,
    chat: { id: 42, type: 'private', first_name: 'Owner' },
    from: { id: 42, is_bot: false, first_name: 'Owner' },
    voice: { file_id: 'voice', file_unique_id: 'voice', duration: 1 },
  }
  const transcription = Promise.withResolvers<MediaInput>()
  const sideStopStarted = Promise.withResolvers<void>()
  const sideStop = Promise.withResolvers<boolean>()
  const finished: number[] = []
  const warnings: unknown[] = []
  let transcribing = false
  let turnStarts = 0
  const run: unknown = bind({
    message,
    prepareMessages: () => {
      transcribing = true
      return transcription.promise
    },
    stopSide: () => {
      sideStopStarted.resolve()
      return sideStop.promise
    },
    startTurn: async () => {
      turnStarts++
      return { status: 'interrupted', text: '' }
    },
    finishInbox: (id: number) => { finished.push(id) },
    warnError: (error: unknown) => { warnings.push(error) },
  })
  if (typeof run !== 'function') throw new Error('Could not bind the server voice and stop callbacks')

  const voice = run('voice')
  expect(transcribing).toBe(true)
  const stop = run('stop')
  try {
    await sideStopStarted.promise
    // The old confirmation card skipped transcripts over 2,000 characters.
    const transcript = 'Check the report. '.repeat(125)
    transcription.resolve({ kind: 'input', text: transcript, images: [], ownerTranscript: transcript })
    await voice
    expect(warnings).toEqual([])
    expect(turnStarts).toBe(0)
    expect(finished).toEqual([message.message_id])
  } finally {
    sideStop.resolve(true)
    await stop
  }
})
