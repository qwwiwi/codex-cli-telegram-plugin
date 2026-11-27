// Minimal POSIX ustar writer and reader for the month archive (spec §9 level 3). Regular files
// only, names up to 100 ASCII bytes, fixed owner and time, so the same files give the same bytes
// and any standard `tar` can read the result. No dependency is added for this.

const BLOCK = 512

export interface TarFile {
  name: string
  data: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function writeField(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value)
  if (bytes.length > length) throw new Error(`tar: field too long: ${value}`)
  header.set(bytes, offset)
}

const octal = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, '0')}\0`

function checksum(header: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i] ?? 0
  return sum
}

function headerFor(file: TarFile): Uint8Array {
  if (!/^[\x21-\x7e]{1,100}$/.test(file.name)) throw new Error(`tar: unsupported file name ${JSON.stringify(file.name)}`)
  const header = new Uint8Array(BLOCK)
  writeField(header, 0, 100, file.name)
  writeField(header, 100, 8, octal(0o600, 8))
  writeField(header, 108, 8, octal(0, 8))
  writeField(header, 116, 8, octal(0, 8))
  writeField(header, 124, 12, octal(file.data.length, 12))
  writeField(header, 136, 12, octal(0, 12))
  writeField(header, 156, 1, '0')
  writeField(header, 257, 6, 'ustar\0')
  writeField(header, 263, 2, '00')
  writeField(header, 148, 8, `${checksum(header).toString(8).padStart(6, '0')}\0 `)
  return header
}

const padded = (size: number): number => Math.ceil(size / BLOCK) * BLOCK

/** An uncompressed tar of `files`, in the given order, ending with two zero blocks. */
export function packTar(files: readonly TarFile[]): Uint8Array {
  const total = files.reduce((sum, file) => sum + BLOCK + padded(file.data.length), 0) + 2 * BLOCK
  const out = new Uint8Array(total)
  let offset = 0
  for (const file of files) {
    out.set(headerFor(file), offset)
    out.set(file.data, offset + BLOCK)
    offset += BLOCK + padded(file.data.length)
  }
  return out
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)
  return decoder.decode(end < 0 ? slice : slice.subarray(0, end))
}

/** The regular files of a tar, in archive order. Throws on a damaged header or a truncated file. */
export function unpackTar(tar: Uint8Array): TarFile[] {
  const files: TarFile[] = []
  let offset = 0
  for (;;) {
    if (offset + BLOCK > tar.length) throw new Error('tar: archive is truncated')
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) return files
    const stored = Number.parseInt(readString(header, 148, 8).trim(), 8)
    if (stored !== checksum(header)) throw new Error('tar: header checksum mismatch')
    const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0 || offset + BLOCK + size > tar.length) throw new Error('tar: entry is truncated')
    const type = readString(header, 156, 1)
    if (type === '0' || type === '') {
      files.push({ name: readString(header, 0, 100), data: tar.slice(offset + BLOCK, offset + BLOCK + size) })
    }
    offset += BLOCK + padded(size)
  }
}
