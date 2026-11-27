// R42 render_preview: a client-owned tool of trusted threads, next to the component tools. It returns a
// Telegram-like PNG of a reply this bridge run sent (by message ID) or of a draft rendered the way the bridge would
// send it, plus the facts as text (parts, formats, what the owner would see raw). It sends nothing to Telegram.
// Keep the root relay's validated catalog (codex-root-relay.py) in sync with this tool.

import { PreformattedDocumentError, plainTextWithLinks, splitMessage, splitPlainFallback } from '../format/chunk.js'
import { markdownToTelegramHtml } from '../format/html.js'
import { splitLongBlock } from '../format/paragraphs.js'
import { renderTelegramPng, type PreviewBubble } from '../format/render-png.js'
import { validateTelegramHtml } from '../safety/html-validator.js'
import { redactSecrets } from '../safety/redact.js'
import { normalizeChatReply } from './continuation.js'
import { diffRender, type RenderSend, type ShownPart } from './render-eyes.js'
import { object } from './rpc.js'

const draftMax = 3900

export const renderPreviewTool = {
  type: 'function',
  name: 'render_preview',
  description: 'Show yourself how a message looks in the owner\'s Telegram, as a PNG picture with the facts: ' +
    'message_id of a reply this bridge sent in this run, or text of a draft rendered the way the bridge sends it. ' +
    'Give exactly one of them. Sends nothing to Telegram.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      message_id: { type: 'integer', minimum: 1 },
      text: { type: 'string', maxLength: draftMax },
    },
  },
} as const

// Part of the static channel rules (agentChatInstructions), so it never changes the cached prefix between turns.
export const renderPreviewInstructions =
  'render_preview показывает тебе PNG того, как сообщение выглядит у владельца в Telegram: по message_id своего ' +
  'отправленного ответа или по черновику в text. Владельцу он ничего не отправляет. Если мост написал, что Telegram ' +
  'показал твой ответ не так, проверь черновик через render_preview перед отправкой.'

export function isRenderPreviewTool(name: unknown): name is typeof renderPreviewTool.name {
  return name === renderPreviewTool.name
}

// Type aliases, not interfaces: the result goes back to Codex as an RPC `Json` value (Record<string, unknown>),
// and only an object type alias gets the implicit index signature that assignment needs.
type TextItem = {
  type: 'inputText'
  text: string
}
type ImageItem = {
  type: 'inputImage'
  imageUrl: string
}
/** The tool result: the facts as JSON text, then the PNG as a data URL when there is a picture. */
export type PreviewToolResult = {
  success: boolean
  contentItems: [TextItem, ...ImageItem[]]
}

export interface RenderPreviewOptions {
  /** A part this bridge run sent to the owner (RenderEyes.shown). */
  shown: (messageId: number) => ShownPart | undefined
  secrets: readonly string[]
}

function refused(hint: string): PreviewToolResult {
  return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ tool: renderPreviewTool.name, ok: false, hint }) }] }
}

/** The parts the bridge would send for `text` on its HTML path (the final reply's renderer, chunker and validator). */
export function draftSend(text: string, secrets: readonly string[]): RenderSend {
  const source = redactSecrets(text, secrets)
  const html = markdownToTelegramHtml(splitLongBlock(normalizeChatReply(source)))
  let planned: string[]
  try {
    planned = splitMessage(html)
  } catch (error) {
    if (!(error instanceof PreformattedDocumentError)) throw error
    return { source, parts: [{ format: 'document', text: plainTextWithLinks(error.html, Infinity) }] }
  }
  const parts: ShownPart[] = []
  let brokenHtml = 0
  for (const part of planned) {
    if (!validateTelegramHtml(part).downgraded) {
      parts.push({ format: 'HTML', text: part })
      continue
    }
    brokenHtml += 1
    for (const piece of splitPlainFallback(part)) parts.push({ format: 'plain', text: piece })
  }
  return { source, parts, brokenHtml }
}

function bubble(part: ShownPart): PreviewBubble {
  const id = part.messageId === undefined ? '' : ' #' + part.messageId
  switch (part.format) {
    case 'HTML': return { html: part.text, markup: true, label: 'HTML' + id }
    // Telegram renders a Rich Message's Markdown itself: the bridge's own HTML rendering approximates it.
    case 'rich': return { html: markdownToTelegramHtml(part.text), markup: true, label: 'rich, approx.' + id }
    case 'plain': return { html: part.text, markup: false, label: 'plain text' + id }
    case 'document': return { html: part.text, markup: false, label: 'file reply.txt' + id }
  }
}

/** Runs render_preview for the tool arguments `raw`. Never throws: a failure is a refused result with a hint. */
export function renderPreview(raw: unknown, options: RenderPreviewOptions): PreviewToolResult {
  try {
    const args = object(raw)
    const { message_id: messageId, text } = args
    if (Object.keys(args).some(key => key !== 'message_id' && key !== 'text') || (messageId === undefined) === (text === undefined)) {
      return refused('Укажи ровно одно: message_id отправленного ответа или text черновика.')
    }
    let send: RenderSend
    if (messageId !== undefined) {
      if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId < 1) return refused('message_id должен быть целым числом больше нуля.')
      const part = options.shown(messageId)
      if (!part) return refused('Этого сообщения нет среди ответов моста в этом запуске. Передай текст черновиком в text.')
      send = { source: '', parts: [part] }
    } else {
      if (typeof text !== 'string' || text.trim() === '' || text.length > draftMax) return refused(`text: непустая строка до ${draftMax} знаков.`)
      send = draftSend(text, options.secrets)
    }
    const png = renderTelegramPng(send.parts.map(bubble))
    const { degradations, collapsedBlankLines } = diffRender(send)
    const facts = {
      tool: renderPreviewTool.name, ok: true, source: messageId !== undefined ? 'message' : 'draft',
      parts: send.parts.length, formats: send.parts.map(part => part.format), collapsedBlankLines,
      degradations: degradations.map(item => ({ ...item, shown: redactSecrets(item.shown, options.secrets).slice(0, 60) })),
      hint: 'Картинка – приближение Telegram (растровый шрифт моста), не снимок клиента: смотри на строки, блоки и то, что видно как символы.',
    }
    return { success: true, contentItems: [
      { type: 'inputText', text: JSON.stringify(facts) },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,' + Buffer.from(png).toString('base64') },
    ] }
  } catch {
    return refused('Не удалось нарисовать превью.')
  }
}
