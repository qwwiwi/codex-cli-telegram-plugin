// The stop notice must not keep the process alive past its bounded wait: once stopping() settles,
// nothing it started (an HTTP request, a rate-limit wait, a 429 backoff) may
// hold the event loop. Measured on a real child process with the production send wrappers.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHILD = join(import.meta.dir, 'restart-notice-exit-child.ts')
const WAIT_MS = 300
/** Exit this long after the notice settled counts as prompt (process teardown, not a held timer). */
const EXIT_SLACK_MS = 1_000

const cleanup: Array<() => void> = []
afterEach(() => { for (const run of cleanup.splice(0)) run() })

type Answer = 'hang' | 'flood-30s' | 'retry-3s'

// A fake Bot API: every request gets the same treatment.
function fakeBotApi(answer: Answer): string {
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      if (answer === 'hang') return new Promise<Response>(() => undefined)
      const retryAfter = answer === 'flood-30s' ? 30 : 3
      return Response.json({ ok: false, error_code: 429, description: `Too Many Requests: retry after ${retryAfter}`,
        parameters: { retry_after: retryAfter } }, { status: 429 })
    },
  })
  cleanup.push(() => { void server.stop(true) })
  return `http://127.0.0.1:${server.port}`
}

async function exitAfterNotice(apiRoot: string, scenario: string): Promise<{ settled: boolean; exitMs: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'krotov-restart-exit-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const child = Bun.spawn([process.execPath, CHILD, apiRoot, dir, scenario, String(WAIT_MS)],
    { stdout: 'pipe', stderr: 'ignore' })
  cleanup.push(() => child.kill('SIGKILL'))
  let settledAt: number | undefined
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let out = ''
  const readLines = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      out += decoder.decode(value)
      if (settledAt === undefined && out.includes('settled\n')) settledAt = Date.now()
    }
  })()
  // Give up a while after the notice should have settled; a held process is killed then.
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await child.exited
  clearTimeout(deadline)
  const exitedAt = Date.now()
  await readLines
  return { settled: settledAt !== undefined, exitMs: settledAt === undefined ? Infinity : exitedAt - settledAt }
}

test('a stop notice cut off in flight lets the process exit right after the bounded wait', async () => {
  const result = await exitAfterNotice(fakeBotApi('hang'), 'in-flight')
  expect(result.settled).toBe(true)
  expect(result.exitMs).toBeLessThan(EXIT_SLACK_MS)
}, 20_000)

test('a stop notice still waiting for rate capacity lets the process exit right after the bounded wait', async () => {
  const result = await exitAfterNotice(fakeBotApi('flood-30s'), 'cooldown')
  expect(result.settled).toBe(true)
  expect(result.exitMs).toBeLessThan(EXIT_SLACK_MS)
}, 20_000)

test('a stop notice in a 429 backoff lets the process exit right after the bounded wait', async () => {
  const result = await exitAfterNotice(fakeBotApi('retry-3s'), 'retry')
  expect(result.settled).toBe(true)
  expect(result.exitMs).toBeLessThan(EXIT_SLACK_MS)
}, 20_000)
