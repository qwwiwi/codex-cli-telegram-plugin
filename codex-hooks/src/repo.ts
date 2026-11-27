// Git and file lookups through the context runner. A runner that cannot start throws: the
// fail-closed guards rely on that, so these helpers never swallow exceptions.
import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SafetyView } from './safety.js'
import { pathExists } from './snapshot.js'
import type { HookContext } from './types.js'

// The trimmed stdout of a git call that exited 0 ('' for empty output), or undefined on any failure.
export function gitRaw(ctx: HookContext, dir: string, args: string[]): string | undefined {
  const result = ctx.run(['git', '-C', dir, ...args], { timeoutMs: 3000 })
  return result.code === 0 ? result.stdout.trim() : undefined
}

export function gitOut(ctx: HookContext, dir: string, args: string[]): string | undefined {
  return gitRaw(ctx, dir, args) || undefined
}

export const branchOf = (ctx: HookContext, dir: string) => gitOut(ctx, dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
export const toplevelOf = (ctx: HookContext, dir: string) => gitOut(ctx, dir, ['rev-parse', '--show-toplevel'])

// True for a clean tree (no change, no untracked file), false for a dirty one, undefined when git failed.
export function cleanTree(ctx: HookContext, dir: string): boolean | undefined {
  const status = gitRaw(ctx, dir, ['status', '--porcelain'])
  return status === undefined ? undefined : status === ''
}

export function cwdOf(ctx: HookContext): string {
  return typeof ctx.input.cwd === 'string' && ctx.input.cwd ? ctx.input.cwd : ctx.home
}

const MAX_SQL_FILE = 1_000_000

// `path` with its deepest existing ancestor (or, without keepLast, itself) resolved through symlinks.
export function resolveReal(path: string, keepLast: boolean): string {
  let links = 0
  const follow = (head: string, tail: string): string => {
    for (;;) {
      // Bun normalizes `..` before realpath. Resolve the preceding segment first, as the kernel does.
      if (/(?:^|\/)\.\.(?:\/|$)/.test(head)) {
        let parent = ''
        for (const segment of head.split('/')) {
          if (segment === '..') {
            const physical = follow(parent || '/', '')
            parent = physical.slice(0, physical.lastIndexOf('/'))
          } else if (segment && segment !== '.') parent += `/${segment}`
        }
        head = parent || '/'
      }
      try { return `${realpathSync(head).replace(/\/$/, '')}${tail}` || '/' } catch { /* walk up */ }
      if (head === '/' || !head) return path
      const up = head.lastIndexOf('/')
      // A dangling symlink has no realpath, but opening it for writing can create its target.
      let target: string | undefined
      try { target = readlinkSync(head) } catch { /* not a link */ }
      if (target !== undefined) {
        if (++links > 40) return path
        head = target.startsWith('/') ? target : `${head.slice(0, up)}/${target}`
        continue
      }
      tail = `${head.slice(up)}${tail}`
      head = head.slice(0, up) || '/'
    }
  }
  const cut = path.lastIndexOf('/')
  return keepLast ? follow(path.slice(0, cut) || '/', path.slice(cut)) : follow(path, '')
}

export function safetyView(ctx: HookContext): SafetyView {
  return {
    cwd: cwdOf(ctx),
    home: ctx.home,
    codexHome: ctx.codexHome,
    branchOf: dir => branchOf(ctx, dir),
    toplevelOf: dir => toplevelOf(ctx, dir),
    // Throws on an lstat error other than "no such file": the safety step then denies.
    exists: path => pathExists(path, ctx.lstat),
    isDir: path => { try { return statSync(path).isDirectory() } catch { return false } },
    realpath: (path, keepLast) => resolveReal(path, keepLast),
    dirty: dir => { const clean = gitRaw(ctx, dir, ['status', '--porcelain', '--untracked-files=no']); return clean === undefined ? undefined : clean !== '' },
    readFile: path => {
      try { return statSync(path).size <= MAX_SQL_FILE ? readFileSync(path, 'utf8') : undefined } catch { return }
    },
    tmpDirs: ctx.tmpDirs ?? [tmpdir(), '/tmp', '/var/tmp'],
    now: ctx.now,
  }
}
