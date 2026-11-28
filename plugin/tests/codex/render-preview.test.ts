import { expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'

import { agentTools } from '../../src/codex/chat-actions.js'
import { RenderEyes } from '../../src/codex/render-eyes.js'
import { draftSend, renderPreview, type PreviewToolResult } from '../../src/codex/render-preview.js'
import { markdownToTelegramHtml } from '../../src/format/html.js'

const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const dataPrefix = 'data:image/png;base64,'

function png(result: PreviewToolResult): Buffer {
  const image = result.contentItems[1]
  if (image?.type !== 'inputImage') throw new Error('The preview carries no image')
  expect(image.imageUrl.startsWith(dataPrefix)).toBe(true)
  return Buffer.from(image.imageUrl.slice(dataPrefix.length), 'base64')
}

// Walks the PNG chunks: the header sizes and the inflated pixel rows must agree (8-bit RGB, one filter byte a row).
function decoded(buffer: Buffer): { width: number; height: number; rows: number } {
  expect([...buffer.subarray(0, 8)]).toEqual(signature)
  let offset = 8
  let width = 0
  let height = 0
  const data: Buffer[] = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      expect([body[8], body[9]]).toEqual([8, 2])
    }
    if (type === 'IDAT') data.push(body)
    offset += 12 + length
  }
  const pixels = inflateSync(Buffer.concat(data))
  expect(pixels.length).toBe(height * (1 + width * 3))
  return { width, height, rows: height }
}

test('[R42] render_preview is offered to trusted threads next to the component tools', () => {
  expect(agentTools.map(tool => tool.name)).toContain('render_preview')
})

test('[R42] a draft document body masks a token exposed by plain conversion', () => {
  // The blank pre falls back to a file. Plain conversion includes the link destination and decodes its colon.
  const draft = '<pre><a href="https://example.invalid/123456789&#58;' + 'sample-'.repeat(5) + '"> </a></pre>'
  const options = { shown: () => undefined, secrets: [] }
  const preview = renderPreview({ text: draft }, options)
  const masked = renderPreview({ text: '<pre><a href="https://example.invalid/[REDACTED]"> </a></pre>' }, options)
  expect(JSON.parse(preview.contentItems[0].text)).toMatchObject({ formats: ['document'] })
  expect(png(preview).equals(png(masked))).toBe(true)
})

test('[R42] a draft masks a token that markup separates from its prefix in the shown text', () => {
  // Masking runs on the text Telegram shows, where the bold tags no longer separate `Bearer` and the value.
  const value = 'mock-value-123'
  const options = { shown: () => undefined, secrets: [] }
  const preview = renderPreview({ text: '[link](file:///tmp/x) Bearer **' + value + '**' }, options)
  const masked = renderPreview({ text: '[link](file:///tmp/x) Bearer **[REDACTED]**' }, options)
  expect(JSON.parse(preview.contentItems[0].text)).toMatchObject({ formats: ['HTML'] })
  expect(png(preview).equals(png(masked))).toBe(true)
})

test('[R42] render_preview returns a Telegram-like PNG of a draft and of a sent message', () => {
  const eyes = new RenderEyes({})
  const options = { shown: (id: number) => eyes.shown(id), secrets: [] }
  const draft = renderPreview({ text: 'Привет, **мир**!\n\n```\nconst x = 1\n```\n\nTom &amp; Jerry' }, options)
  expect(draft.success).toBe(true)
  const image = decoded(png(draft))
  expect(image.width).toBeGreaterThan(0)
  expect(image.height).toBeGreaterThan(0)
  const facts: unknown = JSON.parse(draft.contentItems[0].text)
  expect(facts).toMatchObject({ tool: 'render_preview', ok: true, source: 'draft',
    degradations: [expect.objectContaining({ kind: 'raw_markup', shown: '&amp;' })] })

  eyes.record({ source: '**Готово**', parts: [{ format: 'HTML', text: markdownToTelegramHtml('**Готово**'), messageId: 55 }] })
  const sent = renderPreview({ message_id: 55 }, options)
  expect(sent.success).toBe(true)
  decoded(png(sent))

  const unknown = renderPreview({ message_id: 56 }, options)
  expect(unknown.success).toBe(false)
  expect(unknown.contentItems).toHaveLength(1)
  const both = renderPreview({ message_id: 55, text: 'x' }, options)
  expect(both.success).toBe(false)
})

test('[R42] a draft never draws a secret that markup splits in the source', () => {
  // The picture is drawn from these parts: the masked shown text, as the send delivers it.
  expect(draftSend('Ключ MA**SK**ME тут', ['MASKME']).parts).toEqual([{ format: 'HTML', text: 'Ключ [REDACTED] тут' }])
  const preview = renderPreview({ text: 'Ключ MA**SK**ME тут' }, { shown: () => undefined, secrets: ['MASKME'] })
  expect(JSON.parse(preview.contentItems[0].text)).toMatchObject({ formats: ['HTML'] })
})
