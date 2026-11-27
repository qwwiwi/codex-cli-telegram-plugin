// Snapshot-before-delete, made by the PreToolUse hook itself. The safety guard plans what a
// recognised destructive command would destroy; this module saves it under
// ~/.trash/<stamp>-<call>/<absolute path> (or as a git ref) and verifies the copy before the command
// may run. A snapshot that cannot be made or verified is a deny, never a silent pass.
import { copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Runner } from './types.js'

export type Plan =
  // Removal (rm, rmdir, unlink, find -delete, git clean, patch delete): a hardlink copy of the tree.
  | { kind: 'link'; path: string }
  // In-place destruction (> file, truncate, shred, mv/cp onto a file, patch update): a real copy.
  | { kind: 'copy'; path: string }
  // git reset --hard / checkout -- / restore: the uncommitted work as refs/backup/<stamp>. With
  // `target` (git reset --hard <target>) also every untracked path the target's tree replaces.
  | { kind: 'stash'; dir: string; target?: string }
  // git branch -D: the branch tip as refs/backup/branches/<name>-<stamp>.
  | { kind: 'branch'; dir: string; name: string }
  // git clean: every path of a dry run built from the parsed command, hardlinked.
  | { kind: 'clean'; dir: string; model: CleanModel }

// A git clean command as the safety guard's strict parser read it. Only these fields ever reach the
// dry run: no word of the agent's command is forwarded as an option.
export interface CleanModel {
  // How often -f/--force was given: twice also removes nested repositories.
  force: number
  // -d, -x, -X.
  dirs: boolean
  ignored: boolean
  onlyIgnored: boolean
  // The patterns of -e/--exclude, in order.
  excludes: string[]
  // The pathspecs, in order.
  paths: string[]
}

// The arguments after `git clean` for the dry run of `model`: -n first, then only canonical words,
// each pattern as one --exclude=<pattern> word and the paths after `--`. Nothing here can turn the
// dry run off.
export function cleanPreviewArgs(model: CleanModel): string[] {
  return [
    '-n',
    // -ff also lists nested repositories; -f never disables -n.
    ...(model.force > 1 ? ['-f', '-f'] : []),
    ...(model.dirs ? ['-d'] : []),
    ...(model.ignored ? ['-x'] : []),
    ...(model.onlyIgnored ? ['-X'] : []),
    ...model.excludes.map(pattern => `--exclude=${pattern}`),
    '--',
    ...model.paths,
  ]
}

export interface Limits { maxFiles: number; maxBytes: number }
export const DEFAULT_LIMITS: Limits = { maxFiles: 50_000, maxBytes: 256 * 1024 * 1024 }

export interface SnapshotEnv {
  // ~/.trash/<stamp>-<call>: every saved path goes below it at its absolute path.
  dir: string
  stamp: string
  run: Runner
  limits: Limits
}

// A deny reason the guard shows as is; any other error is reported generically.
export class SnapshotRefused extends Error {}

// Whether `path` is there (a dangling symlink counts). Only "no such file" (ENOENT, ENOTDIR) means
// absent: any other lstat error (EIO, EACCES, ELOOP, ...) is thrown, so a file that may exist is
// never taken for a new one and left without its snapshot.
export function pathExists(path: string, lstat: (path: string) => unknown = lstatSync): boolean {
  try {
    lstat(path)
    return true
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

const exists = (path: string) => pathExists(path)

function existingAncestor(path: string): string {
  let current = path
  while (!exists(current) && current !== '/') current = dirname(current)
  return current
}

// Files (and symlinks) below `path`, `path` itself for a file; throws over the file cap.
function files(path: string, limits: Limits, found: string[] = []): string[] {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) {
    found.push(path)
  } else {
    for (const name of readdirSync(path)) files(join(path, name), limits, found)
  }
  if (found.length > limits.maxFiles) throw new SnapshotRefused(`больше ${limits.maxFiles} файлов`)
  return found
}

function linkTree(source: string, target: string, limits: Limits): void {
  const list = files(source, limits)
  const device = statSync(existingAncestor(target)).dev
  for (const file of list) {
    const stat = lstatSync(file)
    if (!stat.isSymbolicLink() && stat.dev !== device) throw new SnapshotRefused('другая файловая система, жёсткая ссылка невозможна')
  }
  if (lstatSync(source).isDirectory()) mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const file of list) {
    const destination = target + file.slice(source.length)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    const stat = lstatSync(file)
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(file), destination)
    else linkSync(file, destination)
  }
  // Empty directories carry no file but still vanish with rm -r: keep their shape.
  if (lstatSync(source).isDirectory()) mirrorDirs(source, target)
  verify(source, target, limits)
}

function mirrorDirs(source: string, target: string): void {
  for (const name of readdirSync(source)) {
    const path = join(source, name)
    if (lstatSync(path).isDirectory()) {
      mkdirSync(join(target, name), { recursive: true, mode: 0o700 })
      mirrorDirs(path, join(target, name))
    }
  }
}

function copyTree(source: string, target: string, limits: Limits): void {
  const list = files(source, limits)
  const bytes = list.reduce((sum, file) => sum + lstatSync(file).size, 0)
  if (bytes > limits.maxBytes) throw new SnapshotRefused(`больше ${Math.round(limits.maxBytes / 1048576)} МБ`)
  for (const file of list) {
    const destination = target + file.slice(source.length)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    if (lstatSync(file).isSymbolicLink()) symlinkSync(readlinkSync(file), destination)
    else copyFileSync(file, destination)
  }
  verify(source, target, limits)
}

// The copy holds the same relative files with the same sizes as the source.
function verify(source: string, target: string, limits: Limits): void {
  const shape = (root: string) => files(root, limits).map(file => `${file.slice(root.length)}:${lstatSync(file).size}`).sort().join('\n')
  if (shape(source) !== shape(target)) throw new Error(`snapshot of ${source} does not match the source`)
}

function git(env: SnapshotEnv, dir: string, args: string[]): string {
  const result = env.run(['git', '-C', dir, ...args], { timeoutMs: 10_000 })
  if (result.code !== 0) throw new Error(`git ${args[0]} failed in ${dir} (exit ${result.code})`)
  return result.stdout.trim()
}

// A git C-quoted path ("\320\267 \"x\"\n") as the UTF-8 name it stands for.
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"')) return value
  if (!value.endsWith('"') || value.length < 2) throw new SnapshotRefused(`не удалось прочитать путь из git: ${value}`)
  const bytes: number[] = []
  const body = value.slice(1, -1)
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? ''
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue }
    const next = body[i + 1] ?? ''
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1))
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue }
    const code = escapes[next]
    if (code === undefined) throw new SnapshotRefused(`не удалось прочитать путь из git: ${value}`)
    bytes.push(code); i++
  }
  return Buffer.from(bytes).toString('utf8')
}

// The absolute paths the parsed git clean would remove, from its canonical dry run in the C locale
// with core.quotePath off; a line it cannot read refuses the snapshot.
function cleanList(env: SnapshotEnv, dir: string, model: CleanModel): string[] {
  const result = env.run(['env', 'LC_ALL=C', 'LANGUAGE=', 'git', '-C', dir, '-c', 'core.quotePath=false', 'clean', ...cleanPreviewArgs(model)], { timeoutMs: 10_000 })
  if (result.code !== 0) throw new Error(`git clean -n failed in ${dir} (exit ${result.code})`)
  // "Would skip repository" lines name nested repositories the real run keeps too.
  return result.stdout.split('\n').filter(line => line !== '' && !line.startsWith('Would skip repository ')).map(line => {
    const match = /^Would remove (.+)$/.exec(line)
    if (!match?.[1]) throw new SnapshotRefused(`непонятная строка git clean -n: ${line}`)
    return join(dir, unquoteGitPath(match[1]).replace(/\/$/, ''))
  })
}

// NUL-separated git output, untrimmed (a name may start or end with a space).
function gitList(env: SnapshotEnv, dir: string, args: string[]): string[] {
  const result = env.run(['git', '-C', dir, ...args], { timeoutMs: 10_000 })
  if (result.code !== 0) throw new SnapshotRefused(`git ${args[0]} не выполнился в ${dir}, снимок невозможен`)
  return result.stdout.split('\0').filter(name => name !== '')
}

// The absolute untracked paths (ignored ones too) that `git reset --hard <target>` overwrites or
// removes: a path the target tracks, a file standing where the target has a directory, or a file
// inside a directory where the target has a file. A target git cannot resolve refuses the snapshot.
function collidingUntracked(env: SnapshotEnv, dir: string, target: string): string[] {
  const top = git(env, dir, ['rev-parse', '--show-toplevel'])
  const tree = env.run(['git', '-C', top, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${target}^{tree}`], { timeoutMs: 10_000 })
  const treeId = tree.stdout.trim()
  if (tree.code !== 0 || !treeId) throw new SnapshotRefused(`цель git reset --hard ${target} не найдена, неотслеживаемые файлы нельзя сохранить`)
  const tracked = new Set<string>()
  const trackedDirs = new Set<string>()
  // 'a/b/c' -> ['a', 'a/b']
  const ancestors = (path: string) => {
    const parts = path.split('/')
    return parts.slice(1).map((_part, index) => parts.slice(0, index + 1).join('/'))
  }
  for (const path of gitList(env, top, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', treeId])) {
    tracked.add(path)
    for (const parent of ancestors(path)) trackedDirs.add(parent)
  }
  return gitList(env, top, ['ls-files', '-z', '--others', '--full-name'])
    .filter(path => tracked.has(path) || trackedDirs.has(path) || ancestors(path).some(parent => tracked.has(parent)))
    .map(path => join(top, path))
}

const refName =(value: string) => value.replace(/[^\w./-]/g, '_').replace(/\.{2,}/g, '_')

// Makes every planned snapshot; returns what was saved (paths in the trash, refs).
export function takeSnapshots(plans: readonly Plan[], env: SnapshotEnv): string[] {
  const saved: string[] = []
  for (const plan of plans) {
    if (plan.kind === 'link' || plan.kind === 'copy') {
      if (!exists(plan.path)) continue
      const target = join(env.dir, plan.path)
      if (exists(target)) continue
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      if (plan.kind === 'link') linkTree(plan.path, target, env.limits)
      else copyTree(plan.path, target, env.limits)
      saved.push(target)
    } else if (plan.kind === 'stash') {
      // `stash create` makes the commit without touching the tree; empty output = nothing to lose.
      if (plan.target !== undefined) {
        for (const path of collidingUntracked(env, plan.dir, plan.target)) saved.push(...takeSnapshots([{ kind: 'link', path }], env))
      }
      const sha = git(env, plan.dir, ['stash', 'create'])
      if (!sha) continue
      const ref = `refs/backup/${env.stamp}`
      git(env, plan.dir, ['update-ref', ref, sha])
      saved.push(ref)
    } else if (plan.kind === 'branch') {
      const sha = git(env, plan.dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${plan.name}`])
      const ref = `refs/backup/branches/${refName(plan.name)}-${env.stamp}`
      git(env, plan.dir, ['update-ref', ref, sha])
      saved.push(ref)
    } else {
      for (const path of cleanList(env, plan.dir, plan.model)) {
        // A listed path that is not there means the listing was misread: never a silent pass.
        if (!exists(path)) throw new SnapshotRefused(`git clean показал путь, которого нет: ${path}`)
        saved.push(...takeSnapshots([{ kind: 'link', path }], env))
      }
    }
  }
  return saved
}
