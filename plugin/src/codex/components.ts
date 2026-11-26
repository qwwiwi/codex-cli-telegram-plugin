// Telegram widget components for the Codex model: send_component,
// update_component and component_schema. Data is rendered by the vendored
// html-components Telegram packs (plugin/vendor/html-components, pinned
// commit in its VENDOR.md); nothing is fetched at runtime. When a widget
// cannot be shown, the same data goes out once as plain text.
// Ported from the Claude Code version of the plugin (channel/components.ts).

import { readFileSync } from 'node:fs'

import { renderComponent, templates, validate } from '../../vendor/html-components/index.mjs'
import type { SendMessageOpts, SendWidgetParams, TelegramApi } from '../channel/tools.js'
import { checkWidgetChat, checkWidgetPayload, WIDGET_CAPTION_MAX_CHARS } from '../channel/widget.js'
import { TELEGRAM_MAX_MESSAGE } from '../format/chunk.js'
import { WidgetPreSendError } from '../safety/pre-send-error.js'
import { redactSecrets } from '../safety/redact.js'
import { classifySendError } from '../safety/reliable-telegram-api.js'
import { object } from './rpc.js'

// The 16 vendored packs (a test pins this list to the packs/ folder).
export const COMPONENT_NAMES = [
  'kpi', 'bars', 'progress', 'steps', 'compare', 'pros-cons', 'faq', 'status',
  'flowchart', 'architecture', 'line-area', 'donut', 'timeline-roadmap', 'radar', 'bars3d', 'network3d',
] as const
export type ComponentName = typeof COMPONENT_NAMES[number]

// Keep the root relay's validated catalog (codex-root-relay.py) in sync with these tools.
export const componentTools = [
  {
    type: 'function',
    name: 'send_component',
    description: 'Send data to the Telegram owner as a visual widget instead of a wall of text. ' +
      'Call component_schema first for the exact data fields. At most one component per answer. ' +
      'If the widget cannot be shown, the data is sent as plain text and the result says so: then do not resend it.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['component', 'data'],
      properties: {
        component: { type: 'string', enum: COMPONENT_NAMES },
        data: { type: 'object' },
        caption: { type: 'string', maxLength: 1024 },
        target: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    type: 'function',
    name: 'update_component',
    description: 'Show new data for a component sent earlier: sends a new widget and deletes the old one. ' +
      'message_id must come from send_component or update_component of this bridge run.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['message_id', 'component', 'data'],
      properties: {
        message_id: { type: 'integer', minimum: 1 },
        component: { type: 'string', enum: COMPONENT_NAMES },
        data: { type: 'object' },
      },
    },
  },
  {
    type: 'function',
    name: 'component_schema',
    description: 'Return the JSON schema of the data and a working example for one component. Sends nothing.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['component'],
      properties: { component: { type: 'string', enum: COMPONENT_NAMES } },
    },
  },
] as const
export type ComponentTool = typeof componentTools[number]['name']

export function isComponentTool(name: unknown): name is ComponentTool {
  return componentTools.some(tool => tool.name === name)
}

export const componentInstructions =
  'Для данных, процесса или плана есть инструменты send_component, update_component и component_schema: ' +
  'числа и доли (kpi, bars, donut, bars3d, progress), тренд (line-area), шаги и процесс (steps, flowchart), ' +
  'система и связи (architecture, network3d), план с датами (timeline-roadmap), сравнение (compare, radar, pros-cons), ' +
  'вопросы и ответы (faq), статус работы (status). Перед первым использованием вызови component_schema. ' +
  'Короткий ответ, мнение или разговор отправляй текстом, не компонентом. Не больше одного компонента на ответ. ' +
  'Если виджет показан, в финальном ответе напиши 1–2 строки о том, что показывает компонент. Если данные ушли текстом, ' +
  'не отправляй их повторно и не сообщай о сбое: заверши ход пустым финальным ответом. Если статус доставки неизвестен, ' +
  'не отправляй данные повторно. update_component принимает только message_id из send_component или update_component.'

// Longest final answer after a text fallback that still counts as the 1–2 line component note, not content.
const fallbackNoteChars = 300
const fallbackNoteLines = 2

// What the bridge does with the visible final answer of a turn that sent a component (`delivery`: the turn's
// component outcome, `text` when any of them fell back to plain text). An empty final is dropped: the component
// already answered. After a text fallback the owner already has the data, so a short note without a question
// (the component note the instructions ask for, or a report of the failure) is dropped as well.
export function finalAfterComponents(text: string, delivery: 'widget' | 'text' | undefined): 'send' | 'drop' {
  if (delivery === undefined) return 'send'
  const visible = text.trim()
  if (visible.length === 0) return 'drop'
  if (delivery !== 'text') return 'send'
  const lines = visible.split('\n').filter(line => line.trim().length > 0).length
  return lines <= fallbackNoteLines && visible.length <= fallbackNoteChars && !visible.includes('?') ? 'drop' : 'send'
}

function isComponentName(value: unknown): value is ComponentName {
  return COMPONENT_NAMES.some(name => name === value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMessageId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

const errorHints: Record<string, string> = {
  UNKNOWN_PACK: 'нет такого компонента',
  INVALID_DATA: 'данные не подходят под схему компонента',
  HTML_LIMIT: 'слишком много данных для одного виджета',
}

type Render = { ok: true; html: string; caption: string; variant?: 'static' } | { ok: false; reason: string }

// Never throws: a renderer exception becomes a RENDER_ERROR reason.
export function renderComponentWidget(name: ComponentName, data: unknown): Render {
  try {
    const out = renderComponent(name, data)
    if (out.error !== undefined) return { ok: false, reason: `${out.error.code}: ${errorHints[out.error.code] ?? 'отказ рендера'}` }
    return { ok: true, html: out.html, caption: out.caption, ...(out.variant === 'static' ? { variant: 'static' as const } : {}) }
  } catch (error) {
    return { ok: false, reason: `RENDER_ERROR: ${errorText(error)}` }
  }
}

// Schema and example of one pack, straight from the vendored files.
export function componentSchema(name: ComponentName): { component: ComponentName; schema: unknown; example: unknown } {
  const dir = new URL(`../../vendor/html-components/telegram/packs/${name}/`, import.meta.url)
  const read = (file: string): unknown => JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as unknown
  return { component: name, schema: read('schema.json'), example: read('example.json') }
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

// Shape-agnostic text for data the pack caption cannot handle. Depth-capped.
function flatten(value: unknown, depth: number): string[] {
  if (depth > 6 || value === null || value === undefined) return []
  if (isPrimitive(value)) return [String(value)]
  if (Array.isArray(value)) {
    if (value.every(isPrimitive)) return value.length > 0 ? [value.map(String).join(' · ')] : []
    return value.flatMap(item => flatten(item, depth + 1))
  }
  if (typeof value === 'object') {
    const entries = Object.values(value as Record<string, unknown>)
    const head = entries.filter(isPrimitive).map(String).join(' ')
    const rest = entries.filter(entry => !isPrimitive(entry)).flatMap(entry => flatten(entry, depth + 1))
    return head.length > 0 ? [head, ...rest] : rest
  }
  return []
}

// Plain text of the data for a reply without a widget: the pack's own caption
// for valid data, a generic flattening otherwise. Redacted before the cap, so
// a cut cannot split a secret into an unrecognisable prefix.
export function componentFallbackText(name: ComponentName, data: Record<string, unknown>, header: string | undefined,
  redact: (text: string) => string): string {
  const title = typeof data.title === 'string' ? data.title : undefined
  let body: string | undefined
  const template = templates[name]
  if (template !== undefined && validate(name, data)) {
    try { body = template.caption(data) } catch { body = undefined }
  }
  if (body === undefined) {
    const { title: _title, ...rest } = data
    body = flatten(rest, 0).join('\n')
  }
  const text = [header, title, body].filter((part): part is string => part !== undefined && part.trim().length > 0).join('\n')
  const safe = redact(text.length > 0 ? text : `(${name}: нет данных)`)
  return safe.length <= TELEGRAM_MAX_MESSAGE ? safe : safe.slice(0, TELEGRAM_MAX_MESSAGE - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…'
}

// True when the redactor would change any key or primitive value of the raw
// model data. Checked before rendering: the rendered html escapes characters
// (`&` becomes `&amp;`), so a secret is no longer recognisable in it.
function carriesSecret(value: unknown, redact: (text: string) => string, depth = 0): boolean {
  if (depth > 32) return true
  if (isPrimitive(value)) return redact(String(value)) !== String(value)
  if (Array.isArray(value)) return value.some(item => carriesSecret(item, redact, depth + 1))
  if (isPlainObject(value)) {
    return Object.entries(value).some(([key, item]) => redact(key) !== key || carriesSecret(item, redact, depth + 1))
  }
  return false
}

export type ComponentApi = Pick<TelegramApi, 'sendWidget' | 'sendMessage' | 'deleteMessage'>

type ComponentOptions = {
  // Runs before any send: the bridge waits here for the HUD card so the chat reads card, then answer.
  beforeSend?: () => Promise<void>
  // Configured redaction for the plain-text version. Default: the built-in patterns.
  redact?: (text: string) => string
}

export type ComponentOutcome = {
  ok: boolean
  message_ids: number[]
  delivery?: 'widget' | 'text' | 'unknown'
  variant?: 'static'
  replaced?: number
  hint?: string
  component?: ComponentName
  schema?: unknown
  example?: unknown
}

type Delivery =
  | { kind: 'widget'; messageId: number; variant?: 'static' }
  | { kind: 'text'; messageId: number; reason: string }
  | { kind: 'unknown'; reason: string }
  | { kind: 'failed'; reason: string }

function errorText(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300)
}

// The failure may have happened after Telegram took the request: the message may be on screen.
function isAmbiguous(error: unknown): boolean {
  return !(error instanceof WidgetPreSendError) && classifySendError(error, 0).kind === 'ambiguous'
}

function isMissingReplyTarget(error: unknown): boolean {
  if (classifySendError(error, 0).kind !== 'permanent') return false
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return text.includes('message to be replied not found') || text.includes('replied message not found')
}

// A 400 whose Telegram code ends in ALLOWED (`*_NOT_ALLOWED`): the request shape is refused, not the data. The live
// refusal of a widget threaded under a voice message had this shape; the exact code was masked, so the bridge
// retries such a refusal once without reply_parameters, the only optional part of the request.
function isNotAllowed(error: unknown): boolean {
  if (classifySendError(error, 0).kind !== 'permanent') return false
  const status = typeof error === 'object' && error !== null ? (error as { error_code?: unknown }).error_code : undefined
  return status === 400 && /\b[A-Z][A-Z_]*ALLOWED\b/.test(error instanceof Error ? error.message : String(error))
}

// Ids of the messages this process sent as components; update_component may
// delete only these. In memory: after a restart the model sends a new component.
const registryLimit = 200

export class AgentComponents {
  private readonly sent = new Set<number>()

  constructor(private readonly api: ComponentApi, private readonly ownerChat: string,
    private readonly options: ComponentOptions = {}) {}

  // Runs one component tool call. Never throws; `known` says whether a reply target is a known chat message,
  // `current` whether the turn may still act (checked again after the wait for the HUD card).
  async run(tool: string, raw: unknown, known: (id: number) => boolean,
    current: () => boolean = () => true): Promise<ComponentOutcome> {
    try {
      return await this.dispatch(tool, object(raw), known, current)
    } catch (error) {
      return { ok: false, message_ids: [], hint: `Telegram не выполнил действие: ${errorText(error)}` }
    }
  }

  private async dispatch(tool: string, args: Record<string, unknown>, known: (id: number) => boolean,
    current: () => boolean): Promise<ComponentOutcome> {
    const invalid: ComponentOutcome = { ok: false, message_ids: [], hint: 'Некорректные параметры компонента.' }
    const allowed = componentTools.find(entry => entry.name === tool)
    if (!allowed || Object.keys(args).some(key => !Object.hasOwn(allowed.inputSchema.properties, key)) ||
        !isComponentName(args.component)) return invalid
    const component = args.component
    if (tool === 'component_schema') return { ok: true, message_ids: [], ...componentSchema(component) }
    if (!isPlainObject(args.data)) return invalid
    const data = args.data
    if (tool === 'send_component') {
      const caption = args.caption
      const target = args.target
      if ((caption !== undefined && (typeof caption !== 'string' || caption.length === 0 || caption.length > 1024)) ||
          (target !== undefined && (!isMessageId(target) || !known(target)))) return invalid
      const out = await this.deliver(component, data, caption, target, current)
      return this.outcome(out)
    }
    const old = args.message_id
    if (!isMessageId(old) || !this.sent.has(old)) {
      return { ok: false, message_ids: [], hint: 'message_id не является компонентом, отправленным в этом запуске моста. ' +
        'Ничего не отправлено и не удалено; отправь новый компонент через send_component.' }
    }
    const out = await this.deliver(component, data, undefined, undefined, current)
    const result = this.outcome(out)
    if (out.kind === 'widget') {
      try {
        await this.api.deleteMessage(this.ownerChat, old)
        this.sent.delete(old)
      } catch (error) {
        result.hint = `Старый компонент ${old} удалить не удалось (${errorText(error)}). Дальше используй новый message_id.`
      }
      return { ...result, replaced: old }
    }
    result.hint = `${result.hint ?? ''} Старый компонент ${old} оставлен с прежними данными.`.trim()
    return result
  }

  private outcome(out: Delivery): ComponentOutcome {
    if (out.kind === 'widget') {
      this.record(out.messageId)
      return { ok: true, message_ids: [out.messageId], delivery: 'widget', ...(out.variant ? { variant: out.variant } : {}) }
    }
    if (out.kind === 'text') {
      this.record(out.messageId)
      return { ok: true, message_ids: [out.messageId], delivery: 'text',
        hint: `Виджет не показан (${out.reason}). Владелец получил те же данные обычным текстом, не отправляй их повторно ` +
          'и не сообщай о сбое отдельным сообщением: заверши ход пустым финальным ответом. ' +
          'Для виджета в следующий раз проверь поля через component_schema.' }
    }
    if (out.kind === 'unknown') {
      return { ok: false, message_ids: [], delivery: 'unknown',
        hint: `Статус доставки неизвестен: ${out.reason}. Компонент мог уже появиться в чате, не отправляй его повторно вслепую.` }
    }
    return { ok: false, message_ids: [], hint: out.reason }
  }

  private record(id: number): void {
    this.sent.delete(id)
    this.sent.add(id)
    if (this.sent.size > registryLimit) this.sent.delete(this.sent.values().next().value!)
  }

  // Render and send the widget; any reason it cannot be shown degrades to a
  // plain-text version of the same data. The widget send is one attempt; an
  // ambiguous failure gets no text copy (it could double-post).
  private async deliver(component: ComponentName, data: Record<string, unknown>, caption: string | undefined,
    target: number | undefined, current: () => boolean): Promise<Delivery> {
    const redact = this.options.redact ?? ((text: string): string => redactSecrets(text))
    await this.options.beforeSend?.()
    if (!current()) return { kind: 'failed', reason: 'Ход остановлен, компонент не отправлен.' }
    let replyTo = target
    let reason = checkWidgetChat(this.ownerChat) ??
      (carriesSecret(data, redact) ? 'данные содержат секрет, он скрыт в текстовой версии' : undefined)
    if (reason === undefined) {
      const rendered = renderComponentWidget(component, data)
      if (!rendered.ok) reason = rendered.reason
      else {
        const params: SendWidgetParams = {
          html: rendered.html,
          caption: caption ?? (rendered.caption.length > 0 ? rendered.caption
            : componentFallbackText(component, data, undefined, redact).slice(0, WIDGET_CAPTION_MAX_CHARS)),
          ...(replyTo !== undefined ? { reply_to_message_id: replyTo } : {}),
        }
        reason = checkWidgetPayload(params)
        let attempt = params
        while (reason === undefined) {
          try {
            const sent = await this.api.sendWidget(this.ownerChat, attempt)
            return { kind: 'widget', messageId: sent.message_id, ...(rendered.variant ? { variant: rendered.variant } : {}) }
          } catch (error) {
            if (isAmbiguous(error)) return { kind: 'unknown', reason: `отправка виджета прервалась (${errorText(error)})` }
            // A flood wait is still running: any text copy now would be one more send into it.
            if (classifySendError(error, 0).kind === 'rate_limited') {
              return { kind: 'failed', reason: 'Telegram ограничил частоту отправки, ничего не отправлено. Повтори позже.' }
            }
            // A 400 is a refusal: nothing was shown, so one more widget without the reply cannot double-post.
            if (attempt.reply_to_message_id !== undefined && isNotAllowed(error) && current()) {
              const { reply_to_message_id: _dropped, ...unthreaded } = attempt
              attempt = unthreaded
              continue
            }
            if (replyTo !== undefined && isMissingReplyTarget(error)) replyTo = undefined
            reason = `Telegram не принял виджет: ${errorText(error)}`
          }
        }
      }
    }
    // The widget request may have taken long enough for the owner to stop the turn.
    if (!current()) return { kind: 'failed', reason: `Виджет не показан (${reason}), ход остановлен, текстовая версия не отправлена.` }
    const text = componentFallbackText(component, data, caption, redact)
    const send =(threadUnder: number | undefined): Promise<{ message_id: number }> => {
      const opts: SendMessageOpts = threadUnder === undefined ? {} : { reply_to_message_id: threadUnder }
      return this.api.sendMessage(this.ownerChat, text, opts)
    }
    try {
      let sent: { message_id: number }
      try { sent = await send(replyTo) } catch (error) {
        if (replyTo === undefined || !isMissingReplyTarget(error)) throw error
        sent = await send(undefined)
      }
      return { kind: 'text', messageId: sent.message_id, reason }
    } catch (error) {
      if (isAmbiguous(error)) {
        return { kind: 'unknown', reason: `виджет не показан (${reason}), текстовая версия прервалась (${errorText(error)})` }
      }
      return { kind: 'failed', reason: `Виджет не показан (${reason}), текстовая версия тоже не ушла (${errorText(error)}). В чат ничего не попало.` }
    }
  }
}
