import { afterEach, expect, test } from 'bun:test'
import { createGbrain, mcpUrlFromToml, tokenFromEnvFile } from '../../../codex-hooks/src/mcp.js'

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => { server?.stop(true); server = undefined })

test('[R17] the gbrain URL comes from the mcp_servers entry of config.toml', () => {
  const toml = '[mcp_servers.other]\nurl = "https://other.example/mcp"\n\n[mcp_servers.gbrain]\nurl = "https://brain.example/mcp"\nbearer_token_env_var = "GBRAIN_BEARER"\n'
  expect(mcpUrlFromToml(toml, 'gbrain')).toBe('https://brain.example/mcp')
  expect(mcpUrlFromToml(toml, 'missing')).toBeUndefined()
})

test('[R17] the gbrain key is read from an env file without exposing other lines', () => {
  expect(tokenFromEnvFile('# comment\nOTHER=1\nexport GBRAIN_BEARER="abc123"\n')).toBe('abc123')
  expect(tokenFromEnvFile('GBRAIN_API_KEY=xyz\n')).toBe('xyz')
  expect(tokenFromEnvFile('NOTHING=1\n')).toBeUndefined()
})

test('[R17] the gbrain client performs the MCP handshake and returns tool text', async () => {
  const seen: Array<{ method: string; auth: string | null; session: string | null }> = []
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json() as { id?: number; method: string; params?: { name?: string } }
      seen.push({ method: body.method, auth: request.headers.get('authorization'), session: request.headers.get('mcp-session-id') })
      if (body.method === 'initialize') {
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {} } },
          { headers: { 'mcp-session-id': 'sess-1' } })
      }
      if (body.id === undefined) return new Response(null, { status: 202 })
      const result = { content: [{ type: 'text', text: `called ${body.params?.name}` }] }
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const gbrain = createGbrain(`http://127.0.0.1:${server.port}/mcp`, 'secret-token', 2000)
  expect(await gbrain.call('recall', { query: 'x' })).toBe('called recall')
  expect(seen.map(entry => entry.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
  expect(seen.every(entry => entry.auth === 'Bearer secret-token')).toBe(true)
  expect(seen[2]?.session).toBe('sess-1')
})

test('[R17] a slow gbrain times out instead of hanging the hook', async () => {
  server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => undefined) })
  const gbrain = createGbrain(`http://127.0.0.1:${server.port}/mcp`, 'token', 100)
  const started = Date.now()
  await expect(gbrain.ping()).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(2000)
})
