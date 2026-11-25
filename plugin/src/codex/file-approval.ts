import { posix } from 'node:path'

export type NativeFileChange = {
  path: string
  diff: string
  kind: Record<string, unknown>
}

function patchLines(text: string): string[] {
  return text.replace(/\n$/u, '').split('\n')
}

function editRuns(lines: readonly string[], native: boolean): string | undefined {
  const runs: { remove: string[]; insert: string[] }[] = []
  let current: (typeof runs)[number] | undefined
  for (const line of lines) {
    const header = native ? /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/u : /^@@(?: .*)?$/u
    if (header.test(line) || line.startsWith(' ') || (!native && line === '*** End of File')) {
      current = undefined
    } else if (line.startsWith('+') || line.startsWith('-')) {
      if (!current) {
        current = { remove: [], insert: [] }
        runs.push(current)
      }
      current[line[0] === '+' ? 'insert' : 'remove'].push(line.slice(1))
    } else return
  }
  return runs.length ? JSON.stringify(runs) : undefined
}

// Identity is established by the authenticated hook and the native operation ID.
// The two previews must also describe the same paths and mutations.
export function sameFilePatch(patch: string, cwd: string, changes: readonly NativeFileChange[]): boolean {
  if (!posix.isAbsolute(cwd) || patch.includes('\r') || !changes.length) return false
  const lines = patchLines(patch)
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') return false
  const byPath = new Map(changes.map(change => [change.path, change]))
  if (byPath.size !== changes.length) return false

  const fileHeader = /^\*\*\* (Add|Delete|Update) File: (.+)$/u
  for (let cursor = 0; cursor < lines.length;) {
    const header = fileHeader.exec(lines[cursor++]!)
    if (!header || !header[2] || header[2] !== header[2].trim()) return false
    const path = posix.resolve(cwd, header[2])
    const change = byPath.get(path)
    if (!change || change.kind.type !== header[1]!.toLowerCase()) return false
    byPath.delete(path)
    const body: string[] = []
    while (cursor < lines.length && !fileHeader.test(lines[cursor]!)) body.push(lines[cursor++]!)

    switch (change.kind.type) {
      case 'add': {
        if (body.some(line => !line.startsWith('+'))) return false
        const content = body.length ? body.map(line => line.slice(1)).join('\n') + '\n' : ''
        if (change.diff !== content) return false
        break
      }
      case 'delete':
        if (body.length) return false
        break
      case 'update': {
        const move = /^\*\*\* Move to: (.+)$/u.exec(body[0] ?? '')?.[1]
        if (move) {
          if (move !== move.trim() || posix.resolve(cwd, move) !== change.kind.move_path) return false
          body.shift()
        } else if (change.kind.move_path != null) return false
        const expected = editRuns(body, false)
        if (!expected || expected !== editRuns(patchLines(change.diff), true)) return false
        break
      }
      default:
        return false
    }
  }
  return byPath.size === 0
}
