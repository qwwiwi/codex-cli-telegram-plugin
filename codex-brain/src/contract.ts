// Codex Brain shared contract (slice S0).
//
// Every type, zod schema, constant and interface that crosses a slice boundary lives here, so the
// slices S1-S6 can be built in parallel against it. After S0 merges, this file changes only
// through a request to the orchestrator. References: spec `docs/design/codex-brain-spec.md`
// (§N, amendments A1-A3) and slice plan `docs/design/brain/slices.md` (K-items).
//
// Conventions:
// - Field names in persisted JSON are snake_case, as in the spec examples.
// - Dates are UTC: `Day` = YYYY-MM-DD, `Timestamp` = ISO 8601 with a zone.
// - Every store and builder interface is bound to one scope when it is constructed; methods do not
//   take a scope argument. Exception: `SessionRegistry`, which maps sessions to scopes.
// - Anything read from disk is parsed with the schema here before use.

import { z } from 'zod'

import { estimateTokens } from './store/estimate.js'

export { estimateTokens }

// ---------------------------------------------------------------- constants

/** HOT snapshot cap (spec §6.1, D3). */
export const HOT_MAX_TOKENS = 2000
/** Pinned facts + open tasks cap; over it HOT carries one warning line, nothing is dropped (A1). */
export const PRIORITY_MAX_TOKENS = 800
/** Handoff document cap (spec §8.3). */
export const HANDOFF_MAX_TOKENS = 1000
/** Tail of `recent.md` printed at startup / clear (spec §6.2). */
export const RECENT_TAIL_MAX_TOKENS = 600
/** Evicted exchanges per rolling-summary batch (A2). */
export const SUMMARY_BATCH = 10
/** Max length of a fact description, which is also its index line (spec §5.2). */
export const DESCRIPTION_MAX = 120
/** Max lines of a daily digest (spec §5.1). */
export const DIGEST_MAX_LINES = 10
/** Journal entries listed in the handoff tail (spec §8.3). */
export const HANDOFF_TAIL_ENTRIES = 3
/** Handoffs kept in `handoff/history/` (spec §5.1). */
export const HANDOFF_HISTORY_KEEP = 5
/** Days a journal stays plain before archiving (spec §9, D8). */
export const ARCHIVE_RETENTION_DAYS = 90
/** `additionalContextLimit` of the shared SessionStart handler (slice plan K6). */
export const SESSION_START_CONTEXT_LIMIT = 6000
/** Time budget of every Brain hook step, in milliseconds (slice plan K5). */
export const HOOK_STEP_BUDGET_MS = 2000
/** Max length of the agent's `brain note` next-step line (spec §8.3). */
export const NOTE_MAX = 300
/** Default lifetime of a turn permit when the bridge does not set one, in milliseconds. */
export const PERMIT_TTL_MS = 60 * 60 * 1000
/** Summarizer defaults (A3). */
export const DEFAULT_SUMMARIZER: Readonly<{ model: string; effort: string }> = Object.freeze({ model: 'gpt-6.1-terra', effort: 'high' })
/** Fact `source` for a fact the owner dictated with `/memory add` (spec §5.2). */
export const SOURCE_TG_COMMAND = 'tg-command'
/** Fact `source` for a fact carried over from the legacy learning store (S6 migration). */
export const SOURCE_MIGRATION = 'migration'
/**
 * Version of the provenance rules stored model output was produced under. 2: owner memory comes
 * only from a pass over trusted owner text, sources are assigned from journal metadata. Stored
 * output without this version is not emitted (docs/design/brain/provenance-consistency.md §1.5).
 */
export const PROVENANCE_VERSION = 2
/** First line of a `recent-summary.md` written under `PROVENANCE_VERSION`. */
export const SUMMARY_VERSION_LINE = `<!-- brain-provenance: ${PROVENANCE_VERSION} -->`

// ---------------------------------------------------------------- primitives

export const DaySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'expected YYYY-MM-DD')
export type Day = z.infer<typeof DaySchema>

export const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'expected YYYY-MM')
export type Month = z.infer<typeof MonthSchema>

export const TimestampSchema = z.string().datetime({ offset: true })
export type Timestamp = z.infer<typeof TimestampSchema>

/** Names of the directories directly under brain_home that are not scopes. */
export const RESERVED_SCOPE_NAMES: readonly string[] = ['sessions', 'intents', 'lock']

/** Scope directory name: `local` for the terminal, `b-<hash>` for a bridge pair (spec §5.1). */
export const ScopeSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'invalid scope id')
  .refine(s => !RESERVED_SCOPE_NAMES.includes(s), 'this name is reserved under brain_home')
export type Scope = z.infer<typeof ScopeSchema>

/** Fact id: a lowercase slug, which is also its file name `facts/<id>.md`. */
export const FactIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'fact id must be a lowercase slug')
export type FactId = z.infer<typeof FactIdSchema>

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)

/** One line of text: no line break, not blank. */
const singleLine = (max: number) => z.string().min(1).max(max).refine(s => !/[\r\n]/.test(s) && s.trim().length > 0, 'must be one non-blank line')

// ---------------------------------------------------------------- journal refs

const JOURNAL_REF = /^j:(\d{4}-\d{2}-\d{2})#([1-9]\d{0,8})$/

/** `j:<day>#<n>`: day of the journal file and the exchange number in it (spec §5.2). */
export const JournalRefSchema = z.string().refine(s => parseJournalRef(s) !== null, 'expected j:YYYY-MM-DD#n')
export type JournalRef = z.infer<typeof JournalRefSchema>

export function parseJournalRef(ref: string): { day: Day; n: number } | null {
  const match = JOURNAL_REF.exec(ref)
  if (!match?.[1] || !match[2] || !DaySchema.safeParse(match[1]).success) return null
  return { day: match[1], n: Number(match[2]) }
}

export function formatJournalRef(day: Day, n: number): JournalRef {
  const ref = `j:${DaySchema.parse(day)}#${n}`
  if (!Number.isInteger(n) || parseJournalRef(ref) === null) throw new Error(`invalid exchange number ${n}`)
  return ref
}

// ---------------------------------------------------------------- facts (§5.2, A1)

export const FACT_KINDS = ['user', 'correction', 'decision', 'project', 'reference', 'pinned', 'task'] as const
export const FactKindSchema = z.enum(FACT_KINDS)
export type FactKind = z.infer<typeof FactKindSchema>

export const TaskStatusSchema = z.enum(['open', 'done', 'dropped'])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

/** Where a fact came from: a journal ref, `tg-command` (`/memory add`) or `migration`. */
export const FactSourceSchema = z.union([JournalRefSchema, z.literal(SOURCE_TG_COMMAND), z.literal(SOURCE_MIGRATION)])
export type FactSource = z.infer<typeof FactSourceSchema>

export const DescriptionSchema = singleLine(DESCRIPTION_MAX)

// Plain object schema of a fact, for `.pick` / `.omit`; validate whole facts with `FactSchema`.
export const FactFields = z.object({
  id: FactIdSchema,
  kind: FactKindSchema,
  description: DescriptionSchema,
  revision: z.number().int().min(1),
  source: FactSourceSchema,
  /** Date of the first write, not of a read: keeps snapshots stable. */
  created: DaySchema,
  /** Date of the last write. */
  updated: DaySchema,
  /** Only for kind `task`, and required there. */
  status: TaskStatusSchema.optional(),
  /** Only for kind `task`: the owner message that set the task, as an opaque string. */
  owner_message_id: z.string().min(1).max(64).optional(),
  /** Markdown body below the front matter. */
  body: z.string(),
}).strict()

const taskRules = <T extends { kind: FactKind; status?: TaskStatus | undefined; owner_message_id?: string | undefined }>(fact: T, ctx: z.RefinementCtx): void => {
  if (fact.kind === 'task' && fact.status === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a task needs a status', path: ['status'] })
  if (fact.kind !== 'task' && fact.status !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only a task has a status', path: ['status'] })
  if (fact.kind !== 'task' && fact.owner_message_id !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'only a task has an owner message', path: ['owner_message_id'] })
}

/** One fact file `facts/<id>.md`: front matter fields + body. */
export const FactSchema = FactFields.superRefine(taskRules)
export type Fact = z.infer<typeof FactSchema>

/** What a writer receives; revision and dates are set by the store. */
export const FactInputSchema = FactFields.omit({ revision: true, created: true, updated: true }).superRefine(taskRules)
export type FactInput = z.infer<typeof FactInputSchema>

/** One line of `INDEX.md`; HOT only ever shows these three validated fields (spec §7.2). */
export const IndexLineSchema = z.object({ id: FactIdSchema, kind: FactKindSchema, description: DescriptionSchema }).strict()
export type IndexLine = z.infer<typeof IndexLineSchema>

export function formatIndexLine(line: IndexLine): string {
  return `- ${line.id} · ${line.kind} · ${line.description}`
}

/** Fixed index order: kind, then id, by code point (spec §5.2). */
export function compareIndexLines(a: IndexLine, b: IndexLine): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/** `state/manifest.json`: hash of every fact file written through Brain (spec §7.2 integrity). */
export const ManifestSchema = z.object({
  version: z.literal(1),
  facts: z.record(FactIdSchema, z.object({ revision: z.number().int().min(1), sha256: Sha256Schema }).strict()),
  /** Last revision of each removed fact: a recreated id continues above it, so revisions never repeat. */
  removed: z.record(FactIdSchema, z.number().int().min(1)).optional(),
}).strict()
export type Manifest = z.infer<typeof ManifestSchema>

export const IntegrityIssueSchema = z.object({
  file: z.string().min(1),
  problem: z.enum(['not-in-manifest', 'hash-mismatch', 'invalid', 'missing-file']),
}).strict()
export type IntegrityIssue = z.infer<typeof IntegrityIssueSchema>

// ---------------------------------------------------------------- journal (§5.3)

export const BrainOriginSchema = z.enum(['owner-direct', 'owner-forward', 'agent', 'continuation', 'terminal'])
export type BrainOrigin = z.infer<typeof BrainOriginSchema>

/** Origins whose text may be quoted at developer level and that get owner rights (spec §7.2, §8.3). */
export const TRUSTED_ORIGINS: readonly BrainOrigin[] = ['owner-direct', 'terminal']

export const JournalStatusSchema = z.enum(['bound', 'answered', 'delivered', 'failed', 'cancelled'])
export type JournalStatus = z.infer<typeof JournalStatusSchema>

export const InputKindSchema = z.enum(['text', 'voice', 'forward', 'media'])
export type InputKind = z.infer<typeof InputKindSchema>

/**
 * One line of `journal/<day>.jsonl`. Status transitions are new lines with the same `key` and `n`;
 * readers fold by `key`. A failed voice recognition has no `input` and says so in `error`.
 */
export const JournalLineSchema = z.object({
  n: z.number().int().min(1),
  key: z.string().min(1).max(200),
  origin: BrainOriginSchema,
  status: JournalStatusSchema,
  ts_in: TimestampSchema.optional(),
  ts_out: TimestampSchema.optional(),
  thread: z.string().min(1).optional(),
  turn: z.string().min(1).optional(),
  input: z.string().optional(),
  input_kind: InputKindSchema,
  reply: z.string().optional(),
  error: z.string().max(500).optional(),
}).strict()
export type JournalLine = z.infer<typeof JournalLineSchema>

/** All lines of one key folded: the last value of each field wins. */
export const ExchangeSchema = JournalLineSchema.extend({ ref: JournalRefSchema }).strict()
export type Exchange = z.infer<typeof ExchangeSchema>

/**
 * One whole exchange as it appears in `recent.md` (level 1, spec §9) and in the recent tail:
 *
 * ```
 * ### <ref> · <origin> · <status>
 * **Input:** <input>            (or "(no text: <error>)" when there is no input)
 * **Reply:** <reply>            (omitted while there is no reply)
 * ```
 *
 * `recent.md` is these entries joined by one blank line, oldest first. It is a derived view: S1
 * rewrites it, nobody parses it (S3 reads exchanges through `RecentReader`). The trust rule of the
 * handoff applies: for an origin outside `TRUSTED_ORIGINS` neither input nor reply is quoted, the
 * entry points to the journal instead. An entry is never cut.
 */
export function formatRecentEntry(exchange: Exchange): string {
  const head = `### ${exchange.ref} · ${exchange.origin} · ${exchange.status}\n`
  if (!TRUSTED_ORIGINS.includes(exchange.origin)) return `${head}(${exchange.origin} text not quoted: brain journal show ${exchange.ref})\n`
  const input = exchange.input ?? `(no text${exchange.error === undefined ? '' : `: ${exchange.error}`})`
  const reply = exchange.reply === undefined ? '' : `**Reply:** ${exchange.reply}\n`
  return `${head}**Input:** ${input}\n${reply}`
}

/**
 * Recent tail printed at startup / clear (spec §6.2): the newest whole entries whose joined text
 * fits `maxTokens` (`estimateTokens`), oldest first, joined like `recent.md`. Stops at the first
 * entry that does not fit, so the tail is always contiguous; '' when not even the newest fits.
 */
export function renderRecentTail(exchanges: readonly Exchange[], maxTokens: number): string {
  let tail = ''
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const entry = exchanges[i]
    if (entry === undefined) break
    const next = tail === '' ? formatRecentEntry(entry) : `${formatRecentEntry(entry)}\n${tail}`
    if (estimateTokens(next) > maxTokens) break
    tail = next
  }
  return tail
}

/** `state/evicted.jsonl`: exchanges evicted from `recent.md` and waiting for a summary (A2). */
export const EvictedLineSchema = z.object({
  ref: JournalRefSchema,
  /**
   * `failed`: one rejected or failed model attempt (the ref stays queued); `skipped`: given up for
   * good (oversized, or rejected too often), so it costs no more model calls. The journal keeps it.
   */
  status: z.enum(['pending', 'summarized', 'failed', 'skipped']),
  at: TimestampSchema,
  reason: z.string().min(1).max(200).optional(),
}).strict()
export type EvictedLine = z.infer<typeof EvictedLineSchema>

// ---------------------------------------------------------------- permits, receipts, proposals (§7.2)

/** `state/permits/<turn_id>.json`, written by the bridge when a turn starts. */
export const PermitSchema = z.object({
  scope: ScopeSchema,
  session_id: z.string().min(1),
  turn_id: z.string().min(1),
  origin: BrainOriginSchema,
  journal_ref: JournalRefSchema,
  expires: TimestampSchema,
  /** The bridge saw explicit "remember / correction" wording (spec §7.3). */
  cue: z.boolean(),
  /**
   * sha256 (hex) of the random key the bridge gave only to this turn's model (`brain … --permit <key>`).
   * An owner-direct permit grants owner rights only to a caller that presents the key, so a process
   * outside the turn (another session, a terminal, a scheduled job) cannot borrow the live permit.
   */
  key_hash: Sha256Schema.optional(),
}).strict()
export type Permit =z.infer<typeof PermitSchema>

export const ReceiptWriteSchema = z.object({
  id: FactIdSchema,
  kind: FactKindSchema,
  description: DescriptionSchema,
  revision: z.number().int().min(0),
  action: z.enum(['put', 'remove', 'done']),
  at: TimestampSchema,
  /** sha256 of the fact file this write produced (put / done), for an id → hash ledger in the bridge. */
  sha256: Sha256Schema.optional(),
}).strict()
export type ReceiptWrite = z.infer<typeof ReceiptWriteSchema>

/** `state/receipts/<turn_id>.json`: fact writes done in one turn. */
export const ReceiptSchema = z.object({
  turn_id: z.string().min(1),
  journal_ref: JournalRefSchema.optional(),
  writes: z.array(ReceiptWriteSchema),
}).strict()
export type Receipt = z.infer<typeof ReceiptSchema>

export const ProposalReasonSchema = z.enum([
  'not-owner-direct', 'no-permit', 'expired-permit', 'several-permits', 'model', 'migration',
])
export type ProposalReason = z.infer<typeof ProposalReasonSchema>

/** `pending/<id>.json`: a candidate fact the owner accepts or rejects in `/memory pending`. */
export const ProposalSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  fact: z.object({
    id: FactIdSchema.optional(),
    kind: FactKindSchema,
    description: DescriptionSchema,
    body: z.string(),
  }).strict(),
  source: JournalRefSchema.optional(),
  from: z.enum(['remember', 'summarizer', 'reviewer', 'migration']),
  reason: ProposalReasonSchema,
  origin: BrainOriginSchema.optional(),
  /** Set on model proposals (`summarizer`, `reviewer`); one without it is not listed. */
  provenance: z.literal(PROVENANCE_VERSION).optional(),
  created: TimestampSchema,
}).strict()
export type Proposal = z.infer<typeof ProposalSchema>

/** A model proposal made before the two-pass rules: kept on disk, never shown to the owner. */
export const isQuarantinedProposal = (proposal: Proposal): boolean =>
  (proposal.from === 'summarizer' || proposal.from === 'reviewer') && proposal.provenance !== PROVENANCE_VERSION

/**
 * Who a session belongs to (spec §7.2, D16):
 * - `owner`: the owner's main bridge thread; `side` / `guest`: other bridge threads;
 * - `terminal`: a plain Codex session the bridge did not start (no live intent, see
 *   `SessionRegistry.claim`); it uses scope `local`, separate from every bridge scope.
 */
export const SessionRoleSchema = z.enum(['owner', 'side', 'guest', 'terminal'])
export type SessionRole = z.infer<typeof SessionRoleSchema>

/** Roles whose sessions get personal memory (HOT, recent tail, handoff); all others get none. */
export const PERSONAL_MEMORY_ROLES: readonly SessionRole[] = ['owner', 'terminal']

/** `<brain_home>/sessions/<session_id>.json`: session → scope and role (spec §7.2, D16). */
export const SessionEntrySchema = z.object({
  session_id: z.string().min(1),
  scope: ScopeSchema,
  role: SessionRoleSchema,
  thread_id: z.string().min(1).optional(),
  registered: TimestampSchema,
}).strict()
export type SessionEntry = z.infer<typeof SessionEntrySchema>

/** Lifetime of a session intent: `thread/start` and its SessionStart hook happen well within it. */
export const SESSION_INTENT_TTL_MS = 2 * 60 * 1000

/**
 * `<brain_home>/intents/<id>.json`: written by the bridge before `thread/start`, because the
 * SessionStart hook of the new thread may run before the bridge learns the thread id (spec §7.2,
 * §13 item 3). Never `terminal`: that role is what an unclaimed session gets.
 */
export const SessionIntentSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  scope: ScopeSchema,
  role: SessionRoleSchema.exclude(['terminal']),
  created: TimestampSchema,
  expires: TimestampSchema,
}).strict()
export type SessionIntent = z.infer<typeof SessionIntentSchema>

// ---------------------------------------------------------------- hook-side state

export const SessionSourceSchema = z.enum(['startup', 'resume', 'clear', 'compact', 'fork'])
export type SessionSource = z.infer<typeof SessionSourceSchema>

export const CompactTriggerSchema = z.enum(['manual', 'auto'])
export type CompactTrigger = z.infer<typeof CompactTriggerSchema>

/**
 * Opaque id of one context boundary of a session (a startup, clear or compaction; spec §6.2).
 * The same id asked twice returns the same HOT bytes; a new id builds from the current state.
 * Minted only by `SnapshotBuilder.beginBoundary`.
 */
export const BoundaryIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid boundary id')
export type BoundaryId = z.infer<typeof BoundaryIdSchema>

/** `state/boundaries/<session_id>.json`: the boundary the session entered last. */
export const OpenBoundarySchema = z.object({
  session_id: z.string().min(1),
  boundary: BoundaryIdSchema,
  source: SessionSourceSchema,
  opened: TimestampSchema,
}).strict()
export type OpenBoundary = z.infer<typeof OpenBoundarySchema>

/** `state/snapshot/<session_id>.json` next to the exact HOT bytes in `<session_id>.txt` (cache rule 1). */
export const SnapshotMetaSchema = z.object({
  session_id: z.string().min(1),
  source: SessionSourceSchema,
  /** Boundary these bytes were built for; the same boundary asked again returns them unchanged. */
  boundary: BoundaryIdSchema,
  sha256: Sha256Schema,
  /** Provenance rules the summary and digest lines in these bytes were produced under. */
  provenance: z.literal(PROVENANCE_VERSION),
  /** Highest `delta.jsonl` seq already announced to this session (D9). */
  delta_seen: z.number().int().min(0),
  /** Fact id → revision at this boundary; the handoff diffs the manifest against it (spec §8.3). */
  facts: z.record(FactIdSchema, z.number().int().min(1)),
}).strict()
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>

/** `state/delta.jsonl`: out-of-band owner edits through `/memory` (D9). */
export const DeltaLineSchema = z.object({
  seq: z.number().int().min(1),
  id: FactIdSchema,
  action: z.enum(['changed', 'removed']),
  revision: z.number().int().min(1).optional(),
  at: TimestampSchema,
}).strict()
export type DeltaLine = z.infer<typeof DeltaLineSchema>

/** `state/prompts/<turn_id>.json`: prompt captured at UserPromptSubmit for terminal mode (spec §7.1). */
export const PromptCaptureSchema = z.object({
  session_id: z.string().min(1),
  turn_id: z.string().min(1),
  prompt: z.string(),
  at: TimestampSchema,
}).strict()
export type PromptCapture = z.infer<typeof PromptCaptureSchema>

/** Codex plan step status as sent in `turn/plan/updated`. */
export const PlanStepStatusSchema = z.enum(['pending', 'inProgress', 'completed'])
export const PlanStepSchema = z.object({ step: z.string().min(1).max(500), status: PlanStepStatusSchema }).strict()
export type PlanStep = z.infer<typeof PlanStepSchema>

/** `state/plan.json`: the bridge's mirror of `turn/plan/updated` (spec §8.3). */
export const PlanStateSchema = z.object({
  session_id: z.string().min(1),
  turn_id: z.string().min(1),
  explanation: z.string().max(1000).optional(),
  steps: z.array(PlanStepSchema),
  updated: TimestampSchema,
}).strict()
export type PlanState = z.infer<typeof PlanStateSchema>

/** `state/questions.json`: open questions to the owner, exported by the bridge (spec §8.3). */
export const OpenQuestionsSchema = z.object({
  session_id: z.string().min(1),
  questions: z.array(z.string().min(1).max(500)),
  updated: TimestampSchema,
}).strict()
export type OpenQuestions = z.infer<typeof OpenQuestionsSchema>

/**
 * `state/note.json`: the agent's single next-step line from `brain note` (spec §8.3). With `task`
 * (`brain note --task <id>`), the handoff shows it as `tasks[].next` of that open task as well
 * as `next_step`; a later note replaces it.
 */
export const NoteSchema = z.object({
  text: singleLine(NOTE_MAX),
  task: FactIdSchema.optional(),
  /** Session of the turn that wrote it; a note without one is shown in no handoff. */
  session_id: z.string().min(1).optional(),
  /** Origin of that turn (its permit); only a trusted origin's note becomes the handoff's next step. */
  origin: BrainOriginSchema.optional(),
  updated: TimestampSchema,
}).strict()
export type Note = z.infer<typeof NoteSchema>

/** Explicit trusted provenance: the note names its session and a trusted origin (no origin = untrusted). */
export const isTrustedNote = (note: Note): boolean =>
  note.session_id !== undefined && note.origin !== undefined && TRUSTED_ORIGINS.includes(note.origin)

// ---------------------------------------------------------------- summaries and digest (A2, §9)

/** Kinds of owner memory: a summary line of these kinds restates what the owner wrote. */
export const OWNER_SUMMARY_KINDS = ['decision', 'fact', 'task', 'preference', 'done'] as const

/**
 * Reference-only provenance: `agent-reply` restates the agent's reply, `not-owner` restates an
 * exchange whose origin is outside `TRUSTED_ORIGINS` (forwarded text, other agents). Such a line
 * is never owner memory: HOT renders it in its own block with the provenance, and it never
 * becomes a proposal.
 */
export const REFERENCE_SOURCES = ['agent-reply', 'not-owner'] as const
export const ReferenceSourceSchema = z.enum(REFERENCE_SOURCES)
export type ReferenceSource = z.infer<typeof ReferenceSourceSchema>

export const SummaryKindSchema = z.enum([...OWNER_SUMMARY_KINDS, ...REFERENCE_SOURCES])
export type SummaryKind = z.infer<typeof SummaryKindSchema>

export const isReferenceKind = (kind: SummaryKind): kind is ReferenceSource => (REFERENCE_SOURCES as readonly string[]).includes(kind)

/** One line of `recent-summary.md`. */
export const SummaryLineSchema = z.object({ kind: SummaryKindSchema, text: singleLine(300), ref: JournalRefSchema }).strict()
export type SummaryLine = z.infer<typeof SummaryLineSchema>

const LINE_SEPARATOR = ' · '

/** `recent-summary.md` holds one `- <kind> · <text> · <ref>` line per summary line, oldest first, `\n` ends. */
export function formatSummaryLine(line: SummaryLine): string {
  return `- ${line.kind}${LINE_SEPARATOR}${line.text}${LINE_SEPARATOR}${line.ref}`
}

/** Inverse of `formatSummaryLine`: kind is the first field, ref the last, the text may contain ` · `. */
export function parseSummaryLine(line: string): SummaryLine | null {
  if (!line.startsWith('- ')) return null
  const parts = line.slice(2).split(LINE_SEPARATOR)
  if (parts.length < 3) return null
  const parsed = SummaryLineSchema.safeParse({ kind: parts[0], text: parts.slice(1, -1).join(LINE_SEPARATOR), ref: parts.at(-1) })
  return parsed.success ? parsed.data : null
}

/** `source` set: a reference-only line (see `REFERENCE_SOURCES`); absent: the owner's own content. */
export const DigestLineSchema = z.object({ text: singleLine(300), ref: JournalRefSchema, source: ReferenceSourceSchema.optional() }).strict()
export type DigestLine = z.infer<typeof DigestLineSchema>

/** One line of `digest/<day>.md` and of the HOT digest block: `- <text> · <ref>`. */
export function formatDigestLine(line: DigestLine): string {
  const source = line.source === undefined ? '' : `[${line.source}] `
  return `- ${source}${line.text}${LINE_SEPARATOR}${line.ref}`
}

/** `digest/<day>.json` meta of `digest/<day>.md`; job key = day + input hash (D7). */
export const DigestSchema = z.object({
  day: DaySchema,
  revision: z.number().int().min(1),
  input_hash: Sha256Schema,
  covered_to: JournalRefSchema,
  /** A digest without it predates the two-pass rules and is never emitted. */
  provenance: z.literal(PROVENANCE_VERSION),
  lines: z.array(DigestLineSchema).max(DIGEST_MAX_LINES),
}).strict()
export type Digest = z.infer<typeof DigestSchema>

/**
 * `<brain_home>/summarizer.json`: result of the last `model/list` check (A3, slice plan K11).
 * S4 writes it, S6 shows `warning` in `/memory` and `BrainStatus.summarizer`.
 */
export const SummarizerStateSchema = z.object({
  configured: z.object({ model: z.string().min(1), effort: z.string().min(1) }).strict(),
  used: z.object({ model: z.string().min(1), effort: z.string().min(1) }).strict(),
  fallback: z.boolean(),
  warning: z.string().max(500).optional(),
  checked: TimestampSchema,
}).strict()
export type SummarizerState = z.infer<typeof SummarizerStateSchema>

// ---------------------------------------------------------------- handoff (§8)

const QuotedRef = z.object({
  ref: JournalRefSchema,
  origin: BrainOriginSchema,
  /** Truncated text; allowed only for owner-direct / terminal origin (spec §8.3 trust rule). */
  quote: z.string().max(2000).optional(),
}).strict().refine(r => r.quote === undefined || TRUSTED_ORIGINS.includes(r.origin), 'only owner-direct text may be quoted')

const TailEntry = z.object({
  ref: JournalRefSchema,
  origin: BrainOriginSchema,
  line: z.string().max(300).optional(),
}).strict().refine(r => r.line === undefined || TRUSTED_ORIGINS.includes(r.origin), 'only owner-direct text may be quoted')

/** Structured handoff (`handoff/current.json`), rendered into `handoff/current.md`. */
export const HandoffSchema = z.object({
  session_id: z.string().min(1),
  thread: z.string().min(1).optional(),
  /** `bridge`: written by the bridge in degraded mode (spec §8.4). */
  trigger: z.enum(['manual', 'auto', 'bridge']),
  written: TimestampSchema,
  journal_to: JournalRefSchema.optional(),
  in_flight: QuotedRef.nullable(),
  /** Terminal session: the in-flight prompt captured at UserPromptSubmit (`PromptCapture`), redacted. */
  in_flight_prompt: z.string().max(2000).optional(),
  plan: z.array(PlanStepSchema),
  open_questions: z.array(z.string().min(1).max(500)),
  /** Facts written or changed since the last snapshot. */
  decisions: z.array(IndexLineSchema),
  /** Open tasks first (A1); `next` is the `brain note` text when the note names this task (`Note.task`). */
  tasks: z.array(z.object({ id: FactIdSchema, description: DescriptionSchema, next: z.string().max(NOTE_MAX).optional() }).strict()),
  /** Open tasks left out to fit the budget; the rendering points to `brain list --kind task`. */
  tasks_omitted: z.number().int().min(1).optional(),
  next_step: z.string().max(NOTE_MAX).nullable(),
  tail: z.array(TailEntry),
  delivered: TimestampSchema.optional(),
}).strict()
export type Handoff = z.infer<typeof HandoffSchema>

// ---------------------------------------------------------------- config and status (K10, K2, §10)

/** `<brain_home>/config.json` as stored. A missing file or a missing `enabled` means on. */
export const BrainConfigFileSchema = z.object({
  enabled: z.boolean().optional(),
  summarizer: z.object({ model: z.string().min(1).optional(), effort: z.string().regex(/^[a-z]{1,16}$/).optional() }).strict().optional(),
  resume_reemit: z.boolean().optional(),
}).passthrough()
export type BrainConfigFile = z.infer<typeof BrainConfigFileSchema>

/** Effective configuration after defaults. `problems` lists what could not be read. */
export interface BrainConfig {
  enabled: boolean
  summarizer: { model: string; effort: string }
  resume_reemit: boolean
  problems: string[]
}

/** How the hooks pack is installed for the bridge user (slice plan K2). */
export const HooksStateSchema = z.enum(['managed', 'user-trusted', 'user-needs-review', 'none'])
export type HooksState = z.infer<typeof HooksStateSchema>

export const BrainStatusSchema = z.object({
  enabled: z.boolean(),
  scope: ScopeSchema,
  facts: z.number().int().min(0),
  pending: z.number().int().min(0),
  priority_tokens: z.number().int().min(0),
  priority_over_budget: z.boolean(),
  last_digest: DaySchema.nullable(),
  journal_bytes: z.number().int().min(0),
  hooks: HooksStateSchema,
  /** PreCompact handler present (K4: not part of the full-access gate). */
  precompact: z.enum(['installed', 'not-installed']),
  /** No handoff inside a turn: hooks absent, untrusted or PreCompact missing. */
  degraded: z.boolean(),
  last_handoff_delivery: TimestampSchema.nullable(),
  /** Fact files that fail the manifest check. */
  integrity: z.array(IntegrityIssueSchema),
  summarizer: z.object({ model: z.string().min(1), effort: z.string().min(1), fallback: z.boolean() }).strict(),
  warnings: z.array(z.string()),
}).strict()
export type BrainStatus = z.infer<typeof BrainStatusSchema>

// ---------------------------------------------------------------- interfaces

export interface Clock {
  now(): Date
}

export type FactWriteError = 'conflict' | 'not-found' | 'secret' | 'invalid'

export type FactWriteResult =
  | { ok: true; fact: Fact }
  | { ok: false; error: FactWriteError; current?: number; message: string }

export type FactRemoveResult =
  | { ok: true; id: FactId; revision: number }
  | { ok: false; error: FactWriteError; current?: number; message: string }

export interface FactReader {
  /** Any fact file, closed tasks included. */
  get(id: FactId): Promise<Fact | null>
  /**
   * Active facts as index lines, in the fixed order (`compareIndexLines`). A closed task (status
   * `done` or `dropped`) is not active: it leaves the list, `INDEX.md` and HOT, while its file
   * stays readable through `get`.
   */
  list(kind?: FactKind): Promise<IndexLine[]>
  /** Pinned facts, then open tasks, each sorted by id (A1). */
  priority(): Promise<Fact[]>
  /** Current `INDEX.md` bytes: `formatIndexLine` + `\n` for each line of `list()`, no other text. */
  indexText(): Promise<string>
  manifest(): Promise<Manifest>
  /** Fact files that do not match the manifest; they are excluded from the index and HOT. */
  integrity(): Promise<IntegrityIssue[]>
}

export interface FactWriter {
  /**
   * Without `expectedRevision`: create only; an existing id → `conflict` with `current`, never a
   * blind overwrite. With it: update only; a missing id → `not-found`, another revision →
   * `conflict`. Rejects secrets (`secret`) and invalid input (`invalid`).
   */
  put(input: FactInput, expectedRevision?: number): Promise<FactWriteResult>
  remove(id: FactId, expectedRevision: number): Promise<FactRemoveResult>
  /** Closes a task: status `done` (default) or `dropped`. */
  done(id: FactId, status?: Exclude<TaskStatus, 'open'>, expectedRevision?: number): Promise<FactWriteResult>
}

export interface BindInput {
  key: string
  origin: BrainOrigin
  input_kind: InputKind
  input?: string
  /** Why there is no `input`, e.g. a failed voice recognition; never an invented transcript (spec §5.3). */
  error?: string
  thread?: string
  turn?: string
  /** Defaults to the writer's clock. */
  ts_in?: Timestamp
}

/**
 * Journal writer of one scope. An exchange is "in flight" while its folded status is `bound` or
 * `answered`; the handoff takes the in-flight exchange of the active turn (spec §8.2).
 */
export interface JournalWriter {
  /** Appends a `bound` entry; idempotent by key (a retried bind returns the existing ref). */
  bind(input: BindInput): Promise<JournalRef>
  /** Records the turn id once `turn/start` returned it (a `bound` line carrying `turn`). */
  started(ref: JournalRef, turn: string): Promise<void>
  answered(ref: JournalRef, reply: string): Promise<void>
  delivered(ref: JournalRef): Promise<void>
  failed(ref: JournalRef, error?: string): Promise<void>
  cancelled(ref: JournalRef): Promise<void>
  /** Makes every accepted line durable (PreCompact, spec §8.2). */
  flush(): Promise<void>
}

export interface JournalReader {
  /** Exchanges of one day folded by key, in `n` order. */
  fold(day: Day): Promise<Exchange[]>
  /** The last `n` exchanges across days, oldest first. */
  tail(n: number): Promise<Exchange[]>
  get(ref: JournalRef): Promise<Exchange | null>
  /** Days that have a journal file, ascending. */
  days(): Promise<Day[]>
}

/** Level 1 (`recent.md`): written by S1, read by S3 for the recent tail. */
export interface RecentReader {
  /** The exchanges `recent.md` currently holds, oldest first, each whole (`formatRecentEntry`). */
  exchanges(): Promise<Exchange[]>
}

/**
 * Rolling summary and daily digests: written by S4, read by S3 (HOT digest block, boundary
 * summary) and S6 (`/memory day`, `BrainStatus.last_digest`). Only validated output is returned.
 */
export interface SummaryReader {
  /** Lines of `recent-summary.md`, oldest first (`formatSummaryLine` / `parseSummaryLine`). */
  summary(): Promise<SummaryLine[]>
  /** The published digest of `day` (`digest/<day>.json`), or null. */
  digest(day: Day): Promise<Digest | null>
  /** Days with a published digest, ascending. */
  digestDays(): Promise<Day[]>
}

export interface PermitStore {
  put(permit: Permit): Promise<void>
  get(turnId: string): Promise<Permit | null>
  /** Unexpired permits at `now`, sorted by turn id. */
  live(now: Date): Promise<Permit[]>
  remove(turnId: string): Promise<void>
}

export interface ReceiptStore {
  /** Appends one write to the turn's receipt, creating it on first use. */
  add(turnId: string, journalRef: JournalRef | undefined, write: ReceiptWrite): Promise<Receipt>
  get(turnId: string): Promise<Receipt | null>
  /** A receipt exists for this journal ref (S4 skips such proposals). */
  hasJournalRef(ref: JournalRef): Promise<boolean>
}

export interface ProposalStore {
  add(proposal: Proposal): Promise<void>
  list(): Promise<Proposal[]>
  get(id: string): Promise<Proposal | null>
  remove(id: string): Promise<void>
}

/**
 * Session → scope registry. Unlike the other stores it lives above the scopes, in
 * `<brain_home>/sessions/`, because a hook knows only `session_id` and brain_home (slice plan K3)
 * and must find the scope from it. Unknown session → no personal memory until it is claimed.
 *
 * New bridge thread (spec §7.2, §13 item 3): the bridge calls `intend` before `thread/start`; the
 * thread's SessionStart hook calls `claim` with its `session_id`; after `thread/start` returns, the
 * bridge calls `register` with the thread id (it wins over a claim) and `withdraw`.
 */
export interface SessionRegistry {
  register(entry: SessionEntry): Promise<void>
  resolve(sessionId: string): Promise<SessionEntry | null>
  /** Records an intent valid for `SESSION_INTENT_TTL_MS` from `now`. */
  intend(intent: { scope: Scope; role: SessionIntent['role'] }, now: Date): Promise<SessionIntent>
  /**
   * SessionStart for a session `resolve` does not know (every source but `resume`); always
   * registers and returns an entry. A registered session → its entry, unchanged. Else, among the
   * intents live at `now`: none → `local` + `terminal`; all with one scope and role → that scope
   * and role, and the oldest of them is used up; different scopes or roles → `guest` in the
   * oldest intent's scope (no personal memory) and none is used up.
   */
  claim(sessionId: string, now: Date): Promise<SessionEntry>
  /** Removes an intent; a missing or already claimed intent is fine. */
  withdraw(intentId: string): Promise<void>
}

export interface SnapshotRequest {
  sessionId: string
  source: SessionSource
  /** The boundary this HOT belongs to (`beginBoundary` / `openBoundary`). */
  boundary: BoundaryId
}

export interface SnapshotBuilder {
  /**
   * Starts a new boundary of `sessionId`: mints a fresh id and stores it as the session's open
   * boundary, replacing the previous one. Called once per boundary by whoever sees it begin:
   * - `compact`: PreCompact (S5), or the bridge on `contextCompaction` start in degraded mode;
   *   SessionStart(compact) then builds with `openBoundary(sessionId)` when its source is
   *   `compact`, and begins one itself only when there is none (PreCompact not installed).
   * - `startup` / `clear`: the SessionStart step itself; no earlier event announces them.
   */
  beginBoundary(sessionId: string, source: SessionSource): Promise<BoundaryId>
  /** The boundary the session entered last, or null. */
  openBoundary(sessionId: string): Promise<OpenBoundary | null>
  /**
   * HOT text for `request.boundary`; stored per session and returned unchanged while the same
   * boundary is asked again, rebuilt from the current state for a new one. Empty for `resume`
   * (unless `resume_reemit`, then the stored bytes), `fork`, sessions whose role is not in
   * `PERSONAL_MEMORY_ROLES` or unregistered, and when Brain is disabled.
   */
  build(request: SnapshotRequest): Promise<string>
  /** `renderRecentTail(RecentReader.exchanges(), RECENT_TAIL_MAX_TOKENS)`. */
  recentTail(): Promise<string>
  /** One line per unseen out-of-band owner edit for this session, once (D9); usually empty. */
  delta(sessionId: string): Promise<string>
}

export interface HandoffRequest {
  sessionId: string
  turnId?: string
  trigger: Handoff['trigger']
}

export interface HandoffBuilder {
  /** Builds and stores `handoff/current.{json,md}` and a history copy; no model call. */
  write(request: HandoffRequest): Promise<Handoff>
  render(handoff: Handoff): string
  /** Rendered handoff if it belongs to `sessionId` and is not delivered yet; marks it delivered. */
  take(sessionId: string): Promise<string>
  current(): Promise<Handoff | null>
}

export interface SummaryRunResult {
  /** Evicted exchanges that got summary lines in this run. */
  summarized: number
  /** Proposals written to `pending/`. */
  proposals: number
  /** Evicted exchanges still waiting (failure or batch not full). */
  queued: number
  /** Evicted exchanges given up in this run (oversized or rejected too often). */
  skipped?: number
}

export interface SealRunResult {
  sealed: Day[]
  archived: Month[]
}

/** S4 background jobs, started by the bridge off the turn path (never inside a hook). */
export interface BrainJobs {
  /** Runs the rolling summary when `SUMMARY_BATCH` evictions are queued, or always with `force` (boundary). */
  summarize(signal: AbortSignal, force: boolean): Promise<SummaryRunResult>
  /** Seals finished days (digest + proposals) and archives days past retention. */
  sealDays(signal: AbortSignal): Promise<SealRunResult>
}

/** A JSON schema object passed to the structured-output call. */
export type JsonSchemaObject = Record<string, unknown>

/** Cheap structured model call (S4 adapter over `requestStructured`). Returns the raw JSON text. */
export type Summarizer = (prompt: string, schema: JsonSchemaObject, signal: AbortSignal) => Promise<string>

// ---------------------------------------------------------------- bridge-facing port (S6)

export interface TurnStartInput {
  sessionId: string
  /** `<chat-scope>:<owner_message_id>` or another stable key of the inbound message. */
  key: string
  origin: BrainOrigin
  inputKind: InputKind
  input?: string
  /** Why there is no `input`, e.g. a failed voice recognition (journal `error`). */
  error?: string
  /** Explicit "remember / correction" wording seen by the bridge (spec §7.3). */
  cue: boolean
}

export interface TurnTicket {
  sessionId: string
  key: string
  ref: JournalRef
  origin: BrainOrigin
}

export type TurnOutcome =
  | { status: 'delivered' }
  | { status: 'failed'; error: string }
  | { status: 'cancelled' }

/** What the bridge shows the owner after a turn: "💾 Сохранено …" or "не сохранено". */
export interface TurnNotice {
  saved: ReceiptWrite[]
  /** The store could not be written in this turn. */
  unavailable: boolean
}

export interface PlanUpdate {
  sessionId: string
  turnId: string
  explanation?: string
  steps: PlanStep[]
}

export interface CompactionEvent {
  sessionId: string
  /** `context-delivered`: `hook/completed` for SessionStart after a `contextCompaction` item. */
  phase: 'started' | 'completed' | 'context-delivered'
}

export interface MemoryButton {
  label: string
  /** Callback payload; Telegram allows at most 64 bytes. */
  data: string
}

export interface MemoryRequest {
  /** Text after `/memory`, trimmed. */
  args: string
  /** Payload of a pressed button, when the request comes from one. */
  callback?: string
  /** The request comes from the owner in the private chat; everything else is refused. */
  ownerPrivateChat: boolean
}

export interface MemoryReply {
  text: string
  buttons: MemoryButton[][]
}

export interface BrainPort {
  /**
   * Before `thread/start`: records a session intent (`SessionRegistry.intend`) so the new
   * thread's SessionStart hook can claim it. Returns the intent id; null when Brain is disabled
   * or the store is unavailable.
   */
  sessionStarting(role: SessionIntent['role']): Promise<string | null>
  /**
   * After `thread/start` (or resume) returned the thread id: registers it before its first turn
   * (spec §7.2) and withdraws `intent`, claimed or not.
   */
  sessionStarted(sessionId: string, role: SessionRole, intent?: string): Promise<void>
  /** Journal `bound` before `turn/start`; null when Brain is disabled or the store is unavailable. */
  turnStarting(input: TurnStartInput): Promise<TurnTicket | null>
  /** Writes the turn permit once the turn id is known. */
  turnStarted(ticket: TurnTicket, turnId: string): Promise<void>
  /** Journal `answered` before the reply is sent. */
  turnAnswered(ticket: TurnTicket, reply: string): Promise<void>
  /** Journal `delivered` / `failed` / `cancelled`; returns what to show the owner. */
  turnDelivered(ticket: TurnTicket, outcome: TurnOutcome): Promise<TurnNotice>
  planUpdated(update: PlanUpdate): Promise<void>
  openQuestions(sessionId: string, questions: string[]): Promise<void>
  compactionSeen(event: CompactionEvent): Promise<void>
  /** Degraded mode only: HOT (+ handoff) to prepend to the first owner turn of a thread, else ''. */
  firstTurnContext(sessionId: string): Promise<string>
  status(): Promise<BrainStatus>
  memoryCommand(request: MemoryRequest): Promise<MemoryReply>
}
