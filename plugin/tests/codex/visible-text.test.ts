// VisibleText: render, mask, cut. Property tests over random HTML: the pieces of a cut join back to the masked
// text exactly, every entity stays in bounds, and no registered value survives masking.
import { expect, test } from 'bun:test'

import { cut, cutPoints, mask, maskWithEdits, mapPosition, render, type Entity, type VisibleText } from '../../src/format/visible.js'
import { PreformattedDocumentError } from '../../src/format/chunk.js'
import { MaskFixedPointError } from '../../src/safety/pre-send-error.js'
import { redactSecrets, redactWithEdits } from '../../src/safety/redact.js'

const VALUE = 'MASKME'

// Deterministic PRNG so a failure reproduces.
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

const FRAGMENTS = ['MA', 'SK', 'ME', VALUE, 'текст ', 'word ', '\n', '\n\n', '😀', '&amp;', '&#83;', '&lt;', ' ',
  '<b>', '</b>', '<i>', '</i>', '<code>', '</code>', '<pre>', '</pre>', '<a href="https://x.org/p">', '</a>',
  '<blockquote>', '</blockquote>', '<tg-spoiler>', '</tg-spoiler>', '<u>', '</u>', 'Bearer ', 'PLACEHOLDERWORD', '<br>']

function randomHtml(next: () => number, pieces: number): string {
  let html = ''
  for (let i = 0; i < pieces; i++) html += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]
  return html
}

function expectInBounds(visible: VisibleText): void {
  for (const entity of visible.entities) {
    expect(entity.offset).toBeGreaterThanOrEqual(0)
    expect(entity.length).toBeGreaterThan(0)
    expect(entity.offset + entity.length).toBeLessThanOrEqual(visible.text.length)
  }
}

test('render: HTML tags become entities over the shown text; unknown tags stay literal', () => {
  expect(render('<b>Жирный</b> и <a href="https://e.org/?a=1&amp;b=2">ссылка</a> <foo>', 'HTML')).toEqual({
    text: 'Жирный и ссылка <foo>',
    entities: [
      { type: 'bold', offset: 0, length: 6 },
      { type: 'text_link', offset: 9, length: 6, url: 'https://e.org/?a=1&b=2' },
    ],
  })
  expect(render('<pre><code class="language-ts">x</code></pre>', 'HTML'))
    .toEqual({ text: 'x', entities: [{ type: 'pre', offset: 0, length: 1, language: 'ts' }] })
  expect(render('<blockquote expandable>a</blockquote>', 'HTML').entities)
    .toEqual([{ type: 'expandable_blockquote', offset: 0, length: 1 }])
  // Telegram forbids styles inside code: the text stays, the inner entity is left out.
  expect(render('<code>a<b>b</b></code>', 'HTML'))
    .toEqual({ text: 'ab', entities: [{ type: 'code', offset: 0, length: 2 }] })
  // A link target the bridge does not send as a link keeps its label as plain text.
  expect(render('<a href="javascript:x">l</a>', 'HTML')).toEqual({ text: 'l', entities: [] })
})

test('render: MarkdownV2 is read strictly; input that does not parse is literal text', () => {
  expect(render('*жир* _курсив_ __под__ ~зач~ ||спойлер|| `код` [л](https://e.org) \\.', 'MarkdownV2')).toEqual({
    text: 'жир курсив под зач спойлер код л .',
    entities: [
      { type: 'bold', offset: 0, length: 3 },
      { type: 'italic', offset: 4, length: 6 },
      { type: 'underline', offset: 11, length: 3 },
      { type: 'strikethrough', offset: 15, length: 3 },
      { type: 'spoiler', offset: 19, length: 7 },
      { type: 'code', offset: 27, length: 3 },
      { type: 'text_link', offset: 31, length: 1, url: 'https://e.org' },
    ],
  })
  expect(render('```py\nprint(1)\n```', 'MarkdownV2'))
    .toEqual({ text: 'print(1)\n', entities: [{ type: 'pre', offset: 0, length: 9, language: 'py' }] })
  expect(render('a.b *open', 'MarkdownV2')).toEqual({ text: 'a.b *open', entities: [] })
  expect(render('<b>x</b>', undefined)).toEqual({ text: '<b>x</b>', entities: [] })
})

test('mask: a value split by markup or written as a numeric entity is masked in the shown text', () => {
  for (const html of ['MA<b>SK</b>ME', 'MA&#83;KME', '<i>MASK</i>ME']) {
    const visible = mask(render(html, 'HTML'), [VALUE])
    expect(visible.text).toBe('[REDACTED]')
    expectInBounds(visible)
  }
})

test('mask: entities clip to the surviving text, a touched link is dropped, a hidden value drops its link', () => {
  const styled = mask(render('<b>ab MASK</b>ME cd', 'HTML'), [VALUE])
  expect(styled).toEqual({ text: 'ab [REDACTED] cd', entities: [{ type: 'bold', offset: 0, length: 3 }] })
  const around = mask(render('<b>x MASKME y</b>', 'HTML'), [VALUE])
  expect(around.entities).toEqual([{ type: 'bold', offset: 0, length: around.text.length }])
  const label = mask(render('<a href="https://e.org">MASK</a>ME', 'HTML'), [VALUE])
  expect(label).toEqual({ text: '[REDACTED]', entities: [] })
  const hidden = mask(render(`<a href="https://e.org/${VALUE}">док</a>`, 'HTML'), [VALUE])
  expect(hidden).toEqual({ text: 'док', entities: [] })
  const language = mask({ text: 'x', entities: [{ type: 'pre', offset: 0, length: 1, language: VALUE }] }, [VALUE])
  expect(language.entities).toEqual([{ type: 'pre', offset: 0, length: 1 }])
  const odd = mask({ text: 'x', entities: [{ type: 'pre', offset: 0, length: 1, language: 'a b' }] }, [])
  expect(odd.entities).toEqual([{ type: 'pre', offset: 0, length: 1 }])
})

test('mask: a value overlapping the marker never settles and fails closed', () => {
  expect(() => mask({ text: 'MASKME', entities: [] }, [VALUE, 'DACT'])).toThrow(MaskFixedPointError)
})

test('redactWithEdits: its text is redactSecrets and its edits rebuild it', () => {
  const next = rng(7)
  for (let round = 0; round < 300; round++) {
    const text = randomHtml(next, 12)
    const { text: masked, passes } = redactWithEdits(text, [VALUE])
    expect(masked).toBe(redactSecrets(text, [VALUE]))
    let replay = text
    for (const edits of passes) {
      let out = ''
      let last = 0
      for (const edit of edits) {
        out += replay.slice(last, edit.at) + edit.inserted
        last = edit.at + edit.removed
      }
      replay = out + replay.slice(last)
    }
    expect(replay).toBe(masked)
  }
})

test('mapPosition: a cut inside a masked value moves to the start of the marker', () => {
  const { visible, passes } = maskWithEdits({ text: 'ab MASKME tail', entities: [] }, [VALUE])
  expect(visible.text).toBe('ab [REDACTED] tail')
  expect(mapPosition(5, passes)).toBe(3)
  expect(mapPosition(3, passes)).toBe(3)
  expect(mapPosition(9, passes)).toBe(13)
})

test('property: for random HTML the joined cut pieces equal the masked text and entities stay in bounds', () => {
  const next = rng(42)
  for (let round = 0; round < 400; round++) {
    const html = randomHtml(next, 20 + Math.floor(next() * 200))
    const masked = mask(render(html, 'HTML'), [VALUE])
    expect(masked.text).not.toContain(VALUE)
    // Nothing a rule would mask is left in the shown text.
    expect(redactSecrets(masked.text, [VALUE])).toBe(masked.text)
    expectInBounds(masked)
    const limit = 8 + Math.floor(next() * 60)
    let pieces: VisibleText[]
    try {
      pieces = cut(masked, limit)
    } catch (error) {
      // Only text that has no visible content to cut around goes as a document.
      expect(error).toBeInstanceOf(PreformattedDocumentError)
      continue
    }
    expect(pieces.map(piece => piece.text).join('')).toBe(masked.text)
    for (const piece of pieces) {
      expect(piece.text.length).toBeLessThanOrEqual(limit)
      expect(/\S/.test(piece.text)).toBe(true)
      expectInBounds(piece)
    }
  }
})

test('cut: an astral character at the hard limit is not split', () => {
  const text = 'a'.repeat(4095) + '😀' + 'b'.repeat(10)
  const pieces = cut({ text, entities: [] }, 4096)
  expect(pieces.map(piece => piece.text).join('')).toBe(text)
  expect(pieces[0]!.text).toBe('a'.repeat(4095))
  expect(pieces[1]!.text.startsWith('😀')).toBe(true)
  for (const piece of pieces) expect(piece.text.length).toBeLessThanOrEqual(4096)
})

test('cut: paragraph, then line, then hard boundaries; entities are rebased onto each piece', () => {
  const entities: Entity[] = [{ type: 'bold', offset: 0, length: 12 }]
  const pieces = cut({ text: 'aaaa\n\nbbbb\ncc', entities }, 8)
  expect(pieces.map(piece => piece.text)).toEqual(['aaaa\n\n', 'bbbb\ncc'])
  expect(pieces[1]!.entities).toEqual([{ type: 'bold', offset: 0, length: 6 }])
  expect(cutPoints('xxxx\nyyyy zzzz', 8)).toEqual([5, 13, 14])
  expect(() => cut({ text: ' '.repeat(20) + 'x', entities: [] }, 8)).toThrow(PreformattedDocumentError)
})
