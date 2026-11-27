import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { assessPolicy, policyHookOutput } from '../src/codex/legacy-policy.js'
import { object } from '../src/codex/rpc.js'
import { askThreadRole } from '../src/codex/thread-role.js'

// --thread-role (KROT_MULTIUSER=1): before the policy, ask the bridge whose
// thread this is; anything but an explicit allow (a member or guest thread,
// an unknown thread, an unreachable bridge) denies the tool call.
const publicDenied = 'Инструменты недоступны в этом чате.'

function readToken(tokenFile: string | undefined): string | undefined {
  if (!tokenFile || !isAbsolute(tokenFile)) return
  const token = readFileSync(tokenFile, 'utf8').trim()
  return /^[a-z0-9_-]{32,128}$/i.test(token) ? token : undefined
}

async function main(): Promise<ReturnType<typeof policyHookOutput>> {
  try {
    const argv = process.argv.slice(2)
    const roleCheck = argv.includes('--thread-role')
    const [policyFile, portText, tokenFile, scope] = argv.filter(arg => arg !== '--thread-role')
    if (!policyFile || !isAbsolute(policyFile) || statSync(policyFile).size > 64 * 1024) return policyHookOutput(false)
    const input = object(JSON.parse(await Bun.stdin.text()))
    const port = Number(portText)
    const validPort = Number.isInteger(port) && port >= 1 && port <= 65535
    if (roleCheck) {
      const token = readToken(tokenFile)
      if (!validPort || !token || !await askThreadRole(port, token, input.session_id)) {
        return policyHookOutput(false, publicDenied)
      }
    }
    const verdict = assessPolicy(readFileSync(policyFile, 'utf8'), input, scope,
      process.env.KROT_CODEX_APPROVAL_MODE === 'risky')
    if (verdict.tier !== 'confirm') return policyHookOutput(verdict.tier === 'allow', verdict.reason)
    const token = readToken(tokenFile)
    if (!token || !validPort) return policyHookOutput(false)
    const { command } = object(input.tool_input)
    const target = typeof command === 'string' ? command : JSON.stringify(input.tool_input)
    const { session_id: threadId, turn_id: turnId, tool_use_id: itemId } = input
    const operation = typeof threadId === 'string' && typeof turnId === 'string' && typeof itemId === 'string'
      ? { threadId, turnId, itemId } : undefined
    const endpoint = 'http://127.0.0.1:' + port + '/hooks/permission/request'
    const result = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(125_000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: input.tool_name === 'apply_patch' ? 'file' : 'command',
        target, cwd: input.cwd, reason: verdict.reason, operation }),
    })
    return policyHookOutput(result.ok && object(await result.json()).decision === 'accept')
  } catch {
    return policyHookOutput(false, 'Профиль разрешений не смог проверить действие.')
  }
}

console.log(JSON.stringify(await main()))
