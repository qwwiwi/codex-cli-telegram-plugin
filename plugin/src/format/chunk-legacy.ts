// The Telegram chunker before parsed-length chunking (port of the 0.3.1 splitMessage). It cut the HTML by its RAW
// length and balanced only <pre> and <code>. Kept only to recover where a bridge of that version cut a reply whose
// `text:N` receipts were saved without a chunk plan: resuming with today's cuts would skip or repeat text.

type BalancedTag = 'pre' | 'code'
const BALANCED_TAGS: BalancedTag[] = ['pre', 'code']
const DEFAULT_MAX = 4000

function openTagsAt(text: string): BalancedTag[] {
  const stack: BalancedTag[] = []
  const re = /<\s*(\/?)\s*(pre|code)\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tag = (m[2] as string).toLowerCase() as BalancedTag
    if (m[1] === '/') {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i] === tag) {
          stack.splice(i, 1)
          break
        }
      }
    } else {
      stack.push(tag)
    }
  }
  return stack
}

function chooseCut(text: string, max: number): number {
  if (text.length <= max) return text.length
  const slice = text.slice(0, max)
  const lastPara = slice.lastIndexOf('\n\n')
  if (lastPara >= 0) return lastPara + 2
  const lastLine = slice.lastIndexOf('\n')
  if (lastLine >= 0) return lastLine + 1
  return max
}

/** The chunks the old chunker sent for `text` and, for each, the source offset (exclusive) where it ended. */
export interface LegacyChunks {
  chunks: string[]
  ends: number[]
}

export function splitMessageLegacy(text: string, max: number = DEFAULT_MAX): LegacyChunks {
  if (max <= 0) throw new Error(`splitMessageLegacy: max must be positive, got ${max}`)
  if (text.length === 0) return { chunks: [], ends: [] }
  if (text.length <= max) return { chunks: [text], ends: [text.length] }

  const chunks: string[] = []
  const ends: number[] = []
  let remaining = text
  let consumed = 0
  let inherited: BalancedTag[] = []
  const hardCap = Math.ceil(text.length / Math.max(1, Math.floor(max / 4))) + 16
  let iterations = 0
  const perTagSuffix = BALANCED_TAGS.reduce((mx, t) => Math.max(mx, `</${t}>`.length), 0)

  while (remaining.length > 0) {
    const prefix = inherited.map(t => `<${t}>`).join('')
    if (iterations++ > hardCap) {
      chunks.push(prefix + remaining)
      ends.push(text.length)
      break
    }
    const suffixReserve = inherited.length * perTagSuffix
    const cut = chooseCut(remaining, Math.max(1, max - prefix.length - suffixReserve))
    const body = remaining.slice(0, cut)
    const afterState = openTagsAt(prefix + body)
    let chunk = prefix + body + [...afterState].reverse().map(t => `</${t}>`).join('')
    let taken = cut
    if (chunk.length > max) {
      const fullSuffixBudget = BALANCED_TAGS.length * perTagSuffix
      taken = Math.max(1, cut - (chunk.length - max) - fullSuffixBudget)
      const body2 = remaining.slice(0, taken)
      const afterState2 = openTagsAt(prefix + body2)
      chunk = prefix + body2 + [...afterState2].reverse().map(t => `</${t}>`).join('')
      inherited = afterState2
    } else {
      inherited = afterState
    }
    remaining = remaining.slice(taken)
    consumed += taken
    if (chunks.length > 0) chunk = chunk.replace(/^\n+/, '')
    if (chunk.length > 0) {
      chunks.push(chunk)
      ends.push(consumed)
    }
  }
  return { chunks, ends }
}
