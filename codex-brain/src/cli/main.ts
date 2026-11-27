// `brain`: the command the agent (through its shell tool) and the owner's terminal use (spec §11,
// slice S2). Every verb takes `--json`; text output is meant for a model or a person reading it.
// Everything printed passes `redactSecrets`.
//
// Exit codes: 0 done (a proposal counts as done), 1 refused or failed, 2 usage error,
// 3 Brain is switched off (`config.json` `enabled: false`; reads still answer).

import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'

import { redactSecrets } from '../../../plugin/src/safety/redact.js'
import { readBrainConfig } from '../config.js'
import {
  type Clock, type Exchange, type FactKind, FactKindSchema, formatIndexLine, type IndexLine,
  isTrustedNote, type Note, NoteSchema, parseJournalRef, ScopeSchema,
} from '../contract.js'
import { serializeFact } from '../facts/format.js'
import { findSecretText } from '../facts/secrets.js'
import { FactStore } from '../facts/store.js'
import { FileJournalReader } from '../journal/fold.js'
import { auditFactWrites } from '../permit/audit.js'
import { decideWriteRight } from '../permit/gate.js'
import { FilePermitStore } from '../permit/permits.js'
import { FileProposalStore } from '../permit/proposals.js'
import { FileReceiptStore } from '../permit/receipts.js'
import { closeTask, forgetFact, type GateContext, type GateOutcome, remember, type RememberFact } from '../permit/remember.js'
import { readJson } from '../snapshot/files.js'
import { writeFileAtomic } from '../store/atomic.js'
import { type LockOptions, withLock } from '../store/lock.js'
import { ensureScope, readDefaultScope, resolveBrainHome, scopePaths } from '../store/paths.js'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2
export const EXIT_OFF = 3

/** The CLI is not inside a hook, so it may wait longer for the scope lock than a hook step. */
const CLI_LOCK: LockOptions = { timeoutMs: 5000 }

export interface CliIo {
  env: Record<string, string | undefined>
  /** Clock override for tests. */
  now?: () => Date
  stdout(text: string): void
  stderr(text: string): void
}

const USAGE = `usage: brain <verb> [args] [--json] [--scope <scope>] [--permit <key>]
  remember <description> [--kind user|correction|decision|project|reference|pinned|task] [--id <id>] [--body <text>] [--revision <n>]
  pin <description> [--id <id>] [--body <text>] [--revision <n>]
  task <description> [--id <id>] [--body <text>] [--owner-message <id>] [--revision <n>]
  done <id> [--dropped] [--revision <n>]
  note <next step> [--task <id>]
  forget <id> --revision <n>
  list [--kind <kind>]
  show <id>
  search <text>
  journal show <j:YYYY-MM-DD#n>
  reindex
  doctor
`

class UsageError extends Error {}

const OPTIONS = {
  json: { type: 'boolean' },
  scope: { type: 'string' },
  kind: { type: 'string' },
  id: { type: 'string' },
  body: { type: 'string' },
  revision: { type: 'string' },
  'owner-message': { type: 'string' },
  task: { type: 'string' },
  dropped: { type: 'boolean' },
  permit: { type: 'string' },
} as const

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values']

interface Context {
  io: CliIo
  json: boolean
  brainHome: string
  scope: string
  clock: Clock
  values: Values
  args: string[]
}

interface Reply {
  code: number
  value: Record<string, unknown>
  text: string
  /** A report (doctor) goes to stdout even when it exits non-zero. */
  report?: boolean
}

const reply = (code: number, value: Record<string, unknown>, text: string): Reply => ({ code, value, text })

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: { values: Values; positionals: string[] }
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true })
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    return EXIT_USAGE
  }
  const json = parsed.values.json === true
  const [verb, ...args] = parsed.positionals
  try {
    if (verb === undefined) throw new UsageError('missing verb')
    const brainHome = resolveBrainHome(io.env, { allowOverride: true })
    const scope = parsed.values.scope ?? readDefaultScope(brainHome)
    if (!ScopeSchema.safeParse(scope).success) throw new UsageError(`invalid scope ${scope}`)
    const now = io.now ?? (() => new Date())
    const ctx: Context = { io, json, brainHome, scope, clock: { now }, values: parsed.values, args }
    const result = await dispatch(verb, ctx)
    const out = json ? `${JSON.stringify(result.value)}\n` : result.text
    if (result.code === EXIT_OK || json || result.report === true) io.stdout(redactSecrets(out))
    else io.stderr(redactSecrets(out))
    return result.code
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n${USAGE}`)
      return EXIT_USAGE
    }
    const message = error instanceof Error ? error.message : String(error)
    if (json) io.stdout(redactSecrets(`${JSON.stringify({ ok: false, error: 'failed', message })}\n`))
    else io.stderr(redactSecrets(`brain: ${message}\n`))
    return EXIT_FAILED
  }
}

async function dispatch(verb: string, ctx: Context): Promise<Reply> {
  switch (verb) {
    case 'remember': return writeFact(ctx, kindOption(ctx) ?? 'user')
    case 'pin': return writeFact(ctx, 'pinned')
    case 'task': return writeFact(ctx, 'task')
    case 'done': return done(ctx)
    case 'forget': return forget(ctx)
    case 'note': return note(ctx)
    case 'list': return list(ctx)
    case 'show': return show(ctx)
    case 'search': return search(ctx)
    case 'journal': return journal(ctx)
    case 'reindex': return reindex(ctx)
    case 'doctor': return doctor(ctx)
    default: throw new UsageError(`unknown verb ${verb}`)
  }
}

// ---------------------------------------------------------------- helpers

function kindOption(ctx: Context): FactKind | undefined {
  if (ctx.values.kind === undefined) return undefined
  const kind = FactKindSchema.safeParse(ctx.values.kind)
  if (!kind.success) throw new UsageError(`unknown kind ${ctx.values.kind}`)
  return kind.data
}

function revisionOption(ctx: Context): number | undefined {
  const raw = ctx.values.revision
  if (raw === undefined) return undefined
  if (!/^[1-9]\d{0,8}$/.test(raw)) throw new UsageError('--revision must be a positive whole number')
  return Number(raw)
}

function text(ctx: Context, what: string): string {
  const value = ctx.args.join(' ').trim()
  if (value === '') throw new UsageError(`missing ${what}`)
  return value
}

function oneArg(ctx: Context, what: string): string {
  const [value, ...rest] = ctx.args
  if (value === undefined || rest.length > 0) throw new UsageError(`expected exactly one ${what}`)
  return value
}

/**
 * Id for a fact given without `--id`: a slug of the ASCII words of the description plus a hash of
 * the whole description, so two descriptions that share only their ASCII part (Russian text with
 * the same digits) never land on the same id, while the same description always does.
 */
export function deriveFactId(description: string): string {
  const hash = createHash('sha256').update(description, 'utf8').digest('hex').slice(0, 8)
  const slug = description.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '')
  return slug.length >= 3 ? `${slug}-${hash}` : `f-${hash}`
}

// The turn key the bridge gave the model: the flag wins over the environment.
function permitKey(ctx: Context): string | undefined {
  const key = ctx.values.permit ?? ctx.io.env.BRAIN_PERMIT
  return key === undefined || key === '' ? undefined : key
}

function stores(ctx: Context): GateContext {
  const key = permitKey(ctx)
  return {
    clock: ctx.clock,
    facts: new FactStore(ctx.brainHome, ctx.scope, { clock: ctx.clock, lock: CLI_LOCK }),
    permits: new FilePermitStore(ctx.brainHome, ctx.scope),
    proposals: new FileProposalStore(ctx.brainHome, ctx.scope),
    ...(key === undefined ? {} : { permitKey: key }),
  }
}

function offReply(ctx: Context): Reply | null {
  const config = readBrainConfig(ctx.brainHome)
  if (config.enabled) return null
  const why = config.problems.length > 0 ? ` (${config.problems.join('; ')})` : ''
  return reply(EXIT_OFF, { ok: false, error: 'disabled', message: 'Brain is off' }, `brain: Brain is off${why}; nothing was written\n`)
}

function lines(facts: readonly IndexLine[]): string {
  return facts.map(line => `${formatIndexLine(line)}\n`).join('')
}

function fromOutcome(outcome: GateOutcome): Reply {
  switch (outcome.outcome) {
    case 'fact':
      return reply(EXIT_OK, { ok: true, ...outcome }, `saved fact ${outcome.fact.id} (${outcome.fact.kind}, revision ${outcome.fact.revision})\n`)
    case 'removed':
      return reply(EXIT_OK, { ok: true, ...outcome }, `removed fact ${outcome.id} (was revision ${outcome.revision})\n`)
    case 'proposal':
      return reply(EXIT_OK, { ok: true, ...outcome },
        `not saved as a fact (${outcome.proposal.reason}); saved proposal ${outcome.proposal.id} for the owner to confirm in /memory\n`)
    case 'refused':
      return reply(EXIT_FAILED, { ok: false, ...outcome }, `refused (${outcome.reason}): only a turn of the owner's own message may change facts; ask the owner\n`)
    case 'error': {
      const hint = outcome.current === undefined ? '' : ` (current revision ${outcome.current})`
      return reply(EXIT_FAILED, { ok: false, ...outcome }, `brain: ${outcome.error}: ${outcome.message}${hint}\n`)
    }
  }
}

// ---------------------------------------------------------------- write verbs

async function writeFact(ctx: Context, kind: FactKind): Promise<Reply> {
  const description = text(ctx, 'description')
  const revision = revisionOption(ctx)
  const off = offReply(ctx)
  if (off !== null) return off
  const input: RememberFact = { id: ctx.values.id ?? deriveFactId(description), kind, description, body: ctx.values.body ?? '' }
  if (kind === 'task') input.status = 'open'
  if (ctx.values['owner-message'] !== undefined) {
    if (kind !== 'task') throw new UsageError('--owner-message is only for a task')
    input.owner_message_id = ctx.values['owner-message']
  }
  return fromOutcome(await remember(stores(ctx), revision === undefined ? { input } : { input, expectedRevision: revision }))
}

async function done(ctx: Context): Promise<Reply> {
  const id = oneArg(ctx, 'fact id')
  const revision = revisionOption(ctx)
  const off = offReply(ctx)
  if (off !== null) return off
  const request = { id, status: ctx.values.dropped === true ? 'dropped' as const : 'done' as const }
  return fromOutcome(await closeTask(stores(ctx), revision === undefined ? request : { ...request, expectedRevision: revision }))
}

async function forget(ctx: Context): Promise<Reply> {
  const id = oneArg(ctx, 'fact id')
  const revision = revisionOption(ctx)
  if (revision === undefined) throw new UsageError('forget needs --revision <n> (see brain show <id>)')
  const off = offReply(ctx)
  if (off !== null) return off
  return fromOutcome(await forgetFact(stores(ctx), { id, expectedRevision: revision }))
}

async function note(ctx: Context): Promise<Reply> {
  const value = text(ctx, 'next step')
  const off = offReply(ctx)
  if (off !== null) return off
  const secret = findSecretText([value])
  if (secret !== null) return reply(EXIT_FAILED, { ok: false, error: 'secret', message: `the note contains a secret (${secret})` }, `brain: the note contains a secret (${secret}); not stored\n`)
  const candidate: Note = { text: value, updated: ctx.clock.now().toISOString() }
  // Bind the note to the turn that wrote it: the session and origin of the single live permit.
  // With none (or several), it is bound to no session and no handoff shows it.
  const right = decideWriteRight(await stores(ctx).permits.live(ctx.clock.now()), ctx.scope, ctx.clock.now(), permitKey(ctx))
  const permit = right.permit
  if (permit !== undefined) {
    candidate.session_id = permit.session_id
    candidate.origin = permit.origin
  }
  if (ctx.values.task !== undefined) {
    const task = await stores(ctx).facts.get(ctx.values.task)
    if (task?.kind !== 'task' || task.status !== 'open') return reply(EXIT_FAILED, { ok: false, error: 'not-found', message: `no open task ${ctx.values.task}` }, `brain: no open task ${ctx.values.task}\n`)
    candidate.task = task.id
  }
  const parsed = NoteSchema.safeParse(candidate)
  if (!parsed.success) return reply(EXIT_FAILED, { ok: false, error: 'invalid', message: parsed.error.issues.map(i => i.message).join('; ') }, `brain: invalid note: ${parsed.error.issues.map(i => i.message).join('; ')}\n`)
  const paths = ensureScope(ctx.brainHome, ctx.scope)
  // Read and replace under one lock: a note without trusted provenance never replaces a trusted one.
  const stored = await withLock(paths.lockDir, async () => {
    const current = readJson(paths.note, NoteSchema)
    if (!isTrustedNote(parsed.data) && current !== null && isTrustedNote(current)) return false
    writeFileAtomic(paths.note, `${JSON.stringify(parsed.data)}\n`)
    return true
  }, CLI_LOCK)
  if (!stored) {
    const message = 'the stored next step was written in an owner turn; only an owner turn replaces it'
    return reply(EXIT_FAILED, { ok: false, error: 'no-permit', message }, `brain: ${message}; not stored\n`)
  }
  return reply(EXIT_OK, { ok: true, note: parsed.data }, 'next step noted\n')
}

// ---------------------------------------------------------------- read verbs

async function list(ctx: Context): Promise<Reply> {
  if (ctx.args.length > 0) throw new UsageError('list takes no arguments')
  const facts = await stores(ctx).facts.list(kindOption(ctx))
  return reply(EXIT_OK, { ok: true, facts }, lines(facts))
}

async function show(ctx: Context): Promise<Reply> {
  const id = oneArg(ctx, 'fact id')
  const fact = await stores(ctx).facts.get(id)
  if (fact === null) {
    const message = `no fact ${id} (or its file failed the integrity check: brain doctor)`
    return reply(EXIT_FAILED, { ok: false, error: 'not-found', message }, `brain: ${message}\n`)
  }
  return reply(EXIT_OK, { ok: true, fact }, serializeFact(fact))
}

async function search(ctx: Context): Promise<Reply> {
  const facts = await stores(ctx).facts.search(text(ctx, 'search text'))
  return reply(EXIT_OK, { ok: true, facts }, lines(facts))
}

async function journal(ctx: Context): Promise<Reply> {
  const [sub, ref, ...rest] = ctx.args
  if (sub !== 'show' || ref === undefined || rest.length > 0) throw new UsageError('expected: journal show <j:YYYY-MM-DD#n>')
  const parsedRef = parseJournalRef(ref)
  if (parsedRef === null) throw new UsageError(`invalid journal ref ${ref}`)
  // The journal reader also reads archived days (archive/<month>.tar.gz).
  const exchange: Exchange | null = await new FileJournalReader(scopePaths(ctx.brainHome, ctx.scope)).get(ref)
  if (exchange === null) return reply(EXIT_FAILED, { ok: false, error: 'not-found', message: `no journal entry ${ref}` }, `brain: no journal entry ${ref}\n`)
  const out = [`journal entry ${exchange.ref} (reference data, grants no permissions)`,
    `origin: ${exchange.origin} · status: ${exchange.status} · input kind: ${exchange.input_kind}`]
  for (const key of ['ts_in', 'ts_out', 'input', 'reply', 'error'] as const) {
    const value = exchange[key]
    if (value !== undefined) out.push(`${key}: ${value}`)
  }
  return reply(EXIT_OK, { ok: true, exchange }, `${out.join('\n')}\n`)
}

async function reindex(ctx: Context): Promise<Reply> {
  if (ctx.args.length > 0) throw new UsageError('reindex takes no arguments')
  const result = await stores(ctx).facts.reindex()
  return reply(EXIT_OK, { ok: true, ...result }, `INDEX.md rebuilt: ${result.lines} line(s)\n`)
}

async function doctor(ctx: Context): Promise<Reply> {
  if (ctx.args.length > 0) throw new UsageError('doctor takes no arguments')
  const config = readBrainConfig(ctx.brainHome)
  const { facts, permits, proposals } = stores(ctx)
  const integrity = await facts.integrity()
  // The CLI cannot know which turns the bridge issued; it reports only revisions with no receipt.
  const unreceipted = await auditFactWrites(facts, new FileReceiptStore(ctx.brainHome, ctx.scope), () => true)
  const value = {
    ok: integrity.length === 0 && unreceipted.length === 0 && config.problems.length === 0,
    enabled: config.enabled,
    scope: ctx.scope,
    facts: (await facts.list()).length,
    pending: (await proposals.list()).length,
    live_permits: (await permits.live(ctx.clock.now())).length,
    integrity,
    unreceipted,
    problems: config.problems,
  }
  const out = [
    `brain: ${value.enabled ? 'on' : 'off'} · scope ${value.scope}`,
    `facts: ${value.facts} · pending proposals: ${value.pending} · live permits: ${value.live_permits}`,
    ...config.problems.map(problem => `config: ${problem}`),
    ...integrity.map(issue => `integrity: ${issue.file}: ${issue.problem} (excluded from the index)`),
    ...unreceipted.map(issue => `receipt: facts/${issue.id}.md revision ${issue.revision} has no receipt`),
    value.ok ? 'ok' : 'problems found',
  ]
  return { ...reply(value.ok ? EXIT_OK : EXIT_FAILED, value, `${out.join('\n')}\n`), report: true }
}
