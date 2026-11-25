import { createHash } from 'node:crypto'
import { object } from './rpc.js'
import type { ApprovalRequest } from './session.js'

const name = /^[a-z0-9][a-z0-9_.:-]{0,100}$/i
const sensitiveKey = /"[^"]*(?:token|authorization|password|credential|secret|api[_-]?key)[^"]*"\s*:/iu
const githubWrites = new Set([
  'github.create_blob', 'github.create_tree', 'github.create_commit', 'github.create_branch', 'github.create_ref',
  'github.update_ref', 'github.create_pull_request', 'github.push_files',
])
const ownerPattern = /^[a-z0-9][a-z0-9-]{0,38}$/i
const repositoryName = /^[a-z0-9_.-]{1,100}$/i
const refPattern = /^[a-z0-9_][a-z0-9_./-]{0,119}$/i
const shaPattern = /^[a-f0-9]{40}$/i

function githubRepository(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const [owner, repo, extra] = value.split('/')
  return extra === undefined && ownerPattern.test(owner ?? '') && typeof repo === 'string' &&
    repositoryName.test(repo) && repo !== '.' && repo !== '..'
}

function githubRef(value: unknown): value is string {
  return typeof value === 'string' && refPattern.test(value) && !value.includes('..') && !value.endsWith('.') &&
    value.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.lock'))
}

function githubSha(value: unknown): value is string {
  return typeof value === 'string' && shaPattern.test(value)
}

function githubAlias(primary: unknown, alias: unknown): unknown {
  return primary != null && alias != null && primary !== alias ? undefined : primary ?? alias
}

function hostedGithubApproval(tool: string, rawArgs: unknown, reason: string): ApprovalRequest | undefined {
  const args = object(rawArgs)
  const { repository_full_name, force, owner, repo } = args
  if (!githubWrites.has(tool) || (force !== undefined && force !== false) ||
      Object.keys(args).some(key => /token|authorization|password|credential|secret|api[_-]?key/iu.test(key))) return

  const legacyRepository = typeof owner === 'string' && typeof repo === 'string' ? owner + '/' + repo : undefined
  const repository = githubAlias(repository_full_name, legacyRepository)
  if (!githubRepository(repository)) return

  const details = ['GitHub / ' + tool.slice('github.'.length), 'Репозиторий: ' + repository]
  if (tool === 'github.create_branch') {
    const { branch_name, sha, base_ref } = args
    if (!githubRef(branch_name) || (sha == null) === (base_ref == null)) return
    if (sha != null && !githubSha(sha) || base_ref != null && !githubRef(base_ref)) return
    details.push('Ветка: ' + branch_name, sha != null ? 'Коммит: ' + sha : 'Основа: ' + base_ref)
  } else if (tool === 'github.create_ref' || tool === 'github.update_ref') {
    const branch = tool === 'github.update_ref' ? args.branch_name : args.ref
    const { sha, expected_sha } = args
    if (!githubRef(branch) || (tool === 'github.create_ref' && !branch.startsWith('refs/heads/')) || !githubSha(sha)) return
    details.push('Ветка: ' + branch, 'Коммит: ' + sha)
    if (expected_sha != null) {
      if (!githubSha(expected_sha)) return
      details.push('Ожидаемый коммит: ' + expected_sha)
    }
  } else if (tool === 'github.create_pull_request') {
    const head = githubAlias(args.head, args.head_branch)
    const base = githubAlias(args.base, args.base_branch)
    const { head_repo } = args
    if (typeof head !== 'string' || !githubRef(base)) return
    const [headOwner, headBranch, extra] = head.split(':')
    if (headBranch === undefined ? !githubRef(head) :
      extra !== undefined || !ownerPattern.test(headOwner ?? '') || !githubRef(headBranch)) return
    details.push('Из: ' + head, 'В: ' + base)
    if (head_repo != null) {
      if (typeof head_repo !== 'string' || !(githubRepository(head_repo) ||
          (repositoryName.test(head_repo) && head_repo !== '.' && head_repo !== '..'))) return
      details.push('Репозиторий источника: ' + head_repo)
    }
  } else if (tool === 'github.push_files') {
    const branch = githubAlias(args.branch, args.ref)
    if (!githubRef(branch)) return
    details.push('Ветка: ' + branch)
  }

  // The card omits file contents and messages. Include them in the request identity.
  const serialized = JSON.stringify(args)
  if (serialized.length > 1_000_000) return
  const dedupeKey = createHash('sha256').update('codex_apps:' + tool + ':' + serialized).digest('hex')
  return { kind: 'mcp', target: details.join('\n'), reason, dedupeKey }
}

// Codex marks its own tool approval forms. Other MCP elicitation modes can
// request input, navigate to a URL, or require device verification.
export function parseMcpApproval(
  request: Record<string, unknown>,
): { threadId: string; turnId: string; operation: ApprovalRequest } | undefined {
  const { threadId, turnId, serverName, mode, message, environmentId } = request
  const meta = object(request._meta)
  const schema = object(request.requestedSchema)
  const properties = schema.properties
  if (typeof serverName !== 'string' || !name.test(serverName) ||
      typeof threadId !== 'string' || !threadId || typeof turnId !== 'string' || !turnId ||
      mode !== 'form' || (environmentId != null && environmentId !== 'local') ||
      meta.codex_approval_kind !== 'mcp_tool_call' ||
      typeof meta.tool_name !== 'string' || !name.test(meta.tool_name) ||
      typeof message !== 'string' || !message.trim() || message.length > 400 ||
      schema.type !== 'object' || properties == null || typeof properties !== 'object' ||
      Array.isArray(properties) || Object.keys(properties).length !== 0 ||
      (schema.required != null && (!Array.isArray(schema.required) || schema.required.length !== 0))) return

  if (serverName === 'codex_apps') {
    const operation = hostedGithubApproval(meta.tool_name, meta.tool_params, message)
    return operation ? { threadId, turnId, operation } : undefined
  }
  if (/^github\./iu.test(meta.tool_name)) return

  const args = JSON.stringify(meta.tool_params ?? {}, null, 2)
  const target = serverName + ' / ' + meta.tool_name + '\n' + args
  if (target.length > 2700 || sensitiveKey.test(args)) return
  return { threadId, turnId, operation: { kind: 'mcp', target, reason: message } }
}
