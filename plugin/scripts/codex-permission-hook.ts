import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { assessPolicy, policyHookOutput } from '../src/codex/legacy-policy.js'
import { object } from '../src/codex/rpc.js'

async function main(): Promise<ReturnType<typeof policyHookOutput>> {
  try {
    const [policyFile, portText, tokenFile, scope] = process.argv.slice(2)
    if (!policyFile || !isAbsolute(policyFile) || statSync(policyFile).size > 64 * 1024) return policyHookOutput(false)
    const input = object(JSON.parse(await Bun.stdin.text()))
    const verdict = assessPolicy(readFileSync(policyFile, 'utf8'), input, scope)
    if (verdict.tier !== 'confirm') return policyHookOutput(verdict.tier === 'allow', verdict.reason)
    const port = Number(portText)
    if (!tokenFile || !isAbsolute(tokenFile) || !Number.isInteger(port) || port < 1 || port > 65535) return policyHookOutput(false)
    const token = readFileSync(tokenFile, 'utf8').trim()
    if (!/^[a-z0-9_-]{32,128}$/i.test(token)) return policyHookOutput(false)
    const { command } = object(input.tool_input)
    const target = typeof command === 'string' ? command : JSON.stringify(input.tool_input)
    const endpoint = 'http://127.0.0.1:' + port + '/hooks/permission/request'
    const result = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(125_000),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: input.tool_name === 'apply_patch' ? 'file' : 'command',
        target, cwd: input.cwd, reason: verdict.reason }),
    })
    return policyHookOutput(result.ok && object(await result.json()).decision === 'accept')
  } catch {
    return policyHookOutput(false, 'Профиль разрешений не смог проверить действие.')
  }
}

console.log(JSON.stringify(await main()))
