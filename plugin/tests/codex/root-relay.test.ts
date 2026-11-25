import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { agentChatTool } from '../../src/codex/chat-actions.js'

const relay = join(import.meta.dir, '../../scripts/codex-root-relay.py')

test('root relay admits only the owner Telegram tool and its text result', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
import json
import runpy
import sys

relay = runpy.run_path(sys.argv[1])
allowed_request = relay['allowed_request']
valid_chat_call = relay['valid_chat_call']
valid_chat_result = relay['valid_chat_result']
tool = json.load(sys.stdin)
opened = {'thread'}
params = {
    'cwd': relay['WORKSPACE'], 'approvalPolicy': 'on-request', 'sandbox': 'workspace-write',
    'dynamicTools': [tool],
}
assert allowed_request({'method': 'thread/start', 'params': params}, opened)
assert not allowed_request({'method': 'thread/start', 'params': dict(params, dynamicTools=[tool, tool])}, opened)
assert not allowed_request({'method': 'thread/start', 'params': dict(params, dynamicTools=[dict(tool, name='other')])}, opened)
assert not allowed_request({'method': 'thread/resume', 'params': dict(params, threadId='thread')}, opened)

call = {
    'threadId': 'thread', 'turnId': 'turn', 'callId': 'call', 'namespace': None,
    'tool': 'telegram_action', 'arguments': {'action': 'reply', 'text': 'Working'},
}
assert valid_chat_call(call, opened)
assert not valid_chat_call(dict(call, threadId='child'), opened)
assert not valid_chat_call(dict(call, namespace='custom'), opened)
assert not valid_chat_call(dict(call, tool='other'), opened)
assert not valid_chat_call(dict(call, arguments={'action':'reply', 'chat_id':321}), opened)
assert not allowed_request({'method': 'item/tool/call', 'params': call}, opened)

assert valid_chat_result({'success':True, 'contentItems':[{'type':'inputText','text':'{"ok":true}'}]})
assert not valid_chat_result({'success':True, 'contentItems':[{'type':'inputImage','imageUrl':'https://example.com/image.jpg'}]})
assert not valid_chat_result({'success':True, 'contentItems':[{'type':'inputText','text':'x' * 8193}]})
assert not valid_chat_result({'success':1, 'contentItems':[{'type':'inputText','text':'sent'}]})
`, relay], { stdin: Buffer.from(JSON.stringify(agentChatTool)), stderr: 'pipe' })
  expect(check.stderr.toString()).toBe('')
  expect(check.exitCode).toBe(0)
})
