import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { loadConfig, type RuntimeEnv, RuntimeEnvSchema } from '../src/config.js'
import { type ApprovalSetup, resolveApprovalSetup } from '../src/codex/approval-mode.js'
import { ackReactionMode, parseReactionPalette } from '../src/codex/reactions.js'
import { OWNER_INSTRUCTIONS_CHECK_PREFIX, ownerInstructionChecks, ownerInstructionsHome } from '../src/codex/owner-instructions-lock.js'
import { CodexRpc, object } from '../src/codex/rpc.js'
import { bridgeUnitName, unitDrift } from '../src/codex/unit-contract.js'
import { checkHooksPack, defaultPaths, listedHooks, managedCheck, rulesetCheck, type Check, type ListedHook } from '../../codex-hooks/src/install.js'
import type { Runner } from '../../codex-hooks/src/types.js'

// A missing executable or other spawn failure is handled like a failed ruleset probe.
const spawnRun: Runner = (argv, options) => {
  try {
    const result = Bun.spawnSync([...argv], { ...(options.cwd ? { cwd: options.cwd } : {}), stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: options.timeoutMs })
    return { code: result.exitCode, stdout: result.stdout.toString() }
  } catch {
    return { code: null, stdout: '' }
  }
}

type TelegramMethod = 'getMe' | 'getWebhookInfo'
type Probes = {
  checkCodex: (env: NodeJS.ProcessEnv, workspace?: string) => Check | Promise<Check>
  telegram: (method: TelegramMethod, token: string) => Promise<Record<string, unknown> | null>
  // Overrides the installed user unit lookup; returns undefined when there is no unit.
  unitFile?: (env: NodeJS.ProcessEnv) => string | undefined
  // Hooks as Codex lists them (App Server hooks/list, trust included); used only with KROT_CODEX_HOOKS=1.
  listHooks?: (env: NodeJS.ProcessEnv, workspace: string) => Promise<ListedHook[]>
  // Whether the managed (root-owned) guards are installed; default reads /etc/codex.
  managedCheck?: () => Check
  // Lock status for owner instruction files in the resolved Codex home.
  ownerInstructionChecks?: (codexHome: string) => Check[]
}

function readUnitFile(env: NodeJS.ProcessEnv): string | undefined {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : undefined)
  if (!base) return
  const path = join(base, 'systemd', 'user', bridgeUnitName(env.KROT_CODEX_SERVICE_NAME))
  if (!existsSync(path)) return
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return
  }
}

// Restart-loop protection of an existing unit: install.sh keeps a changed unit, so drift is reported here.
function unitCheck(text: string, unitName: string): Check {
  const missing = unitDrift(text, unitName)
  return missing.length === 0
    ? { status: 'ok', message: `Служба ${unitName} защищена от бесконечных перезапусков.` }
    : { status: 'warning', message: `Служба ${unitName} без защиты от бесконечных перезапусков. Добавьте строки из examples/krotov-telegram.service: ${missing.join(', ')}; затем systemctl --user daemon-reload.` }
}

function directory(path: string | undefined, writable = true): string | undefined {
  if (!path || !isAbsolute(path)) return
  try {
    if (!statSync(path).isDirectory()) return
    accessSync(path, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0))
    return realpathSync(path)
  } catch {
    return
  }
}

function codexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TMPDIR|TEMP|TMP|CODEX_HOME|USERPROFILE|LOCALAPPDATA|APPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i.test(name),
  ))
}

export async function probeProxy(workspace: string, env: NodeJS.ProcessEnv, command: readonly [string, ...string[]]): Promise<Check> {
  const rpc = new CodexRpc(workspace, codexEnv(env), () => undefined, () => undefined, command)
  const timer = setTimeout(() => rpc.close(), 8000)
  try {
    await rpc.initialize()
    const login = await rpc.request('account/read', { refreshToken: false })
    return object(login.account).type === 'chatgpt'
      ? { status: 'ok', message: 'Прокси подключается к App Server. На сервере выполнен вход через ChatGPT.' }
      : { status: 'error', message: 'Прокси подключается, но в App Server нужен вход через ChatGPT.' }
  } catch {
    return { status: 'error', message: 'Прокси не подключился к App Server. Проверьте sudo -n и статус службы.' }
  } finally { clearTimeout(timer); rpc.close() }
}

/** R38 (/doctor tests): starts a separate App Server, completes its initialize handshake and closes it. */
export async function codexHandshake(env: NodeJS.ProcessEnv, workspace: string,
  command: readonly [string, ...string[]] = ['codex', 'app-server', '--listen', 'stdio://']): Promise<void> {
  const rpc = new CodexRpc(workspace, codexEnv(env), () => undefined, () => undefined, command)
  const timer = setTimeout(() => rpc.close(), 8000)
  try {
    await rpc.initialize()
  } finally { clearTimeout(timer); rpc.close() }
}

export async function listHooksViaAppServer(env: NodeJS.ProcessEnv, workspace: string): Promise<ListedHook[]> {
  const rpc = new CodexRpc(workspace, codexEnv(env), () => undefined, () => undefined)
  const timer = setTimeout(() => rpc.close(), 8000)
  try {
    await rpc.initialize()
    return listedHooks(await rpc.request('hooks/list', {}))
  } finally { clearTimeout(timer); rpc.close() }
}

export async function checkCodex(env: NodeJS.ProcessEnv, workspace?: string,
  probe: typeof probeProxy = probeProxy): Promise<Check> {
  if (env.KROT_CODEX_PROXY) {
    if (env.KROT_CODEX_APPROVALS !== '1' || !isAbsolute(env.KROT_CODEX_PROXY) ||
        !Bun.which(env.KROT_CODEX_PROXY)) {
      return { status: 'error', message: 'KROT_CODEX_PROXY требует абсолютный путь к исполняемому файлу и KROT_CODEX_APPROVALS=1.' }
    }
    // Startup refuses the proxy without approval cards: resolve the mode the bridge will run with.
    let cards = false
    try {
      cards = resolveApprovalSetup({
        KROT_CODEX_APPROVALS: env.KROT_CODEX_APPROVALS,
        KROT_CODEX_APPROVAL_MODE: env.KROT_CODEX_APPROVAL_MODE,
      }).cards
    } catch { /* risky without KROT_CODEX_APPROVALS=1: startup fails, so no cards either. */ }
    if (!cards) {
      return { status: 'error', message: 'KROT_CODEX_PROXY работает только с карточками подтверждения: режим never с прокси мост не запустит. Укажите KROT_CODEX_APPROVAL_MODE=standard или risky.' }
    }
    if (!workspace) return { status: 'error', message: 'Нужна доступная рабочая папка для проверки прокси.' }
    return probe(workspace, env, ['/usr/bin/sudo', '-n', '--', env.KROT_CODEX_PROXY])
  }
  const codex = Bun.which('codex')
  if (!codex) return { status: 'error', message: 'Codex CLI не найден в PATH. Установите его и проверьте codex --version.' }
  // The CLI needs its normal login environment, but never the bot credentials.
  const cliEnv = codexEnv(env)
  try {
    const options = { env: cliEnv, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 10_000 } as const
    if (Bun.spawnSync([codex, 'app-server', '--help'], options).exitCode !== 0) {
      return { status: 'error', message: 'Codex app-server недоступен. Обновите Codex CLI и проверьте codex app-server --help.' }
    }
    const login = Bun.spawnSync([codex, 'login', 'status'], options)
    if (login.exitCode === 0 && /ChatGPT/i.test(login.stdout.toString() + login.stderr.toString())) {
      return { status: 'ok', message: 'Codex App Server доступен, CLI сообщает о входе через ChatGPT.' }
    }
    return { status: 'error', message: 'Нужен вход через ChatGPT от пользователя службы. Выполните codex login --device-auth и codex login status.' }
  } catch {
    return { status: 'error', message: 'Не удалось запустить Codex CLI. Проверьте codex --version и права на исполняемый файл.' }
  }
}

async function telegram(method: TelegramMethod, token: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) return null
  const data = await response.json() as { ok?: boolean; result?: Record<string, unknown> }
  return data.ok ? data.result ?? null : null
}

// The reaction settings; the schema has already validated both, so this only reports them.
function reactionCheck(env: RuntimeEnv): Check {
  const ack = ackReactionMode(env) === 'off'
    ? 'автоматической 👀 на входящие нет (KROT_ACK_REACTION=off)'
    : 'мост ставит 👀 на каждое входящее (KROT_ACK_REACTION=eyes)'
  return { status: 'ok', message: `Реакции: ${ack}; агент сам выбирает из палитры ${parseReactionPalette(env.KROT_REACTION_PALETTE).join(' ')}.` }
}

// The approval mode the bridge will run with, as resolveApprovalSetup decides it.
function approvalModeChecks(env: NodeJS.ProcessEnv, codexHome: string): Check[] {
  let setup: ApprovalSetup
  try {
    setup = resolveApprovalSetup({
      KROT_CODEX_APPROVALS: env.KROT_CODEX_APPROVALS,
      KROT_CODEX_APPROVAL_MODE: env.KROT_CODEX_APPROVAL_MODE,
    })
  } catch {
    return [{ status: 'error', message: 'Для KROT_CODEX_APPROVAL_MODE=risky укажите KROT_CODEX_APPROVALS=1 в plugin/.env.' }]
  }
  if (!setup.cards) {
    const mode: Check = { status: 'ok', message: 'Режим подтверждений: never. Агент работает автономно, без карточек подтверждения; действия, которым нужно подтверждение, не выполняются.' }
    return env.KROT_CODEX_PROXY ? [mode] : [mode, ...httpMcpApprovalWarnings(codexHome)]
  }
  return [setup.risky
    ? { status: 'ok', message: 'Режим подтверждений: risky. Карточки приходят только для рискованных и неясных действий.' }
    : { status: 'ok', message: 'Режим подтверждений: standard. Codex присылает карточку перед действием за пределами песочницы.' }]
}

function httpMcpApprovalWarnings(codexHome: string): Check[] {
  let config: unknown
  try {
    config = Bun.TOML.parse(readFileSync(join(codexHome, 'config.toml'), 'utf8'))
  } catch {
    return []
  }
  const checks: Check[] = []
  for (const [name, entry] of Object.entries(object(object(config).mcp_servers))) {
    const server = object(entry)
    if (typeof server.url === 'string' && server.url && server.enabled !== false &&
        server.default_tools_approval_mode !== 'approve') {
      checks.push({ status: 'warning', message: `HTTP MCP-сервер ${JSON.stringify(name)}: при выключенных подтверждениях задайте default_tools_approval_mode = "approve" в config.toml для этого сервера.` })
    }
  }
  return checks
}

export async function runDoctor(
  env: NodeJS.ProcessEnv,
  probes: Probes = { checkCodex, telegram },
): Promise<Check[]> {
  const checks: Check[] = []
  const report = (passed: boolean, success: string, failure: string) => {
    checks.push(passed ? { status: 'ok', message: success } : { status: 'error', message: failure })
  }
  if (process.getuid?.() === 0) {
    checks.push({ status: 'error', message: 'Запустите doctor от того же непривилегированного пользователя, что и мост.' })
  }
  const unit = (probes.unitFile ?? readUnitFile)(env)
  if (unit !== undefined) checks.push(unitCheck(unit, bridgeUnitName(env.KROT_CODEX_SERVICE_NAME)))

  const parsed = RuntimeEnvSchema.safeParse(env)
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))]
    checks.push({ status: 'error', message: `Проверьте переменные в plugin/.env: ${fields.join(', ')}.` })
  }
  let config: ReturnType<typeof loadConfig> | undefined
  if (parsed.success) {
    try {
      config = loadConfig(env)
    } catch {
      checks.push({ status: 'error', message: 'Проверьте JSON и права чтения для TELEGRAM_CONFIG_FILE или config.json в папке состояния.' })
    }
  }
  if (config) {
    checks.push(config.status.thoughts?.enabled
      ? { status: 'ok', message: 'Мысли агента в карточке работы: включены; секреты, токены и пути в них скрываются.' }
      : { status: 'ok', message: 'Мысли агента в карточке работы: выключены. Включить: TELEGRAM_STATUS_THOUGHTS=1 в plugin/.env.' })
  }
  const ownerId = env.TELEGRAM_ALLOWED_USER_IDS?.trim()
  report(Boolean(ownerId && /^[1-9]\d*$/.test(ownerId)
      && ownerId === env.TELEGRAM_ALLOWED_CHAT_IDS?.trim()
      && ownerId === String(config?.allowed_user_ids[0])
      && ownerId === String(config?.allowed_chat_ids[0])),
    'Указан один владелец, ID личного чата совпадает.',
    'Укажите один и тот же числовой ID владельца в TELEGRAM_ALLOWED_USER_IDS и TELEGRAM_ALLOWED_CHAT_IDS.')

  const workspace = directory(config?.workspace_root, !env.KROT_CODEX_PROXY)
  const codexHome = ownerInstructionsHome(env, workspace)
  if (parsed.success) checks.push(...approvalModeChecks(env, codexHome), reactionCheck(parsed.data))
  if (env.KROT_CODEX_PROXY) {
    checks.push({ status: 'info', message: `${OWNER_INSTRUCTIONS_CHECK_PREFIX}lock check does not apply in proxy mode` })
  } else {
    checks.push(...(probes.ownerInstructionChecks ?? ownerInstructionChecks)(codexHome))
  }
  const state = directory(env.TELEGRAM_STATE_DIR)
  report(Boolean(workspace), env.KROT_CODEX_PROXY ? 'Рабочая папка доступна мосту на чтение.' : 'Рабочая папка доступна на запись.',
    'Создайте рабочую папку по абсолютному пути TELEGRAM_WORKSPACE_ROOT и проверьте права.')
  report(Boolean(state), 'Папка состояния доступна на запись.',
    'Создайте приватную папку по абсолютному пути TELEGRAM_STATE_DIR и проверьте права.')
  if (workspace && state) {
    const path = relative(workspace, state)
    report(isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`),
      'Папка состояния находится за пределами рабочей папки.',
      'TELEGRAM_STATE_DIR должен находиться за пределами TELEGRAM_WORKSPACE_ROOT.')
  }
  checks.push(await probes.checkCodex(env, workspace))
  // Set by the bridge when it refused danger-full-access at startup (plugin/src/codex/full-access.ts).
  if (env.KROT_CODEX_SANDBOX_FALLBACK) {
    checks.push({ status: 'error', message: `Полный доступ (KROT_CODEX_SANDBOX=danger-full-access) отключён при запуске моста: ${env.KROT_CODEX_SANDBOX_FALLBACK}. Агент работает в песочнице workspace-write. Запустите ./install.sh --hooks --full-access и перезапустите мост.` })
  }
  if (env.KROT_CODEX_HOOKS === '1') {
    const list = probes.listHooks ?? listHooksViaAppServer
    checks.push(...await checkHooksPack(defaultPaths(env),
      () => workspace ? list(env, workspace) : Promise.reject(new Error('no workspace'))))
    // main is protected by GitHub, not by the hooks: warn when the workspace repo has no ruleset.
    checks.push((probes.managedCheck ?? managedCheck)())
    const ruleset = workspace ? rulesetCheck(spawnRun, workspace) : undefined
    if (ruleset) checks.push(ruleset)
  }

  const token = env.TELEGRAM_BOT_TOKEN
  if (!token || !/^\d+:[\w-]+$/.test(token)) {
    checks.push({ status: 'error', message: 'Укажите токен BotFather в TELEGRAM_BOT_TOKEN.' })
    return checks
  }
  const expectedBotId = parsed.success ? parsed.data.TELEGRAM_EXPECTED_BOT_ID : undefined
  if (!expectedBotId) {
    checks.push({ status: 'error', message: 'Укажите числовой TELEGRAM_EXPECTED_BOT_ID из getMe.' })
  }
  try {
    const bot = await probes.telegram('getMe', token)
    if (typeof bot?.id !== 'number') {
      checks.push({ status: 'error', message: 'Telegram отклонил getMe. Проверьте токен BotFather.' })
      return checks
    }
    report(bot.id === expectedBotId, 'Токен действителен и принадлежит указанному боту.',
      'Токен действителен, но ID бота отличается от TELEGRAM_EXPECTED_BOT_ID. Проверьте пару токен/ID.')
  } catch {
    checks.push({ status: 'error', message: 'Не удалось выполнить getMe. Проверьте DNS и HTTPS-доступ к api.telegram.org.' })
    return checks
  }
  try {
    const webhook = await probes.telegram('getWebhookInfo', token)
    report(webhook?.url === '', 'Telegram webhook отключён, можно использовать polling.',
      'Telegram webhook включён или его статус недоступен. Проверьте getWebhookInfo перед запуском.')
  } catch {
    checks.push({ status: 'error', message: 'Не удалось проверить Telegram webhook. Проверьте сеть и повторите doctor.' })
  }
  return checks
}

export function printDoctorChecks(checks: readonly Check[], log = console.log): number {
  const labels = { ok: 'OK', info: 'ИНФО', warning: 'ВНИМАНИЕ', error: 'ОШИБКА' }
  for (const check of checks) log(`[${labels[check.status]}] ${check.message}`)
  const errors = checks.filter(check => check.status === 'error').length
  log(errors ? `Ошибок: ${errors}. Исправьте их и запустите doctor ещё раз.` : 'Проверка пройдена. Первый ответ проверьте в личном чате бота.')
  return checks.some(check => check.status === 'error' && check.blocking !== false) ? 1 : 0
}

if (import.meta.main) {
  process.exitCode = printDoctorChecks(await runDoctor(process.env))
}
