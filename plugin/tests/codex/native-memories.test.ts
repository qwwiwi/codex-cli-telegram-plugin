import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexAppServerCommand } from '../../src/codex/native-memories.js'

const fakeServer = `
import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (method === 'initialize') console.log(JSON.stringify({ id, result: {} }))
  if (method !== 'config/read') continue
  if (params.cwd !== process.cwd()) process.exit(1)
  console.log(JSON.stringify({ id, ...JSON.parse(process.env.CONFIG_REPLY) }))
}
`
const base = [process.execPath, '-e', fakeServer] as const

test('uses Codex resolved config and ignores a file from an untrusted project', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'codex-memories-'))
  try {
    mkdirSync(join(workspace, '.codex'))
    writeFileSync(join(workspace, '.codex', 'config.toml'), '[features]\nmemories = false\n')
    const env = { CONFIG_REPLY: JSON.stringify({ result: { origins: {}, config: { features: { memories: false } } } }) }
    expect(await codexAppServerCommand(workspace, env, true, base)).toEqual([...base, '-c', 'features.memories=true'])
  } finally {
    rmSync(workspace, { recursive: true })
  }
})

test.each([
  { result: { origins: { 'features.memories': { name: { type: 'project' } } }, config: { features: { memories: false } } } },
  { result: { origins: { 'features.memories': { name: { type: 'user' } } }, config: { features: { memories: false } } } },
  { result: { origins: {}, config: { features: { memories: true } } } },
  { result: { config: { features: {} } } },
  { error: { code: -32603 } },
])('keeps Codex in charge for an explicit setting, an enabled flag or an unknown response %#', async reply => {
  const env = { CONFIG_REPLY: JSON.stringify(reply) }
  expect(await codexAppServerCommand(import.meta.dir, env, true, base)).toEqual(base)
})

test('does not launch the configuration probe for opted-out installations', async () => {
  const command = ['/nonexistent'] as const
  expect(await codexAppServerCommand(import.meta.dir, {}, false, command)).toEqual(command)
})
