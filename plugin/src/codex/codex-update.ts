// /update codex: updates the Codex CLI the bridge runs as its App Server.
//
// Installed vs latest (`codex --version`, `npm view @openai/codex version`), the changelog of
// the versions in between (the OpenAI docs changelog, then the GitHub release notes, then a
// link), then `npm install -g --prefix <stage> @openai/codex@<latest>` into a staging prefix next
// to the user prefix. The staged binary must pass an App Server handshake and answer model/list;
// only then is it switched in, and the previous package is kept for /update codex rollback. The
// active Codex is never a half-written install. The caller then restarts the bridge (exit 75): the bridge's App Server is a
// child that cannot be swapped under a running session, and model/list is read live on every
// /cc → Модель, so the new models show as soon as the bridge is back.
// Network access goes through the injected fetchText, so tests never touch the network.
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import { CodexRpc, object } from './rpc.js'
import { updateChildEnv, type Runner } from './self-update.js'

export const CHANGELOG_URL = 'https://developers.openai.com/codex/changelog.md'
export const RELEASES_URL = 'https://api.github.com/repos/openai/codex/releases?per_page=30'
const CHANGELOG_PAGE = 'https://developers.openai.com/codex/changelog'
const PACKAGE = '@openai/codex'
const versionPattern = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/
const maxSection = 700
const maxChangelog = 2500

/** Semver order; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const left = versionPattern.exec(a)
  const right = versionPattern.exec(b)
  if (!left || !right) return a.localeCompare(b)
  for (let i = 1; i <= 3; i++) {
    const diff = Number(left[i]) - Number(right[i])
    if (diff !== 0) return diff
  }
  if (left[4] === right[4]) return 0
  if (left[4] === undefined) return 1
  if (right[4] === undefined) return -1
  return left[4].localeCompare(right[4], 'en', { numeric: true })
}

function versionOf(text: string): string | undefined {
  return versionPattern.exec(text)?.[0]
}

function clip(text: string, chars: number): string {
  const clean = text.trim()
  return clean.length > chars ? clean.slice(0, chars - 1).trimEnd() + '…' : clean
}

function joinSections(sections: readonly { version: string; text: string }[]): string | undefined {
  if (sections.length === 0) return
  return clip(sections.map(section => clip(section.text, maxSection)).join('\n\n'), maxChangelog)
}

const inRange = (version: string, installed: string, latest: string) =>
  compareVersions(version, installed) > 0 && compareVersions(version, latest) <= 0

/**
 * The parts of a Markdown changelog for versions after `installed` up to `latest`. A section
 * starts at a heading; its version is the first one in the heading or in its first lines.
 */
export function changelogSince(markdown: string, installed: string, latest: string): string | undefined {
  const sections: { version: string; text: string }[] = []
  let current: string[] | undefined
  const flush = () => {
    if (!current) return
    const version = versionOf(current[0]!) ?? versionOf(current.slice(1).filter(line => line.trim()).slice(0, 3).join('\n'))
    if (version && inRange(version, installed, latest)) sections.push({ version, text: current.join('\n') })
  }
  for (const line of markdown.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      flush()
      current = [line]
    } else current?.push(line)
  }
  flush()
  return joinSections(sections)
}

/** The GitHub release notes (JSON of the releases API) for the versions in range. */
export function releaseNotesSince(json: string, installed: string, latest: string): string | undefined {
  let releases: unknown
  try { releases = JSON.parse(json) } catch { return }
  if (!Array.isArray(releases)) return
  const sections = releases.flatMap(raw => {
    if (typeof raw !== 'object' || raw === null) return []
    const release = raw as Record<string, unknown>
    const version = versionOf(typeof release.tag_name === 'string' ? release.tag_name : '')
    if (!version || !inRange(version, installed, latest)) return []
    return [{ version, text: '## ' + version + '\n' + (typeof release.body === 'string' ? release.body : '') }]
  })
  return joinSections(sections)
}

/** An App Server handshake plus model/list with the given codex binary. */
export type CodexProbe = (codex: string) => Promise<{ ok: true; models: string[] } | { ok: false; detail: string }>

/**
 * The staged-binary probe: a separate short-lived App Server of that binary, handshake plus model/list.
 * It runs code /update codex has just downloaded, before anything switched to it, so it gets the same
 * credential-free environment as every other /update child (updateChildEnv): no GBRAIN_BEARER, no token.
 */
export function stagedCodexProbe(cwd: string, env: NodeJS.ProcessEnv = process.env): CodexProbe {
  return async codexBin => {
    const rpc = new CodexRpc(cwd, updateChildEnv(env),() => undefined, () => undefined, [codexBin, 'app-server', '--listen', 'stdio://'])
    try {
      await rpc.initialize()
      const reply = await rpc.request('model/list', { limit: 100, includeHidden: false })
      const models = Array.isArray(reply.data)
        ? reply.data.map(object).flatMap(item => typeof item.model === 'string' ? [item.model] : []) : []
      return { ok: true, models }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'App Server did not answer' }
    } finally {
      rpc.close()
    }
  }
}

export interface CodexUpdateOptions {
  run: Runner
  /** GET a URL as text; undefined when it fails. */
  fetchText: (url: string) => Promise<string | undefined>
  /** An App Server handshake plus model/list with the staged binary. */
  probe: CodexProbe
  home: string
  /** The bridge state directory: <state>/codex-update.json records every step on disk. */
  stateDir: string
  /** The codex binary the bridge runs (from PATH). */
  codexPath: () => string | undefined
}

export type CodexCheck =
  | { kind: 'newer'; installed: string; latest: string; changelog: string; prefix: string }
  | { kind: 'current'; installed: string; latest: string }
  | { kind: 'refused'; text: string }

export type CodexApply =
  | { ok: true; from: string; to: string; models: string[] }
  | { ok: false; stage: 'install' | 'version' | 'handshake'; detail: string; restored: boolean }

/** The npm prefix of an `npm install -g` of codex, when it lies inside the home directory. */
function userPrefix(path: string, home: string): string | undefined {
  const prefix = dirname(dirname(path))
  try {
    if (!realpathSync(prefix).startsWith(realpathSync(home) + sep)) return
  } catch {
    return
  }
  return existsSync(join(prefix, 'lib', 'node_modules', '@openai', 'codex')) ? prefix : undefined
}

export class CodexUpdate {
  private busy = false

  constructor(private readonly options: CodexUpdateOptions) {}

  private async installedVersion(codex: string): Promise<string | undefined> {
    const result = await this.options.run(codex, ['--version'], { cwd: this.options.home, timeoutMs: 30_000 })
    return result.code === 0 ? versionOf(result.stdout) : undefined
  }

  private async changelog(installed: string, latest: string): Promise<string> {
    const docs = await this.options.fetchText(CHANGELOG_URL).catch(() => undefined)
    const fromDocs = docs ? changelogSince(docs, installed, latest) : undefined
    if (fromDocs) return fromDocs
    const releases = await this.options.fetchText(RELEASES_URL).catch(() => undefined)
    const fromReleases = releases ? releaseNotesSince(releases, installed, latest) : undefined
    return fromReleases ?? 'Список изменений сейчас не загрузился. Он здесь: ' + CHANGELOG_PAGE
  }

  async check(): Promise<CodexCheck> {
    const codex = this.options.codexPath()
    if (!codex) return { kind: 'refused', text: 'Не нашёл команду codex в PATH службы.' }
    const prefix = userPrefix(codex, this.options.home)
    if (!prefix) {
      return { kind: 'refused', text: 'Codex установлен не через npm в домашний каталог (' + codex + '). ' +
        'Обновляю только такую установку, без sudo. Обнови Codex на сервере вручную: npm install -g @openai/codex@latest' }
    }
    const installed = await this.installedVersion(codex)
    if (!installed) return { kind: 'refused', text: 'Не удалось узнать установленную версию Codex (codex --version).' }
    const view = await this.options.run('npm', ['view', PACKAGE, 'version'], { cwd: this.options.home, timeoutMs: 60_000 })
    const latest = view.code === 0 ? versionOf(view.stdout) : undefined
    if (!latest) return { kind: 'refused', text: 'Не удалось узнать последнюю версию Codex (npm view @openai/codex version).' }
    if (compareVersions(latest, installed) <= 0) return { kind: 'current', installed, latest }
    return { kind: 'newer', installed, latest, prefix, changelog: await this.changelog(installed, latest) }
  }

  private install(prefix: string, version: string) {
    return this.options.run('npm', ['install', '-g', '--prefix', prefix, PACKAGE + '@' + version],
      { cwd: this.options.home, timeoutMs: 600_000 })
  }

  /**
   * Installs `latest` into a separate staging prefix, checks its version and an App Server handshake
   * there, and only then swaps the package directory into the active prefix (two renames on one file
   * system). The previous package stays next to it for /update codex rollback. Each step is written to
   * <state>/codex-update.json first, so an interrupted update is repaired at the next start
   * (recoverCodexUpdate) and the active Codex is never a half-written npm install.
   */
  async apply(check: Extract<CodexCheck, { kind: 'newer' }>): Promise<CodexApply> {
    if (this.busy) return { ok: false, stage: 'install', detail: 'Обновление Codex уже идёт.', restored: true }
    this.busy = true
    const dirs = codexDirs(check.prefix)
    const record: CodexUpdateRecord = { v: 1, phase: 'staging', previous: check.installed, target: check.latest, prefix: check.prefix, at: Date.now() }
    const untouched = (stage: 'install' | 'version' | 'handshake', detail: string): CodexApply => {
      rmSync(dirs.stage, { recursive: true, force: true })
      removeCodexRecord(this.options.stateDir)
      return { ok: false, stage, detail, restored: true }
    }
    try {
      writeCodexRecord(this.options.stateDir, record)
      rmSync(dirs.stage, { recursive: true, force: true })
      const install = await this.install(dirs.stage, check.latest)
      if (install.code !== 0 || !existsSync(dirs.stagedPackage)) return untouched('install', clip(install.stderr, 400))
      const staged = await this.installedVersion(dirs.stagedBin)
      if (staged !== check.latest) return untouched('version', 'codex --version показывает ' + (staged ?? 'ошибку'))
      const probe = await this.options.probe(dirs.stagedBin)
      if (!probe.ok) return untouched('handshake', probe.detail)
      // Switch: the active package moves aside (kept for rollback), the staged one takes its place.
      // A stale kept package goes first, so under phase=switching `previous` is always the one just replaced.
      rmSync(dirs.previous, { recursive: true, force: true })
      writeCodexRecord(this.options.stateDir, { ...record, phase: 'switching' })
      renameSync(dirs.active, dirs.previous)
      renameSync(dirs.stagedPackage, dirs.active)
      rmSync(dirs.stage, { recursive: true, force: true })
      const codex = this.options.codexPath()
      const now = codex ? await this.installedVersion(codex) : undefined
      if (now !== check.latest) {
        swapBack(dirs)
        removeCodexRecord(this.options.stateDir)
        return { ok: false, stage: 'version', detail: 'после переключения codex --version показывает ' + (now ?? 'ошибку'), restored: true }
      }
      writeCodexRecord(this.options.stateDir, { ...record, phase: 'done' })
      return { ok: true, from: check.installed, to: check.latest, models: probe.models }
    } catch (error) {
      const restored = recoverCodexUpdate(this.options.stateDir) !== 'failed'
      return { ok: false, stage: 'install', detail: error instanceof Error ? error.message : String(error), restored }
    } finally {
      this.busy = false
    }
  }

  /** /update codex rollback: puts back the Codex that the last /update codex replaced. */
  rollback(): CodexRollback {
    return codexRollback(this.options.stateDir)
  }
}

export type CodexRollback = { ok: true; from: string; to: string } | { ok: false; text: string }

/** Puts back the Codex the last /update codex replaced (also from safe mode, where CodexUpdate is not built). */
export function codexRollback(stateDir: string): CodexRollback {
  const record = readCodexRecord(stateDir)
  if (record?.phase !== 'done' || !existsSync(codexDirs(record.prefix).previous)) {
    return { ok: false, text: 'Нечего откатывать: прежняя версия Codex не сохранилась.' }
  }
  try {
    swapBack(codexDirs(record.prefix))
  } catch (error) {
    return { ok: false, text: 'Не удалось вернуть прежний Codex: ' + (error instanceof Error ? error.message : String(error)) }
  }
  removeCodexRecord(stateDir)
  return { ok: true, from: record.target, to: record.previous }
}

export interface CodexUpdateRecord {
  v: 1
  /** staging: npm writes only the stage; switching: the renames run; done: previous kept for rollback. */
  phase: 'staging' | 'switching' | 'done'
  previous: string
  target: string
  prefix: string
  at: number
}

const CODEX_RECORD = 'codex-update.json'

function codexDirs(prefix: string) {
  const stage = join(prefix, '.krotov-codex-stage')
  return {
    stage,
    stagedPackage: join(stage, 'lib', 'node_modules', '@openai', 'codex'),
    stagedBin: join(stage, 'bin', 'codex'),
    active: join(prefix, 'lib', 'node_modules', '@openai', 'codex'),
    previous: join(prefix, '.krotov-codex-previous'),
  }
}

/** Puts the kept previous package back as the active one; the replaced one is dropped. */
function swapBack(dirs: ReturnType<typeof codexDirs>): void {
  rmSync(dirs.active, { recursive: true, force: true })
  renameSync(dirs.previous, dirs.active)
}

export function readCodexRecord(stateDir: string): CodexUpdateRecord | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(stateDir, CODEX_RECORD), 'utf8'))
    if (typeof raw !== 'object' || raw === null) return
    const record = raw as Record<string, unknown>
    if (record.v !== 1 || !['staging', 'switching', 'done'].includes(String(record.phase))) return
    if (typeof record.previous !== 'string' || typeof record.target !== 'string' || typeof record.prefix !== 'string') return
    return { v: 1, phase: record.phase as CodexUpdateRecord['phase'], previous: record.previous, target: record.target,
      prefix: record.prefix, at: typeof record.at === 'number' ? record.at : 0 }
  } catch {
    return undefined
  }
}

function writeCodexRecord(stateDir: string, record: CodexUpdateRecord): void {
  const path = join(stateDir, CODEX_RECORD)
  writeFileSync(path + '.tmp', JSON.stringify(record) + '\n', { mode: 0o600 })
  renameSync(path + '.tmp', path)
}

function removeCodexRecord(stateDir: string): void {
  rmSync(join(stateDir, CODEX_RECORD), { force: true })
}

/**
 * At startup, before Codex runs (normal and safe mode): finishes what an interrupted /update codex left.
 * staging: the active Codex was never touched, the stage is dropped. switching: when the active package
 * is missing, the kept previous one goes back. Returns what happened, or undefined when there was nothing.
 */
export function recoverCodexUpdate(stateDir: string): 'cleaned' | 'restored' | 'failed' | undefined {
  const record = readCodexRecord(stateDir)
  if (!record || record.phase === 'done') return undefined
  const dirs = codexDirs(record.prefix)
  try {
    rmSync(dirs.stage, { recursive: true, force: true })
    if (record.phase === 'switching' && !existsSync(dirs.active)) {
      if (!existsSync(dirs.previous)) return 'failed'
      renameSync(dirs.previous, dirs.active)
      removeCodexRecord(stateDir)
      return 'restored'
    }
    // The switch finished (or never started): the active package is whole.
    if (record.phase === 'switching') writeCodexRecord(stateDir, { ...record, phase: 'done' })
    else removeCodexRecord(stateDir)
    return 'cleaned'
  } catch {
    return 'failed'
  }
}

/** A binary on a PATH, as a shell's `command -v` finds it. */
export function findOnPath(name: string, path: string | undefined): string | undefined {
  for (const dir of (path ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** GET with a 10 s timeout and a generic client name; any failure is undefined. */
export async function fetchTextOrUndefined(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'krotov-bridge' } })
    return response.ok ? await response.text() : undefined
  } catch {
    return undefined
  }
}
