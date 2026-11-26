// Outbox entries saved before secrets were masked in the source: a deferred reply's HTML parts were redacted one by
// one, so a configured secret cut across two parts (or escaped as `&amp;`) survived and a replay showed it whole.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { htmlToPlainText } from '../../src/format/chunk.js'
import { createLogger } from '../../src/log.js'
import { Outbox } from '../../src/safety/outbox.js'
import { redactOutboundText } from '../../src/safety/safe-telegram-api.js'

const SECRET = 'Synth&Secret<value>"42"'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function legacyOutbox(items: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'krot-outbox-legacy-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'outbox.json'), JSON.stringify(items))
  return dir
}

function open(dir: string, sent: string[]): Outbox {
  return new Outbox({
    stateDir: dir, log: createLogger('test'), now: () => 0,
    sendFn: async (_chat, text, opts) => {
      // What the safe wrapper does per message: redact that one message, then send.
      sent.push(redactOutboundText(text, opts.parse_mode, [SECRET]))
      return { message_id: 50 + sent.length }
    },
    redact: (text, parseMode) => redactOutboundText(text, parseMode, [SECRET]),
  })
}

const escaped = 'Synth&amp;Secret&lt;value&gt;&quot;42&quot;'
const opts = { parse_mode: 'HTML', ownerReply: true }

test('a legacy deferred reply with a secret split across two HTML parts replays redacted', async () => {
  const cut = 'Synth&amp;Sec'.length
  const dir = legacyOutbox([
    { id: 'a', chatId: '1', text: '<b>Ключ: ' + escaped.slice(0, cut), opts: { ...opts, reply_to_message_id: 9 },
      notBefore: 10, attempts: 1 },
    { id: 'b', chatId: '1', text: escaped.slice(cut) + ' хвост</b>', opts, notBefore: 10, attempts: 1 },
  ])
  const sent: string[] = []
  await open(dir, sent).flushDue(10_000)
  const shown = sent.map(htmlToPlainText).join('')
  expect(shown).not.toContain(SECRET)
  expect(shown).not.toContain('Secret<value>')
  expect(shown).toContain('Ключ: [REDACTED] хвост')
  expect(readFileSync(join(dir, 'outbox.json'), 'utf8')).toBe('[]')
})

test('a secret cut inside a code block, where the old chunker closed and reopened the block, replays redacted', async () => {
  const cut = 'Synth&amp;'.length
  const dir = legacyOutbox([
    { id: 'e', chatId: '2', text: '<pre><code>' + escaped.slice(0, cut) + '</code></pre>', opts, notBefore: 1, attempts: 0 },
    { id: 'f', chatId: '2', text: '<pre><code>' + escaped.slice(cut) + '\nend</code></pre>', opts, notBefore: 1, attempts: 0 },
  ])
  const sent: string[] = []
  await open(dir, sent).flushDue(10_000)
  expect(sent).toEqual(['<pre><code>[REDACTED]\nend</code></pre>'])
})

test('the upgrade rewrites a legacy queue once and leaves a run without a hit as it was', () => {
  const plain = [
    { id: 'c', chatId: '1', text: 'первая часть ', opts: { ...opts, reply_to_message_id: 3 }, notBefore: 5, attempts: 0 },
    { id: 'd', chatId: '1', text: 'вторая часть', opts, notBefore: 5, attempts: 0 },
  ]
  const dir = legacyOutbox(plain)
  const first = open(dir, []).snapshot()
  expect(first.map(item => item.text)).toEqual(plain.map(item => item.text))
  expect(first.map(item => item.id)).toEqual(['c', 'd'])
  // Saved as migrated: a second start reads the same queue and rewrites nothing.
  const after = readFileSync(join(dir, 'outbox.json'), 'utf8')
  expect(open(dir, []).snapshot()).toEqual(first)
  expect(readFileSync(join(dir, 'outbox.json'), 'utf8')).toBe(after)
})
