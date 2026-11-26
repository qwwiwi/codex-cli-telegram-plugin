import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

// The /doctor Telegram command: the doctor script's self-check plus a comparison of the installed
// bridge with its GitHub repository. Read-only: it never edits files, it only fetches the remote.

export interface DoctorCheck { status: 'ok' | 'warning' | 'error'; message: string }
export interface DoctorProblem { text: string; fix?: string }
export interface DoctorReport { problems: DoctorProblem[]; commit?: string; upstream?: string; codexVersion?: string }

// docs/codex-known-problems.md (row 5): the documentation states no minimum Codex CLI version yet,
// so the default compares nothing; a caller passes one once the docs name it.
const documentedMinimumCodexVersion: string | undefined = undefined

const doctorLabels: Record<string, DoctorCheck['status']> = { OK: 'ok', 'ВНИМАНИЕ': 'warning', 'ОШИБКА': 'error' }
const refName = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const secretSegment = /^(?:\.?secrets?|\.env.*|.*\.env|.*\.(?:key|pem|p12|pfx)|credentials.*|id_(?:rsa|ed25519|ecdsa|dsa).*)$/i
const listedFiles = 10

const LockSchema = z.object({
  workspaces: z.record(z.object({
    dependencies: z.record(z.string()).optional(),
    devDependencies: z.record(z.string()).optional(),
  }).passthrough()).optional(),
  packages: z.record(z.array(z.unknown())),
}).passthrough()

// Only what a child needs to find its tools and its login; never the bot or policy credentials.
function safeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && /^(PATH|HOME|USER|LOGNAME|LANG|LC_\w+|TMPDIR|XDG_RUNTIME_DIR|SSH_AUTH_SOCK|CODEX_HOME)$/.test(name)) {
      env[name] = value
    }
  }
  return { ...env, ...extra }
}

async function run(command: string[], cwd: string, timeout: number, env: Record<string, string | undefined>):
  Promise<{ code: number; stdout: string }> {
  try {
    const child = Bun.spawn(command, {
      cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout, killSignal: 'SIGKILL',
    })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { code, stdout }
  } catch {
    return { code: -1, stdout: '' }
  }
}

function commits(count: number): string {
  const tens = count % 100
  const ones = count % 10
  if (tens >= 11 && tens <= 14) return count + ' коммитов'
  if (ones === 1) return count + ' коммит'
  if (ones >= 2 && ones <= 4) return count + ' коммита'
  return count + ' коммитов'
}

/** Runs plugin/scripts/doctor.ts as a child (it blocks while probing Codex) and parses its lines. */
export async function runDoctorScript(script: string, env: Record<string, string | undefined>): Promise<DoctorCheck[]> {
  const { stdout } = await run([process.execPath, script], dirname(script), 90_000, env)
  const checks: DoctorCheck[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\[([^\]]+)\] (.+)$/.exec(line.trim())
    const status = match ? doctorLabels[match[1]!] : undefined
    if (status) checks.push({ status, message: match![2]! })
  }
  return checks.length ? checks : [{
    status: 'error', message: 'Самопроверка doctor не запустилась. Выполните на сервере в папке plugin: bun run doctor.',
  }]
}

async function localCodexVersion(): Promise<string | undefined> {
  const codex = Bun.which('codex')
  if (!codex) return undefined
  const { code, stdout } = await run([codex, '--version'], process.cwd(), 10_000, safeEnv())
  return code === 0 ? /\d+\.\d+\.\d+[\w.+-]*/.exec(stdout)?.[0] : undefined
}

function olderThan(version: string, minimum: string): boolean {
  const parse = (value: string) => value.split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
  const [a, b] = [parse(version), parse(minimum)]
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) < (b[index] ?? 0)
  }
  return false
}

/** Compares plugin/bun.lock with the installed plugin/node_modules. */
export function dependencyDrift(plugin: string): DoctorProblem | undefined {
  const lockPath = join(plugin, 'bun.lock')
  if (!existsSync(lockPath)) return undefined
  const fix = 'В папке plugin выполните bun install --frozen-lockfile, затем перезапустите мост, когда бот свободен.'
  let lock: z.infer<typeof LockSchema>
  try {
    // bun.lock is JSON with trailing commas.
    lock = LockSchema.parse(JSON.parse(readFileSync(lockPath, 'utf8').replace(/,(\s*[}\]])/g, '$1')))
  } catch {
    return { text: 'Не удалось прочитать plugin/bun.lock.', fix: 'Верните файл к версии GitHub: git checkout -- plugin/bun.lock.' }
  }
  if (!existsSync(join(plugin, 'node_modules'))) return { text: 'Зависимости моста не установлены (нет plugin/node_modules).', fix }
  const root = lock.workspaces?.['']
  const direct = new Set(Object.keys({ ...root?.dependencies, ...root?.devDependencies }))
  const drift: string[] = []
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name.split('/').length > (name.startsWith('@') ? 2 : 1)) continue
    const spec = typeof entry[0] === 'string' ? entry[0] : ''
    const version = spec.slice(spec.lastIndexOf('@') + 1)
    if (!/^\d/.test(version)) continue
    let installed: unknown
    try {
      installed = (JSON.parse(readFileSync(join(plugin, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }).version
    } catch { installed = undefined }
    if (installed === undefined ? direct.has(name) : installed !== version) drift.push(name)
  }
  if (!drift.length) return undefined
  const names = drift.slice(0, listedFiles).join(', ') + (drift.length > listedFiles ? ` и ещё ${drift.length - listedFiles}` : '')
  return { text: `Установленные зависимости не совпадают с plugin/bun.lock: ${names}.`, fix }
}

function localEdits(porcelain: string): DoctorProblem | undefined {
  const entries = porcelain.split('\0')
  const names: string[] = []
  let hidden = 0
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.length < 4) continue
    if (/[RC]/.test(entry.slice(0, 2))) index++
    const path = entry.slice(3)
    if (path.split('/').filter(Boolean).some(segment => secretSegment.test(segment))) hidden++
    else names.push(path)
  }
  if (!names.length && !hidden) return undefined
  const shown = names.slice(0, listedFiles)
  const parts = [...shown]
  if (names.length > shown.length) parts.push(`ещё ${names.length - shown.length}`)
  if (hidden) parts.push(`${hidden} файл(ов) с секретами — имена скрыты`)
  return {
    text: `В копии моста есть локальные правки: ${parts.join(', ')}.`,
    fix: './update.sh не обновит копию с правками. Сохраните нужные изменения в отдельной ветке или верните файл командой git checkout -- <файл>.',
  }
}

export interface DoctorOptions {
  /** Root of the bridge checkout (the folder with update.sh and plugin/). */
  repo: string
  /** Read for KROT_UPDATE_REMOTE and KROT_UPDATE_BRANCH only. */
  env: Record<string, string | undefined>
  doctor: () => Promise<DoctorCheck[]>
  codexVersion?: () => Promise<string | undefined>
  minimumCodexVersion?: string
}

async function compareWithGitHub(repo: string, env: DoctorOptions['env'], report: DoctorReport): Promise<void> {
  const gitEnv = safeEnv({ GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' })
  const git = (args: string[], timeout = 15_000) => run(['git', ...args], repo, timeout, gitEnv)
  const head = await git(['rev-parse', '--short', 'HEAD'])
  if (head.code !== 0) {
    report.problems.push({
      text: 'Папка моста не является git-копией, сравнить её с GitHub нельзя.',
      fix: 'Установите мост через git clone по README, чтобы работали ./update.sh и /doctor.',
    })
    return
  }
  report.commit = head.stdout.trim()
  const remotes = (await git(['remote'])).stdout.split('\n').map(line => line.trim())
  const remote = env.KROT_UPDATE_REMOTE?.trim() || (remotes.includes('public') ? 'public' : 'origin')
  const branch = env.KROT_UPDATE_BRANCH?.trim() || 'main'
  if (!refName.test(remote) || !refName.test(branch)) {
    report.problems.push({
      text: 'KROT_UPDATE_REMOTE или KROT_UPDATE_BRANCH содержит недопустимое имя.',
      fix: 'Укажите имя remote (например public) и ветки (например main) в plugin/.env.',
    })
    return
  }
  const source = `${remote}/${branch}`
  const fetched = await git(['fetch', '--quiet', '--no-tags', '--', remote, branch], 30_000)
  const counts = fetched.code === 0 ? await git(['rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD']) : undefined
  const match = counts?.code === 0 ? /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim()) : null
  if (!match) {
    // The remote URL may carry credentials: name the remote, never its URL or git's message.
    report.problems.push({
      text: `Не удалось получить версию моста с GitHub (${source}).`,
      fix: 'Проверьте интернет и доступ к репозиторию, затем повторите /doctor. Источник задают KROT_UPDATE_REMOTE и KROT_UPDATE_BRANCH.',
    })
    return
  }
  report.upstream = source
  const [ahead, behind] = [Number(match[1]), Number(match[2])]
  if (behind > 0) {
    report.problems.push({
      text: `Мост отстаёт от GitHub на ${commits(behind)} (${source}).`,
      fix: 'В папке моста выполните ./update.sh --dry-run, затем ./update.sh. Перезапустите мост, когда бот свободен.',
    })
  }
  if (ahead > 0) {
    report.problems.push({
      text: `В копии моста есть ${commits(ahead)}, которых нет на GitHub (${source}).`,
      fix: './update.sh обновляет только fast-forward: перенесите эти коммиты в отдельную ветку или верните копию к версии GitHub.',
    })
  }
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
  const edits = status.code === 0 ? localEdits(status.stdout) : undefined
  if (edits) report.problems.push(edits)
}

/** Collects the doctor checks and the GitHub comparison. Never throws on a failed probe. */
export async function collectDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const report: DoctorReport = { problems: [] }
  for (const check of await options.doctor()) {
    if (check.status !== 'ok') report.problems.push({ text: check.message })
  }
  await compareWithGitHub(options.repo, options.env, report)
  const drift = dependencyDrift(join(options.repo, 'plugin'))
  if (drift) report.problems.push(drift)
  const version = await (options.codexVersion ?? localCodexVersion)().catch(() => undefined)
  if (version) report.codexVersion = version
  const minimum = options.minimumCodexVersion ?? documentedMinimumCodexVersion
  if (version && minimum && olderThan(version, minimum)) {
    report.problems.push({
      text: `Codex CLI ${version} старее минимальной версии ${minimum}.`,
      fix: 'Обновите Codex CLI по официальной инструкции от пользователя службы и проверьте codex --version.',
    })
  }
  return report
}

export function formatDoctorReport(report: DoctorReport): string {
  const facts = [
    report.commit ? `Версия моста: ${report.commit}` + (report.upstream ? ` (сравнение с ${report.upstream}).` : '.') : '',
    report.codexVersion ? `Codex CLI: ${report.codexVersion}.` : '',
  ].filter(Boolean)
  if (!report.problems.length) return ['🩺 Доктор: всё в порядке.', ...facts].join('\n')
  return [
    `🩺 Доктор нашёл проблемы: ${report.problems.length}.`, '',
    ...report.problems.map((problem, index) =>
      `${index + 1}. ${problem.text}` + (problem.fix ? `\n   Как исправить: ${problem.fix}` : '')),
    ...(facts.length ? ['', ...facts] : []),
  ].join('\n')
}

/** The owner turn /doctor fix hands to Codex. */
export function doctorFixTurn(report: DoctorReport, repo: string, selfRestart: boolean): string {
  return [
    'Владелец отправил /doctor fix. Ниже отчёт самопроверки Telegram-моста.',
    formatDoctorReport(report),
    [
      'Исправь то, что безопасно исправить в своей рабочей папке и своей конфигурации.',
      'Не выводи и не пересылай токены, ключи, пароли и содержимое .env; называй только имена переменных и файлов.',
      'Перед правкой любого конфигурационного файла сделай его резервную копию рядом с ним и назови её в ответе.',
      `Код моста в папке ${repo} сам не обновляй: дай владельцу точные шаги, например cd ${repo} && ./update.sh --dry-run, затем ./update.sh.`,
      'Не перезапускай мост и его службу в этом ходе: перезапуск оборвёт текущий ход, и ответ не дойдёт.',
      selfRestart
        ? 'Если после исправлений нужен перезапуск, в конце ответа попроси владельца отправить отдельным сообщением «Перезапусти мост»: мост доставит ответ и перезапустится, когда очередь освободится.'
        : 'Если после исправлений нужен перезапуск, в конце ответа попроси владельца, когда бот свободен, выполнить на сервере systemctl --user restart krotov-telegram.service.',
      'В ответе перечисли, что исправлено, что осталось и что должен сделать владелец.',
    ].join(' '),
  ].join('\n\n')
}

interface DoctorCommandHooks {
  collect: () => Promise<DoctorReport>
  send: (text: string) => Promise<unknown>
  /** Root of the bridge checkout, named in the /doctor fix turn. */
  repo: string
  /** KROT_CODEX_SELF_RESTART: the owner can ask the bridge to restart after the reply. */
  selfRestart: boolean
}

export class DoctorCommand {
  private running = false

  constructor(private hooks: DoctorCommandHooks) {}

  /** `/doctor` reports; `/doctor fix` also hands the report to Codex through enqueueTurn. */
  async handle(args: string, enqueueTurn: (text: string) => Promise<unknown>): Promise<void> {
    const mode = args.trim().toLowerCase()
    if (mode && mode !== 'fix') {
      await this.hooks.send('Используйте /doctor или /doctor fix.')
      return
    }
    if (this.running) {
      await this.hooks.send('Самопроверка уже идёт. Дождитесь отчёта.')
      return
    }
    this.running = true
    try {
      await this.hooks.send('Запускаю самопроверку и сравниваю мост с GitHub. Это займёт до минуты.')
      let report: DoctorReport
      try {
        report = await this.hooks.collect()
      } catch {
        await this.hooks.send('Не удалось выполнить самопроверку. Запустите на сервере в папке plugin: bun run doctor.')
        return
      }
      const text = formatDoctorReport(report)
      if (!report.problems.length) {
        await this.hooks.send(text + (mode === 'fix' ? '\n\nИсправлять нечего.' : ''))
        return
      }
      if (mode !== 'fix') {
        await this.hooks.send(text + '\n\nЧтобы агент исправил то, что можно исправить безопасно, отправьте /doctor fix.')
        return
      }
      await this.hooks.send(text + '\n\nПередаю отчёт агенту для исправления.')
      try {
        await enqueueTurn(doctorFixTurn(report, this.hooks.repo, this.hooks.selfRestart))
      } catch {
        await this.hooks.send('Не удалось передать отчёт агенту. Отправьте /doctor fix ещё раз.')
      }
    } finally {
      this.running = false
    }
  }
}
