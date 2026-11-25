import { expect, test } from 'bun:test'
import { parseMcpApproval } from '../../src/codex/mcp-approval.js'

function hostedApproval(tool: string, args: Record<string, unknown>, serverName = 'codex_apps') {
  return {
    threadId: 'test-thread',
    turnId: 'test-turn',
    serverName,
    mode: 'form',
    message: 'Подтверди действие в GitHub',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: tool, tool_params: args },
  }
}

test('hosted GitHub tree cards hide file contents and distinguish different payloads', () => {
  const args = { repository_full_name: 'example/private', tree: [{ path: 'report.md', content: 'internal fixture' }] }
  const first = parseMcpApproval(hostedApproval('github.create_tree', args))?.operation
  const second = parseMcpApproval(hostedApproval('github.create_tree', {
    ...args, tree: [{ path: 'report.md', content: 'other change' }],
  }))?.operation
  expect(first?.target).toBe('GitHub / create_tree\nРепозиторий: example/private')
  expect(second?.target).toBe(first?.target)
  expect(first?.dedupeKey).toMatch(/^[a-f0-9]{64}$/u)
  expect(first?.dedupeKey).not.toBe(second?.dedupeKey)
})

test('only recognized non-force GitHub publishing tools get hosted approval previews', () => {
  const args = { repository_full_name: 'example/private' }
  for (const tool of ['create_blob', 'create_commit']) {
    expect(parseMcpApproval(hostedApproval('github.' + tool, args))?.operation.target)
      .toBe('GitHub / ' + tool + '\nРепозиторий: example/private')
  }
  expect(parseMcpApproval(hostedApproval('github.delete_ref', args))).toBeUndefined()
  expect(parseMcpApproval(hostedApproval('github.update_ref', {
    ...args, branch_name: 'main', sha: 'a'.repeat(40), force: true,
  }))).toBeUndefined()
  expect(parseMcpApproval(hostedApproval('other.create_tree', args))).toBeUndefined()
  expect(parseMcpApproval(hostedApproval('github.create_tree', args, 'untrusted'))).toBeUndefined()
  expect(parseMcpApproval(hostedApproval('github.create_tree', { repository_full_name: '../private' }))).toBeUndefined()
  expect(parseMcpApproval(hostedApproval('github.create_tree', { repository_full_name: 'example/..' }))).toBeUndefined()
})

test('hosted ref updates identify the branch and destination commit', () => {
  const args = { repository_full_name: 'example/private', branch_name: 'main', sha: 'a'.repeat(40), expected_sha: 'b'.repeat(40) }
  const target = parseMcpApproval(hostedApproval('github.update_ref', args))?.operation.target
  expect(target).toContain('Ветка: main')
  expect(target).toContain('Коммит: ' + args.sha)
  expect(target).toContain('Ожидаемый коммит: ' + args.expected_sha)
  expect(parseMcpApproval(hostedApproval('github.update_ref', { ...args, branch_name: 'fix/../main' }))).toBeUndefined()
  expect(parseMcpApproval(hostedApproval('github.update_ref', { ...args, sha: 'abc' }))).toBeUndefined()
})

test('hosted branch creation identifies the branch and its exact starting point', () => {
  const branch = { repository_full_name: 'example/private', branch_name: 'fix/preview' }
  const sha = 'a'.repeat(40)
  expect(parseMcpApproval(hostedApproval('github.create_branch', { ...branch, sha }))?.operation.target)
    .toContain('Ветка: fix/preview\nКоммит: ' + sha)
  expect(parseMcpApproval(hostedApproval('github.create_branch', { ...branch, base_ref: 'refs/heads/main' }))?.operation.target)
    .toContain('Ветка: fix/preview\nОснова: refs/heads/main')
  expect(parseMcpApproval(hostedApproval('github.create_branch', { ...branch, base_ref: 'main', sha }))).toBeUndefined()
  expect(parseMcpApproval(hostedApproval('github.create_branch', branch))).toBeUndefined()
  expect(parseMcpApproval(hostedApproval('github.create_ref', {
    repository_full_name: branch.repository_full_name, ref: 'refs/heads/fix/preview', sha,
  }))?.operation.target).toContain('Ветка: refs/heads/fix/preview\nКоммит: ' + sha)
  expect(parseMcpApproval(hostedApproval('github.create_ref', {
    repository_full_name: branch.repository_full_name, ref: 'refs/tags/preview', sha,
  }))).toBeUndefined()
})

test('hosted pull request cards identify both branches, including connector aliases', () => {
  const args = { repository_full_name: 'example/private', head_branch: 'example:fix/preview', base_branch: 'main', head_repo: 'source' }
  const target = parseMcpApproval(hostedApproval('github.create_pull_request', args))?.operation.target
  expect(target).toContain('Из: example:fix/preview\nВ: main')
  expect(target).toContain('Репозиторий источника: source')
  expect(parseMcpApproval(hostedApproval('github.create_pull_request', { ...args, base: 'unrelated' }))).toBeUndefined()
  expect(parseMcpApproval(hostedApproval('github.create_pull_request', { ...args, base_branch: undefined }))).toBeUndefined()
})

test('legacy hosted push cards require a destination branch', () => {
  const args = { repository_full_name: 'example/private', files: [{ path: 'report.md', content: 'internal fixture' }] }
  expect(parseMcpApproval(hostedApproval('github.push_files', { ...args, branch: 'fix/preview' }))?.operation.target)
    .toBe('GitHub / push_files\nРепозиторий: example/private\nВетка: fix/preview')
  expect(parseMcpApproval(hostedApproval('github.push_files', args))).toBeUndefined()
})
