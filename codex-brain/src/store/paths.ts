// Where Brain keeps its files (spec §5.1) and how a fresh scope is created.
//
// brain_home is `$CODEX_HOME/brain`, else `$HOME/.codex/brain` (slice plan K3): a managed hook
// starts with `env -i` and sees only PATH, HOME, CODEX_HOME, TMPDIR, LANG, so nothing else may
// decide where memory lives. `CODEX_BRAIN_HOME` is honoured only when the caller (CLI, tests)
// asks for it explicitly.

import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { z } from 'zod'

import { DaySchema, FactIdSchema, MonthSchema, ScopeSchema } from '../contract.js'
import { DIR_MODE, writeFileAtomic } from './atomic.js'

export const CONFIG_FILE = 'config.json'
export const LOCAL_SCOPE = 'local'

export interface BrainHomeOptions {
  /** Honour CODEX_BRAIN_HOME. Only the CLI and tests pass true; hooks and the bridge never do. */
  allowOverride?: boolean
}

function absolute(name: string, value: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`)
  return value
}

export function resolveBrainHome(env: Record<string, string | undefined>, options: BrainHomeOptions = {}): string {
  if (options.allowOverride && env.CODEX_BRAIN_HOME) return absolute('CODEX_BRAIN_HOME', env.CODEX_BRAIN_HOME)
  if (env.CODEX_HOME) return join(absolute('CODEX_HOME', env.CODEX_HOME), 'brain')
  if (env.HOME) return join(absolute('HOME', env.HOME), '.codex', 'brain')
  throw new Error('cannot locate brain_home: neither CODEX_HOME nor HOME is set')
}

export function brainConfigPath(brainHome: string): string {
  return join(brainHome, CONFIG_FILE)
}

/** Files above the scopes: settings and the lookups a hook or the CLI needs to find its scope (K3). */
export interface HomePaths {
  brainHome: string
  config: string
  /** `{ "scope": "<id>" }`: the scope the CLI uses when no session says otherwise; absent → `local`. */
  defaultScope: string
  /** Last `model/list` check of the summarizer (`SummarizerStateSchema`). */
  summarizerState: string
  /** Session → scope registry (`SessionEntrySchema`), one file per session. */
  sessionsDir: string
  session(sessionId: string): string
  /** Session intents of the bridge (`SessionIntentSchema`), one file per intent. */
  intentsDir: string
  intent(intentId: string): string
  /** Lock for read-modify-write of the files above the scopes (config.json, intents). */
  lockDir: string
}

export function homePaths(brainHome: string): HomePaths {
  const sessionsDir = join(brainHome, 'sessions')
  const intentsDir = join(brainHome, 'intents')
  return {
    brainHome,
    config: brainConfigPath(brainHome),
    defaultScope: join(brainHome, 'scope.json'),
    summarizerState: join(brainHome, 'summarizer.json'),
    sessionsDir,
    session: sessionId => join(sessionsDir, `${safeSegment(sessionId)}.json`),
    intentsDir,
    intent: intentId => join(intentsDir, `${safeSegment(intentId)}.json`),
    lockDir: join(brainHome, 'lock'),
  }
}

/** Creates brain_home and the directories above the scopes, 0700. */
export function ensureHome(brainHome: string): HomePaths {
  const home = homePaths(brainHome)
  for (const dir of [brainHome, home.sessionsDir, home.intentsDir, home.lockDir]) ensureDir(dir)
  return home
}

const DefaultScopeFileSchema = z.object({ scope: ScopeSchema }).strict()

/** The scope the bridge registered as default, or `local` when none is set or the file is unusable. */
export function readDefaultScope(brainHome: string): string {
  try {
    const parsed = DefaultScopeFileSchema.safeParse(JSON.parse(readFileSync(homePaths(brainHome).defaultScope, 'utf8')))
    return parsed.success ? parsed.data.scope : LOCAL_SCOPE
  } catch {
    return LOCAL_SCOPE
  }
}

export function writeDefaultScope(brainHome: string, scope: string): void {
  const value = DefaultScopeFileSchema.parse({ scope })
  ensureDir(brainHome)
  writeFileAtomic(homePaths(brainHome).defaultScope, `${JSON.stringify(value)}\n`)
}

/** Opaque scope id of a bridge pair (bot + owner); no Telegram id appears in the path. */
export function bridgeScope(...parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(`${part.length}:${part}`)
  return `b-${hash.digest('hex').slice(0, 16)}`
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

/**
 * Maps an external id (session, turn, proposal) to a single safe path segment. Plain ids are kept
 * as they are; anything else becomes a stable hash, so `..` or `/` can never leave the directory.
 */
export function safeSegment(id: string): string {
  if (SAFE_SEGMENT.test(id) && !id.includes('..')) return id
  return `h-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
}

export interface ScopePaths {
  brainHome: string
  scope: string
  root: string
  factsDir: string
  index: string
  journalDir: string
  recent: string
  recentSummary: string
  digestDir: string
  archiveDir: string
  handoffDir: string
  handoffCurrent: string
  handoffMeta: string
  handoffHistoryDir: string
  pendingDir: string
  stateDir: string
  snapshotDir: string
  permitsDir: string
  receiptsDir: string
  promptsDir: string
  /** Open boundary per session (`OpenBoundarySchema`). */
  boundariesDir: string
  manifest: string
  delta: string
  evicted: string
  plan: string
  questions: string
  note: string
  lockDir: string
  fact(id: string): string
  journal(day: string): string
  digest(day: string): string
  digestMeta(day: string): string
  archive(month: string): string
  archiveChecksum(month: string): string
  proposal(id: string): string
  snapshotText(sessionId: string): string
  snapshotMeta(sessionId: string): string
  boundary(sessionId: string): string
  permit(turnId: string): string
  receipt(turnId: string): string
  prompt(turnId: string): string
}

export function scopePaths(brainHome: string, scope: string): ScopePaths {
  ScopeSchema.parse(scope)
  const root = join(brainHome, scope)
  const state = join(root, 'state')
  const factsDir = join(root, 'facts')
  const journalDir = join(root, 'journal')
  const digestDir = join(root, 'digest')
  const archiveDir = join(root, 'archive')
  const handoffDir = join(root, 'handoff')
  const pendingDir = join(root, 'pending')
  const snapshotDir = join(state, 'snapshot')
  const permitsDir = join(state, 'permits')
  const receiptsDir = join(state, 'receipts')
  const promptsDir = join(state, 'prompts')
  const boundariesDir = join(state, 'boundaries')
  return {
    brainHome,
    scope,
    root,
    factsDir,
    index: join(root, 'INDEX.md'),
    journalDir,
    recent: join(root, 'recent.md'),
    recentSummary: join(root, 'recent-summary.md'),
    digestDir,
    archiveDir,
    handoffDir,
    handoffCurrent: join(handoffDir, 'current.md'),
    handoffMeta: join(handoffDir, 'current.json'),
    handoffHistoryDir: join(handoffDir, 'history'),
    pendingDir,
    stateDir: state,
    snapshotDir,
    permitsDir,
    receiptsDir,
    promptsDir,
    boundariesDir,
    manifest: join(state, 'manifest.json'),
    delta: join(state, 'delta.jsonl'),
    evicted: join(state, 'evicted.jsonl'),
    plan: join(state, 'plan.json'),
    questions: join(state, 'questions.json'),
    note: join(state, 'note.json'),
    lockDir: join(state, 'lock'),
    fact: id => join(factsDir, `${FactIdSchema.parse(id)}.md`),
    journal: day => join(journalDir, `${DaySchema.parse(day)}.jsonl`),
    digest: day => join(digestDir, `${DaySchema.parse(day)}.md`),
    digestMeta: day => join(digestDir, `${DaySchema.parse(day)}.json`),
    archive: month => join(archiveDir, `${MonthSchema.parse(month)}.tar.gz`),
    archiveChecksum: month => join(archiveDir, `${MonthSchema.parse(month)}.tar.gz.sha256`),
    proposal: id => join(pendingDir, `${safeSegment(id)}.json`),
    snapshotText: sessionId => join(snapshotDir, `${safeSegment(sessionId)}.txt`),
    snapshotMeta: sessionId => join(snapshotDir, `${safeSegment(sessionId)}.json`),
    boundary: sessionId => join(boundariesDir, `${safeSegment(sessionId)}.json`),
    permit: turnId => join(permitsDir, `${safeSegment(turnId)}.json`),
    receipt: turnId => join(receiptsDir, `${safeSegment(turnId)}.json`),
    prompt: turnId => join(promptsDir, `${safeSegment(turnId)}.json`),
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE })
  chmodSync(path, DIR_MODE)
}

function ensureFile(path: string, content: string): void {
  if (!existsSync(path)) writeFileAtomic(path, content)
  else chmodSync(path, 0o600)
}

export const EMPTY_MANIFEST = `${JSON.stringify({ version: 1, facts: {} })}\n`

/**
 * Creates brain_home (`ensureHome`) and the §5.1 layout of one scope: directories
 * 0700, files 0600. Deviation from §5.1: sessions are registered in `<brain_home>/sessions/`,
 * not under the scope, because the scope is what a hook looks up from its session (K3).
 * Idempotent: existing files keep their bytes, and `config.json` is never created or touched here,
 * so an explicit `{"enabled": false}` survives every later init.
 */
export function ensureScope(brainHome: string, scope: string): ScopePaths {
  const paths = scopePaths(brainHome, scope)
  ensureHome(brainHome)
  for (const dir of [paths.root, paths.factsDir, paths.journalDir, paths.digestDir, paths.archiveDir,
    paths.handoffDir, paths.handoffHistoryDir, paths.pendingDir, paths.stateDir, paths.snapshotDir,
    paths.permitsDir, paths.receiptsDir, paths.promptsDir, paths.boundariesDir, paths.lockDir]) {
    ensureDir(dir)
  }
  ensureFile(paths.index, '')
  ensureFile(paths.manifest, EMPTY_MANIFEST)
  return paths
}
