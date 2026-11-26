import { join } from 'node:path'
import { splitPlainMessage } from '../format/chunk.js'

/** Run the installed checkout's collector independently of the owner's project directory. */
export async function collectUsage(repo: string, stateDir: string, days: string): Promise<string> {
  const { PATH, HOME, CODEX_HOME } = process.env
  const child = Bun.spawn(['python3', '-I', join(repo, 'scripts', 'usage_analytics.py'),
    '--state-dir', stateDir, '--days', days], {
    env: { PATH, HOME, CODEX_HOME }, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
    timeout: 120_000, killSignal: 'SIGKILL',
  })
  const [report, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0 || !report.trim()) throw new Error('Usage collector did not return a report')
  return report.trim()
}

/** Keep a slow disk scan out of the Telegram poller and bound it to one job per bridge. */
export function usageCommand(collect: (days: string) => Promise<string>, send: (text: string) => Promise<void>) {
  let busy = false
  return async (args: string): Promise<void> => {
    const days = args.trim() || '7'
    if (!['1', '7', '30'].includes(days)) {
      await send('Выбери период в днях: /usage 1, /usage 7 или /usage 30.')
      return
    }
    if (busy) {
      await send('Отчёт о расходе уже собирается.')
      return
    }
    busy = true
    try {
      let report: string
      try {
        report = await collect(days)
      } catch {
        await send('Не удалось собрать расход Codex. Проверь доступ к локальным журналам и наличие Python 3.')
        return
      }
      for (const part of splitPlainMessage(report)) await send(part)
    } finally {
      busy = false
    }
  }
}
