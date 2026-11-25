import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

export function legacyCommand(directory: string, name: string, args: string): string | undefined {
  if (!isAbsolute(directory) || !/^[a-z0-9_-]+(?::[a-z0-9_-]+)*$/i.test(name)) return
  try {
    const root = realpathSync(directory)
    const path = realpathSync(join(root, ...name.split(':')) + '.md')
    const inside = relative(root, path)
    if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) return
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > 16_000) return
    const body = readFileSync(path, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '').trim()
    if (!body) return
    return /\$ARGUMENTS\b/u.test(body) ? body.replace(/\$ARGUMENTS\b/gu, () => args) :
      [body, args ? 'Аргументы от владельца: ' + args : ''].filter(Boolean).join('\n\n')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
