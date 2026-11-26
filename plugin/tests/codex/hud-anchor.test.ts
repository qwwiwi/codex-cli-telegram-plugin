import { expect, test } from 'bun:test'

import { HudAnchor, type HudCard } from '../../src/codex/hud-anchor.js'

const OWNER = '123'

// A fake HUD that records what it was asked to do. `bump` resolves only when
// the test releases it, so the test controls when the card "lands" in chat.
function fakeHud(options: { bumpFails?: boolean; bumpHangs?: boolean } = {}) {
  const calls: string[] = []
  const releases: Array<() => void> = []
  const hud: HudCard = {
    bump(chatId) {
      calls.push('bump:' + chatId)
      if (options.bumpHangs) return new Promise<void>(() => undefined)
      return new Promise<void>((resolve, reject) => {
        releases.push(() => {
          if (options.bumpFails) {
            reject(new Error('telegram down'))
            return
          }
          calls.push('hud-sent')
          resolve()
        })
      })
    },
    async updateNow(chatId) { calls.push('edit:' + chatId) },
    async retire(chatId) { calls.push('retire:' + chatId) },
  }
  return { hud, calls, release: () => { for (const release of releases.splice(0)) release() } }
}

test('an accepted owner message moves the HUD card to the bottom', () => {
  const { hud, calls } = fakeHud()
  const anchor = new HudAnchor(hud, OWNER)

  anchor.ownerMessage()

  expect(calls).toEqual(['bump:' + OWNER])
})

test('turn end only refreshes the card in place and never moves it', async () => {
  const { hud, calls } = fakeHud()
  const anchor = new HudAnchor(hud, OWNER)

  anchor.refresh()
  await Bun.sleep(0)

  expect(calls).toEqual(['edit:' + OWNER])
})

test('the reply for an input is sent only after the HUD card for that input landed', async () => {
  const { hud, calls, release } = fakeHud()
  const anchor = new HudAnchor(hud, OWNER)
  const reply = async (): Promise<void> => {
    await anchor.settled()
    calls.push('reply')
  }

  anchor.ownerMessage()
  const sending = reply()
  await Bun.sleep(5)
  expect(calls).toEqual(['bump:' + OWNER])
  release()
  await sending
  anchor.refresh()
  await Bun.sleep(0)

  expect(calls).toEqual(['bump:' + OWNER, 'hud-sent', 'reply', 'edit:' + OWNER])
})

test('a failing HUD never blocks or breaks the reply', async () => {
  const failing = fakeHud({ bumpFails: true })
  const anchor = new HudAnchor(failing.hud, OWNER)
  anchor.ownerMessage()
  failing.release()
  await expect(anchor.settled()).resolves.toBeUndefined()

  const hanging = fakeHud({ bumpHangs: true })
  const capped = new HudAnchor(hanging.hud, OWNER, 20)
  capped.ownerMessage()
  const started = Date.now()
  await expect(capped.settled()).resolves.toBeUndefined()
  expect(Date.now() - started).toBeLessThan(1000)

  const throwing: HudCard = {
    bump() { throw new Error('sync failure') },
    updateNow() { throw new Error('sync failure') },
    retire() { throw new Error('sync failure') },
  }
  const safe = new HudAnchor(throwing, OWNER)
  expect(() => safe.ownerMessage()).not.toThrow()
  expect(() => safe.refresh()).not.toThrow()
  await expect(safe.settled()).resolves.toBeUndefined()
})

test('F4: a reply waits for a hanging card at most once, across both of its HUD waits', async () => {
  const { hud } = fakeHud({ bumpHangs: true })
  const anchor = new HudAnchor(hud, OWNER, 60)
  anchor.ownerMessage()
  const started = Date.now()
  // deliverReply waits, then sendFinalText waits again for the same card.
  await anchor.settled()
  await anchor.settled()
  expect(Date.now() - started).toBeLessThan(100)
})

test('without an owner message the reply does not wait for the HUD', async () => {
  const { hud } = fakeHud({ bumpHangs: true })
  const anchor = new HudAnchor(hud, OWNER, 10_000)
  const started = Date.now()
  await anchor.settled()
  expect(Date.now() - started).toBeLessThan(100)
})

test('a second reply waiting on the same hanging card shares its cap instead of starting a new one', async () => {
  const { hud } = fakeHud({ bumpHangs: true })
  const anchor = new HudAnchor(hud, OWNER, 200)
  anchor.ownerMessage()
  const started = Date.now()
  const first = anchor.settled()
  await Bun.sleep(150)
  // A concurrent waiter: the card was asked to move once, so it gets one cap in total.
  const second = anchor.settled()
  await Promise.all([first, second])
  expect(Date.now() - started).toBeLessThan(300)
})

test('[R04] a reply waits for its own card even when Telegram needs longer than three seconds', async () => {
  const { hud, calls, release } = fakeHud()
  const anchor = new HudAnchor(hud, OWNER)
  anchor.ownerMessage()
  setTimeout(release, 3200)
  await anchor.settled()
  calls.push('reply')
  expect(calls).toEqual(['bump:' + OWNER, 'hud-sent', 'reply'])
}, 10_000)

test('[R04] a card that hangs past the guard is retired once it lands, so it never sits below the answer', async () => {
  const { hud, calls, release } = fakeHud()
  const anchor = new HudAnchor(hud, OWNER, 20)
  anchor.ownerMessage()
  await anchor.settled()
  calls.push('reply')
  release()
  await Bun.sleep(5)
  // ContextHud serializes per chat: the retire queued at the guard runs right
  // after the late card lands and deletes it.
  expect(calls).toEqual(['bump:' + OWNER, 'retire:' + OWNER, 'reply', 'hud-sent'])
})

test('[R04] rapid owner messages never reuse an older card: a burst ends with a fresh move after the last message', async () => {
  const { hud, calls, release } = fakeHud()
  const anchor = new HudAnchor(hud, OWNER)
  anchor.ownerMessage()
  anchor.ownerMessage()
  anchor.ownerMessage()
  const reply = anchor.settled().then(() => { calls.push('reply') })
  await Bun.sleep(5)
  // One move in flight; the burst behind it collapses into one trailing move.
  expect(calls).toEqual(['bump:' + OWNER])
  release()
  await Bun.sleep(5)
  expect(calls).toEqual(['bump:' + OWNER, 'hud-sent', 'bump:' + OWNER])
  release()
  await reply
  expect(calls).toEqual(['bump:' + OWNER, 'hud-sent', 'bump:' + OWNER, 'hud-sent', 'reply'])
})
