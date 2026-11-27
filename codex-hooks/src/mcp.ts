// A minimal MCP client over streamable HTTP: initialize, notifications/initialized,
// tools/call. Every request has its own timeout; callers treat any error as "MCP server offline".
// The token is sent only in the Authorization header and never logged.
import { record, type Json, type McpClient } from './types.js'

export function mcpUrlFromToml(toml: string, server: string): string | undefined {
  const escaped = server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const header = new RegExp(`^\\s*\\[mcp_servers\\.(?:"${escaped}"|${escaped})\\]\\s*$`, 'm').exec(toml)
  if (!header) return
  const body = toml.slice(header.index + header[0].length)
  const section = body.slice(0, body.search(/^\s*\[/m) < 0 ? body.length : body.search(/^\s*\[/m))
  return /^\s*url\s*=\s*"([^"]+)"/m.exec(section)?.[1]
}

export function tokenFromEnvFile(content: string): string | undefined {
  for (const name of ['GBRAIN_BEARER', 'GBRAIN_API_KEY', 'GBRAIN_TOKEN']) {
    const match = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm').exec(content)
    const value = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
    if (value) return value
  }
  return
}

function parseBody(body: string, contentType: string, id: number): Json {
  const messages = contentType.includes('text/event-stream')
    ? body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
    : [body]
  for (const message of messages) {
    try {
      const parsed = record(JSON.parse(message))
      if (parsed.id === id) return parsed
    } catch { /* not JSON: keep looking */ }
  }
  throw new Error('no MCP response')
}

export function bearerTransportOk(url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol === 'https:') return true
  return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
}

export function createGbrain(url: string, token: string | undefined, timeoutMs: number): McpClient {
  let session: string | undefined
  let nextId = 1
  let ready: Promise<void> | undefined

  async function post(payload: Json): Promise<Response> {
    // The key travels only over https; plain http is allowed to a loopback address alone, where
    // it never leaves the machine. The caller logs the error.
    if (token && !bearerTransportOk(url)) throw new Error(`refusing to send an MCP credential over plain http to ${new URL(url).host}: use https`)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (token) headers.authorization = `Bearer ${token}`
    if (session) headers['mcp-session-id'] = session
    const response = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
    return response
  }

  async function request(method: string, params: Json): Promise<Json> {
    const id = nextId++
    const response = await post({ jsonrpc: '2.0', id, method, params })
    session ??= response.headers.get('mcp-session-id') ?? undefined
    const message = parseBody(await response.text(), response.headers.get('content-type') ?? '', id)
    if (message.error) throw new Error(`MCP error in ${method}`)
    return record(message.result)
  }

  function initialize(): Promise<void> {
    ready ??= (async () => {
      await request('initialize', {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'codex-hooks', version: '1.0.0' },
      })
      await (await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).body?.cancel()
    })()
    return ready
  }

  return {
    ping: initialize,
    async call(tool, args) {
      await initialize()
      const result = await request('tools/call', { name: tool, arguments: args })
      if (result.isError === true) throw new Error(`tool ${tool} returned an error`)
      const content = Array.isArray(result.content) ? result.content.map(record) : []
      return content.map(item => typeof item.text === 'string' ? item.text : '').filter(Boolean).join('\n')
    },
  }
}
