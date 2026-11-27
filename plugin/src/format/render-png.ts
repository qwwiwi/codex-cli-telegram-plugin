// A Telegram-like picture of chat messages for the agent (R42 render_preview), drawn without an image library:
// a 5×7 bitmap font (ASCII, Cyrillic, common punctuation; any other character is a hollow box, so an emoji or an
// unexpected symbol stays visible as such), Telegram's HTML styles approximated (bold, italic, underline, strike,
// links, inline code, code blocks, quotes, spoilers) and a PNG written with node:zlib. An approximation of the
// client, not a screenshot: the layout (line breaks, blank lines, blocks, what shows raw) is what it is for.

import { deflateSync } from 'node:zlib'

/** One chat message: its text, whether it is Telegram HTML (`markup`) or literal text, and a caption under it. */
export interface PreviewBubble {
  html: string
  markup: boolean
  label: string
}

// Rows top to bottom, 5 columns each, «1» is ink.
const glyphRows: Readonly<Record<string, string>> = {
  ' ': '00000 00000 00000 00000 00000 00000 00000', '!': '00100 00100 00100 00100 00100 00000 00100',
  '"': '01010 01010 01010 00000 00000 00000 00000', '#': '01010 01010 11111 01010 11111 01010 01010',
  '$': '00100 01111 10100 01110 00101 11110 00100', '%': '11000 11001 00010 00100 01000 10011 00011',
  '&': '01100 10010 10100 01000 10101 10010 01101', "'": '00100 00100 01000 00000 00000 00000 00000',
  '(': '00010 00100 01000 01000 01000 00100 00010', ')': '01000 00100 00010 00010 00010 00100 01000',
  '*': '00000 00100 10101 01110 10101 00100 00000', '+': '00000 00100 00100 11111 00100 00100 00000',
  ',': '00000 00000 00000 00000 01100 00100 01000', '-': '00000 00000 00000 11111 00000 00000 00000',
  '.': '00000 00000 00000 00000 00000 01100 01100', '/': '00000 00001 00010 00100 01000 10000 00000',
  '0': '01110 10001 10011 10101 11001 10001 01110', '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00010 00100 01000 11111', '3': '11111 00010 00100 00010 00001 10001 01110',
  '4': '00010 00110 01010 10010 11111 00010 00010', '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110', '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110', '9': '01110 10001 10001 01111 00001 00010 01100',
  ':': '00000 01100 01100 00000 01100 01100 00000', ';': '00000 01100 01100 00000 01100 00100 01000',
  '<': '00010 00100 01000 10000 01000 00100 00010', '=': '00000 00000 11111 00000 11111 00000 00000',
  '>': '01000 00100 00010 00001 00010 00100 01000', '?': '01110 10001 00001 00010 00100 00000 00100',
  '@': '01110 10001 00001 01101 10101 10101 01110', 'A': '01110 10001 10001 11111 10001 10001 10001',
  'B': '11110 10001 10001 11110 10001 10001 11110', 'C': '01110 10001 10000 10000 10000 10001 01110',
  'D': '11100 10010 10001 10001 10001 10010 11100', 'E': '11111 10000 10000 11110 10000 10000 11111',
  'F': '11111 10000 10000 11110 10000 10000 10000', 'G': '01110 10001 10000 10111 10001 10001 01111',
  'H': '10001 10001 10001 11111 10001 10001 10001', 'I': '01110 00100 00100 00100 00100 00100 01110',
  'J': '00111 00010 00010 00010 00010 10010 01100', 'K': '10001 10010 10100 11000 10100 10010 10001',
  'L': '10000 10000 10000 10000 10000 10000 11111', 'M': '10001 11011 10101 10101 10001 10001 10001',
  'N': '10001 10001 11001 10101 10011 10001 10001', 'O': '01110 10001 10001 10001 10001 10001 01110',
  'P': '11110 10001 10001 11110 10000 10000 10000', 'Q': '01110 10001 10001 10001 10101 10010 01101',
  'R': '11110 10001 10001 11110 10100 10010 10001', 'S': '01111 10000 10000 01110 00001 00001 11110',
  'T': '11111 00100 00100 00100 00100 00100 00100', 'U': '10001 10001 10001 10001 10001 10001 01110',
  'V': '10001 10001 10001 10001 10001 01010 00100', 'W': '10001 10001 10001 10101 10101 10101 01010',
  'X': '10001 10001 01010 00100 01010 10001 10001', 'Y': '10001 10001 10001 01010 00100 00100 00100',
  'Z': '11111 00001 00010 00100 01000 10000 11111', '[': '01110 01000 01000 01000 01000 01000 01110',
  '\\': '00000 10000 01000 00100 00010 00001 00000', ']': '01110 00010 00010 00010 00010 00010 01110',
  '^': '00100 01010 10001 00000 00000 00000 00000', '_': '00000 00000 00000 00000 00000 00000 11111',
  '`': '01000 00100 00010 00000 00000 00000 00000', 'a': '00000 00000 01110 00001 01111 10001 01111',
  'b': '10000 10000 10110 11001 10001 10001 11110', 'c': '00000 00000 01110 10000 10000 10001 01110',
  'd': '00001 00001 01101 10011 10001 10001 01111', 'e': '00000 00000 01110 10001 11111 10000 01110',
  'f': '00110 01001 01000 11100 01000 01000 01000', 'g': '00000 01111 10001 10001 01111 00001 01110',
  'h': '10000 10000 10110 11001 10001 10001 10001', 'i': '00100 00000 01100 00100 00100 00100 01110',
  'j': '00010 00000 00110 00010 00010 10010 01100', 'k': '10000 10000 10010 10100 11000 10100 10010',
  'l': '01100 00100 00100 00100 00100 00100 01110', 'm': '00000 00000 11010 10101 10101 10001 10001',
  'n': '00000 00000 10110 11001 10001 10001 10001', 'o': '00000 00000 01110 10001 10001 10001 01110',
  'p': '00000 00000 11110 10001 11110 10000 10000', 'q': '00000 00000 01101 10011 01111 00001 00001',
  'r': '00000 00000 10110 11001 10000 10000 10000', 's': '00000 00000 01110 10000 01110 00001 11110',
  't': '01000 01000 11100 01000 01000 01001 00110', 'u': '00000 00000 10001 10001 10001 10011 01101',
  'v': '00000 00000 10001 10001 10001 01010 00100', 'w': '00000 00000 10001 10001 10101 10101 01010',
  'x': '00000 00000 10001 01010 00100 01010 10001', 'y': '00000 00000 10001 10001 01111 00001 01110',
  'z': '00000 00000 11111 00010 00100 01000 11111', '{': '00010 00100 00100 01000 00100 00100 00010',
  '|': '00100 00100 00100 00100 00100 00100 00100', '}': '01000 00100 00100 00010 00100 00100 01000',
  '~': '00000 00000 01000 10101 00010 00000 00000',
  'Б': '11111 10000 10000 11110 10001 10001 11110', 'Г': '11111 10000 10000 10000 10000 10000 10000',
  'Д': '00110 01010 01010 01010 01010 11111 10001', 'Ё': '01010 00000 11111 10000 11110 10000 11111',
  'Ж': '10101 10101 10101 01110 10101 10101 10101', 'З': '01110 10001 00001 00110 00001 10001 01110',
  'И': '10001 10001 10011 10101 11001 10001 10001', 'Й': '01010 00100 10001 10011 10101 11001 10001',
  'Л': '00111 01001 01001 01001 01001 01001 10001', 'П': '11111 10001 10001 10001 10001 10001 10001',
  'У': '10001 10001 10001 01111 00001 10001 01110', 'Ф': '00100 01110 10101 10101 10101 01110 00100',
  'Ц': '10010 10010 10010 10010 10010 11111 00001', 'Ч': '10001 10001 10001 01111 00001 00001 00001',
  'Ш': '10101 10101 10101 10101 10101 10101 11111', 'Щ': '10101 10101 10101 10101 10101 11111 00001',
  'Ъ': '11000 01000 01000 01110 01001 01001 01110', 'Ы': '10001 10001 10001 11101 10011 10011 11101',
  'Ь': '10000 10000 10000 11110 10001 10001 11110', 'Э': '01110 10001 00001 00111 00001 10001 01110',
  'Ю': '10010 10101 10101 11101 10101 10101 10010', 'Я': '01111 10001 10001 01111 00101 01001 10001',
  'ё': '01010 00000 01110 10001 11111 10000 01110', '«': '00000 00101 01010 10100 01010 00101 00000',
  '»': '00000 10100 01010 00101 01010 10100 00000', '…': '00000 00000 00000 00000 00000 00000 10101',
  '•': '00000 00000 01110 01110 01110 00000 00000', '→': '00000 00100 00010 11111 00010 00100 00000',
  '←': '00000 00100 01000 11111 01000 00100 00000', '✓': '00000 00001 00010 10100 01000 00000 00000',
  '°': '01100 10010 10010 01100 00000 00000 00000', '×': '00000 10001 01010 00100 01010 10001 00000',
}
// Characters drawn with another glyph: Cyrillic letters shaped like Latin ones, typographic quotes and dashes.
const aliases: Readonly<Record<string, string>> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '—': '-', '–': '-', '−': '-', ' ': ' ', '\t': ' ', '№': 'N',
}
const tofu = [0b11111, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11111]
const smallCapsRows = [0, 2, 3, 5, 6]
const glyphCache = new Map<string, readonly number[]>()

function rowsOf(pattern: string): number[] {
  return pattern.split(' ').map(row => Number.parseInt(row, 2))
}

function glyph(char: string): readonly number[] {
  const cached = glyphCache.get(char)
  if (cached) return cached
  const target = aliases[char] ?? char
  const own = glyphRows[target]
  let rows: readonly number[] = own === undefined ? tofu : rowsOf(own)
  // Other lower-case Cyrillic letters: small capitals of their upper-case glyph.
  const upper = target.toUpperCase()
  if (own === undefined && /^[а-я]$/u.test(target)) {
    const capital = glyphRows[aliases[upper] ?? upper]
    if (capital !== undefined) {
      const full = rowsOf(capital)
      rows = [0, 0, ...smallCapsRows.map(index => full[index] ?? 0)]
    }
  }
  glyphCache.set(char, rows)
  return rows
}

// Style flags of one character.
const BOLD = 1, ITALIC = 2, UNDERLINE = 4, STRIKE = 8, CODE = 16, PRE = 32, QUOTE = 64, SPOILER = 128, LINK = 256
const tagFlags: Readonly<Record<string, number>> = {
  b: BOLD, strong: BOLD, i: ITALIC, em: ITALIC, u: UNDERLINE, ins: UNDERLINE, s: STRIKE, strike: STRIKE, del: STRIKE,
  code: CODE, pre: PRE, blockquote: QUOTE, 'tg-spoiler': SPOILER, a: LINK,
}
const namedEntities: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"' }

interface Cell {
  char: string
  flags: number
}

// Telegram HTML as styled characters; tags Telegram does not know and unknown entities stay literal, as it shows them.
function cellsOf(bubble: PreviewBubble): Cell[] {
  if (!bubble.markup) return Array.from(bubble.html, char => ({ char, flags: 0 }))
  const cells: Cell[] = []
  const open = new Map<number, number>()
  let flags = 0
  const literal = (text: string): void => { for (const char of text) cells.push({ char, flags }) }
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>|&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/gu
  let last = 0
  for (const match of bubble.html.matchAll(re)) {
    literal(bubble.html.slice(last, match.index))
    last = match.index + match[0].length
    const [whole, closing, rawName, , decimal, hex, entity] = match
    if (rawName !== undefined) {
      const name = rawName.toLowerCase()
      if (name === 'br') {
        cells.push({ char: '\n', flags })
        continue
      }
      const flag = tagFlags[name]
      if (flag === undefined) {
        literal(whole)
        continue
      }
      const count = Math.max(0, (open.get(flag) ?? 0) + (closing ? -1 : 1))
      open.set(flag, count)
      flags = count > 0 ? flags | flag : flags & ~flag
      continue
    }
    const code = decimal !== undefined ? Number(decimal) : hex !== undefined ? Number.parseInt(hex, 16) : undefined
    const decoded = code !== undefined && code <= 0x10ffff ? String.fromCodePoint(code)
      : entity !== undefined ? namedEntities[entity] : undefined
    literal(decoded ?? whole)
  }
  literal(bubble.html.slice(last))
  return cells
}

interface Line {
  cells: Cell[]
  block: number
}

const columns = 44

// Breaks styled text into lines of at most `columns` characters: at a space when there is one, hard inside code.
function linesOf(cells: readonly Cell[]): Line[] {
  const lines: Line[] = []
  let current: Cell[] = []
  const blockOf = (row: readonly Cell[], extra = 0): number => row.reduce((block, cell) => block | (cell.flags & (PRE | QUOTE)), extra)
  for (const cell of cells) {
    if (cell.char === '\n') {
      lines.push({ cells: current, block: blockOf(current, cell.flags & (PRE | QUOTE)) })
      current = []
      continue
    }
    if (cell.char === '\r') continue
    if (current.length === columns) {
      const space = blockOf(current) & PRE ? -1 : current.map(item => item.char).lastIndexOf(' ')
      const rest = space > 0 ? current.slice(space + 1) : []
      lines.push({ cells: space > 0 ? current.slice(0, space) : current, block: blockOf(current) })
      current = rest
    }
    current.push(cell)
  }
  lines.push({ cells: current, block: blockOf(current) })
  return lines
}

type Rgb = readonly [number, number, number]
const colors = {
  chat: [0xc8, 0xd7, 0xb9], bubble: [0xff, 0xff, 0xff], text: [0x00, 0x00, 0x00], link: [0x24, 0x81, 0xcc],
  code: [0xb0, 0x30, 0x6a], codeBack: [0xee, 0xf1, 0xf4], quoteBar: [0x24, 0x81, 0xcc], quoteBack: [0xe9, 0xf3, 0xfb],
  label: [0x8a, 0x9a, 0xa9], spoiler: [0x9a, 0xa4, 0xad],
} satisfies Record<string, Rgb>

const scale = 2
const cellWidth = 6 * scale
const lineHeight = 11 * scale
const padding = 10
const margin = 12
const quoteIndent = 10
const labelHeight = 14
const gap = 8
const maxLines = 180
const imageWidth = 2 * margin + 2 * padding + quoteIndent + columns * cellWidth

class Canvas {
  readonly pixels: Uint8Array

  constructor(readonly width: number, readonly height: number, background: Rgb) {
    this.pixels = new Uint8Array(width * height * 3)
    this.fill(0, 0, width, height, background)
  }

  fill(x: number, y: number, w: number, h: number, color: Rgb, radius = 0): void {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row++) {
      for (let col = Math.max(0, x); col < Math.min(this.width, x + w); col++) {
        if (radius > 0) {
          const dx = col < x + radius ? x + radius - col : col >= x + w - radius ? col - (x + w - radius - 1) : 0
          const dy = row < y + radius ? y + radius - row : row >= y + h - radius ? row - (y + h - radius - 1) : 0
          if (dx * dx + dy * dy > radius * radius) continue
        }
        const at = (row * this.width + col) * 3
        this.pixels[at] = color[0]
        this.pixels[at + 1] = color[1]
        this.pixels[at + 2] = color[2]
      }
    }
  }

  glyph(char: string, x: number, y: number, size: number, color: Rgb, flags = 0): void {
    const rows = glyph(char)
    for (const [row, bits] of rows.entries()) {
      // Italic leans right at the top.
      const shift = flags & ITALIC ? Math.floor((6 - row) * size / 3) : 0
      for (let col = 0; col < 5; col++) {
        if (!(bits & (1 << (4 - col)))) continue
        this.fill(x + col * size + shift, y + row * size, size, size, color)
        if (flags & BOLD) this.fill(x + col * size + shift + 1, y + row * size, size, size, color)
      }
    }
  }

  text(value: string, x: number, y: number, size: number, color: Rgb): void {
    let left = x
    for (const char of value) {
      this.glyph(char, left, y, size, color)
      left += 6 * size
    }
  }
}

function drawLine(canvas: Canvas, line: Line, x: number, y: number, innerWidth: number): void {
  let left = x
  if (line.block & QUOTE) {
    canvas.fill(x, y, innerWidth, lineHeight, colors.quoteBack)
    canvas.fill(x, y, 3, lineHeight, colors.quoteBar)
    left += quoteIndent
  }
  if (line.block & PRE) canvas.fill(x, y, innerWidth, lineHeight, colors.codeBack)
  const top = y + 2 * scale
  for (const cell of line.cells) {
    const { flags } = cell
    if (flags & SPOILER) canvas.fill(left, top - scale, cellWidth, 9 * scale, colors.spoiler)
    else {
      if (flags & CODE && !(flags & PRE)) canvas.fill(left, top - scale, cellWidth, 9 * scale, colors.codeBack)
      const color = flags & LINK ? colors.link : flags & (CODE | PRE) ? colors.code : colors.text
      canvas.glyph(cell.char, left, top, scale, color, flags)
      if (flags & (UNDERLINE | LINK)) canvas.fill(left, top + 8 * scale, cellWidth, scale, color)
      if (flags & STRIKE) canvas.fill(left, top + 3 * scale, cellWidth, scale, color)
    }
    left += cellWidth
  }
}

/** Draws the messages top to bottom as chat bubbles and returns the PNG bytes. */
export function renderTelegramPng(bubbles: readonly PreviewBubble[]): Uint8Array {
  let budget = maxLines
  const laid = bubbles.map(bubble => {
    const all = linesOf(cellsOf(bubble))
    const lines = all.slice(0, Math.max(1, budget))
    budget -= lines.length
    if (lines.length < all.length) lines.push({ cells: Array.from('…', char => ({ char, flags: 0 })), block: 0 })
    return { bubble, lines }
  })
  const height = 2 * margin + laid.reduce((sum, { lines }) => sum + lines.length * lineHeight + 2 * padding + labelHeight + gap, 0)
  const canvas = new Canvas(imageWidth, Math.max(height, 2 * margin + 1), colors.chat)
  let y = margin
  for (const { bubble, lines } of laid) {
    const quoted = lines.some(line => line.block & QUOTE) ? quoteIndent : 0
    // The caption is drawn at scale 1: it needs a cell for every two of its characters.
    const widest = Math.max(...lines.map(line => line.cells.length), Math.ceil(Array.from(bubble.label).length * 6 / cellWidth))
    const innerWidth = Math.min(columns * cellWidth, widest * cellWidth) + quoted
    const bubbleHeight = lines.length * lineHeight + 2 * padding + labelHeight
    canvas.fill(margin, y, innerWidth + 2 * padding, bubbleHeight, colors.bubble, 8)
    for (const [index, line] of lines.entries()) drawLine(canvas, line, margin + padding, y + padding + index * lineHeight, innerWidth)
    const labelWidth = Array.from(bubble.label).length * 6
    canvas.text(bubble.label, margin + padding + innerWidth - labelWidth, y + padding + lines.length * lineHeight + 4, 1, colors.label)
    y += bubbleHeight + gap
  }
  return encodePng(canvas.width, canvas.height, canvas.pixels)
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

/** An 8-bit RGB PNG of `rgb` (rows top to bottom, 3 bytes a pixel), every row unfiltered. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3
  const raw = Buffer.alloc(height * (stride + 1))
  for (let row = 0; row < height; row++) raw.set(rgb.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', new Uint8Array(0)),
  ])
}
