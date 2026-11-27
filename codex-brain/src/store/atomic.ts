// Crash-safe file writes for the Brain store: every file is 0600, a replace goes through a temp
// file in the same directory, fsync and rename, so a reader or a crash sees the old or the new
// bytes, never a mix.

import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fstatSync, fsyncSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export const FILE_MODE = 0o600
export const DIR_MODE = 0o700

export interface AtomicWriteOptions {
  /** Test seam: runs after the temp file is durable and before the rename. */
  beforeRename?: () => void
}

function fsyncDir(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Some filesystems refuse fsync on a directory; the rename itself is still atomic.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Replaces `path` with `data` atomically; the result is mode 0600. */
export function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): void {
  const dir = dirname(path)
  const temp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', FILE_MODE)
    writeAll(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    // The process umask cannot widen the mode, but be explicit in case the file system ignores it.
    chmodSync(temp, FILE_MODE)
    options.beforeRename?.()
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(temp, { force: true })
    throw error
  }
  fsyncDir(dir)
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let offset = 0
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset)
}

/**
 * Appends one line (a `\n` is added) on an O_APPEND descriptor, then fsyncs. If the file does not
 * end with `\n` (an earlier append was cut short by a crash), a `\n` is written first so the torn
 * line stays on its own and readers can skip it. When the call creates the file, the directory is
 * fsynced too, so the new name survives a crash. Callers that need ordering across processes hold
 * the store lock.
 */
export function appendLine(path: string, line: string): void {
  if (line.includes('\n') || line.includes('\r')) throw new Error('appendLine: the line must not contain a line break')
  const { fd, created } = openForAppend(path)
  try {
    const size = fstatSync(fd).size
    let prefix = ''
    if (size > 0) {
      const last = Buffer.alloc(1)
      readSync(fd, last, 0, 1, size - 1)
      if (last[0] !== 0x0a) prefix = '\n'
    }
    writeAll(fd, Buffer.from(`${prefix}${line}\n`, 'utf8'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  chmodSync(path, FILE_MODE)
  if (created) fsyncDir(dirname(path))
}

// Exclusive create first, so exactly the process that made the file knows it did.
function openForAppend(path: string): { fd: number; created: boolean } {
  try {
    return { fd: openSync(path, 'ax+', FILE_MODE), created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return { fd: openSync(path, 'a+', FILE_MODE), created: false }
}
