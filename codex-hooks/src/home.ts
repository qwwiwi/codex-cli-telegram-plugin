import { accessSync, constants, statSync } from 'node:fs'
import { userInfo } from 'node:os'

function requireUsableHome(home: string): string {
  try {
    if (statSync(home).isDirectory()) {
      accessSync(home, constants.R_OK | constants.X_OK)
      return home
    }
  } catch { /* Report the unusable HOME below. */ }
  throw new Error(`HOME ${JSON.stringify(home)} must be an existing, readable, searchable directory`)
}

export function invokingHome(env: Record<string, string | undefined>,
  spawnGetent: (argv: string[]) => { exitCode: number | null; stdout: Buffer } = argv => Bun.spawnSync(argv, {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  })): string {
  if (env.HOME) return requireUsableHome(env.HOME)
  const uid = process.getuid?.()
  // userInfo looks up the effective uid, which is normally also the real uid.
  if (uid === process.geteuid?.()) return requireUsableHome(userInfo().homedir)

  const result = spawnGetent(['/usr/bin/getent', 'passwd', String(uid)])
  const home = result.stdout.toString().split(':')[5]
  if (result.exitCode !== 0 || !home) throw new Error(`Could not find the passwd home for uid ${uid}`)
  return requireUsableHome(home)
}
