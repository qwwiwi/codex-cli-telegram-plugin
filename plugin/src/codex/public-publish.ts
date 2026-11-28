// Exclusive publish of a small file (generation marker, hook proof) under its final name.
//
// The bytes go to a fresh random temporary name in the same directory (O_EXCL|O_NOFOLLOW, 0600),
// are fsynced, and appear under the final name only through link(), which never replaces an
// existing entry (file, live or dangling link: EEXIST). The final name therefore never holds a
// partial file. A crash before link leaves only the temporary name; a crash between link and
// unlink leaves the final with nlink 2 next to its temporary twin, which readers treat as not
// published and public-gc.ts collects. This is the only removal in the build path.

import { randomBytes } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, unlinkSync, writeSync, type BigIntStats,
} from 'node:fs'
import { join } from 'node:path'

export type PublishStep = 'open' | 'write' | 'fsync' | 'link' | 'unlink' | 'dirsync'
/** Test seam: runs before each step with the temporary path; throwing aborts the publish there. */
export type PublishFault = (step: PublishStep, tempPath: string) => void

/** The temporary name of a publish in progress (or interrupted by a crash). */
export const PUBLISH_TEMP = /^\.publish-[0-9a-f]{16}\.tmp$/u

/** The filesystem cannot create hard links (FAT, some network mounts): multi-user mode cannot start. */
// Typed so startup prints its own text and exits as a fatal configuration error (startup-error.ts, exit-codes.ts).
export class PublishUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishUnsupportedError'
  }
}

// link() errors that mean "no hard links on this filesystem" for a file we own.
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return undefined
}

function sameFile(stat: BigIntStats | undefined, identity: BigIntStats): stat is BigIntStats {
  return stat !== undefined && stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino
}

/**
 * Publishes `bytes` under `directory/name`, never replacing an existing entry. `check` runs right
 * before the link (the caller re-verifies its parents). Throws on any failure: before the link the
 * final name never appears and the temporary file stays for public-gc.ts.
 */
export function publishExclusive(directory: string, name: string, bytes: string, check: () => void,
  fault: PublishFault = () => {}): void {
  const temp = join(directory, '.publish-' + randomBytes(8).toString('hex') + '.tmp')
  const final = join(directory, name)
  fault('open', temp)
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let identity: BigIntStats
  try {
    fault('write', temp)
    const data = Buffer.from(bytes)
    let written = 0
    while (written < data.length) written += writeSync(fd, data, written, data.length - written)
    fault('fsync', temp)
    fsyncSync(fd)
    identity = fstatSync(fd, { bigint: true })
  } finally {
    closeSync(fd)
  }
  check()
  try {
    fault('link', temp)
    linkSync(temp, final)
  } catch (error) {
    const code = errorCode(error)
    if (code !== undefined && NO_HARD_LINKS.has(code)) {
      throw new PublishUnsupportedError('Многопользовательский режим (KROT_MULTIUSER=1) не запускается: ' +
        'файловая система не поддерживает жёсткие ссылки, а без них мост не может надёжно сохранить отметку. ' +
        'Перенесите папку состояния моста на обычный диск (например, ext4 или APFS) или выключите KROT_MULTIUSER. ' +
        'Папка, где возникла ошибка: ' + directory)
    }
    throw error
  }
  // On macOS link() may follow a symlinked source; the final must be exactly our temporary file.
  const linked = lstatSync(final, { bigint: true, throwIfNoEntry: false })
  if (!sameFile(linked, identity) || linked.nlink !== 2n) throw new Error('The published file is not the one written: ' + final)
  fault('unlink', temp)
  if (!sameFile(lstatSync(temp, { bigint: true, throwIfNoEntry: false }), identity)) {
    throw new Error('The temporary publish file changed: ' + temp)
  }
  unlinkSync(temp)
  fault('dirsync', temp)
  syncDirectory(directory)
}

/** Fsyncs a directory so the entries created in it survive a power loss. */
export function syncDirectory(directory: string): void {
  const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(dir)
  } finally {
    closeSync(dir)
  }
}
