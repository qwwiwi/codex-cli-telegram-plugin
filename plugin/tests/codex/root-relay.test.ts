import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { agentChatTool } from '../../src/codex/chat-actions.js'

const relay = join(import.meta.dir, '../../scripts/codex-root-relay.py')
const localConfig = `
from types import SimpleNamespace

config = SimpleNamespace(
    socket='/run/test-backend/rpc.sock',
    workspace='/srv/test-backend/workspace',
    telegram_inbox='/srv/test-bot/inbox',
    restart_unit=None,
)
`

test('root relay exits when its trusted config is missing', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
import runpy
import sys
from types import SimpleNamespace
from unittest.mock import patch

def load_config():
    raise OSError('private config path fixture')

script = sys.argv[1]
with patch.object(sys, 'argv', [script]), patch.dict(sys.modules, {'root_backend': SimpleNamespace(load_config=load_config)}):
    try:
        runpy.run_path(script, run_name='__main__')
    except SystemExit as error:
        assert str(error) == 'Trusted root backend configuration is unavailable'
    else:
        raise AssertionError('The relay must exit before opening the backend')
`, relay], { stderr: 'pipe' })
  expect(check.stderr.toString()).toBe('')
  expect(check.exitCode).toBe(0)
})

test('root relay shuts down cleanly on the bridge stop signal', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
import asyncio
import os
import runpy
import signal
import sys

run_relay = runpy.run_path(sys.argv[1])['run_relay']
closed = False

async def simulated_backend(config):
    asyncio.get_running_loop().call_soon(os.kill, os.getpid(), signal.SIGTERM)
    try:
        await asyncio.sleep(5)
        raise AssertionError('The relay ignored shutdown')
    finally:
        global closed
        closed = True

run_relay.__globals__['relay'] = simulated_backend
asyncio.run(run_relay(None))
assert closed
`, relay], { stderr: 'pipe', timeout: 3000 })
  expect(check.exitCode, check.stderr.toString()).toBe(0)
})

test('root relay admits only the owner Telegram tool and its text result', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
import json
import runpy
import sys
${localConfig}

relay = runpy.run_path(sys.argv[1])
allowed_request = relay['allowed_request']
valid_chat_call = relay['valid_chat_call']
valid_chat_result = relay['valid_chat_result']
tool = json.load(sys.stdin)
opened = {'thread'}
params = {
    'cwd': config.workspace, 'approvalPolicy': 'on-request', 'sandbox': 'workspace-write',
    'dynamicTools': [tool],
}
assert allowed_request({'method': 'thread/start', 'params': params}, opened, config)
assert not allowed_request({'method': 'thread/start', 'params': dict(params, cwd='/srv/other/workspace')}, opened, config)
assert not allowed_request({'method': 'thread/start', 'params': dict(params, dynamicTools=[tool, tool])}, opened, config)
assert not allowed_request({'method': 'thread/start', 'params': dict(params, dynamicTools=[dict(tool, name='other')])}, opened, config)
assert not allowed_request({'method': 'thread/resume', 'params': dict(params, threadId='thread')}, opened, config)
resume = dict(params, threadId='thread')
del resume['dynamicTools']
assert not allowed_request({'method': 'thread/resume', 'params': resume}, opened, config)
assert allowed_request({'method': 'thread/resume', 'params': dict(resume, excludeTurns=True)}, opened, config)
# A side thread forks the main thread ephemerally to reuse its prompt cache.
fork = dict(resume, excludeTurns=True)
assert allowed_request({'method': 'thread/fork', 'params': dict(fork, ephemeral=True)}, opened, config)
assert not allowed_request({'method': 'thread/fork', 'params': dict(fork, ephemeral=False)}, opened, config)
assert not allowed_request({'method': 'thread/start', 'params': dict(params, ephemeral=True)}, opened, config)
assert not allowed_request({'method': 'thread/fork', 'params': dict(fork, ephemeral=True, threadId='other')}, opened, config)

call = {
    'threadId': 'thread', 'turnId': 'turn', 'callId': 'call', 'namespace': None,
    'tool': 'telegram_action', 'arguments': {'action': 'reply', 'text': 'Working'},
}
assert valid_chat_call(call, opened)
assert not valid_chat_call(dict(call, threadId='child'), opened)
assert not valid_chat_call(dict(call, namespace='custom'), opened)
assert not valid_chat_call(dict(call, tool='other'), opened)
assert not valid_chat_call(dict(call, arguments={'action':'reply', 'chat_id':321}), opened)
assert not allowed_request({'method': 'item/tool/call', 'params': call}, opened, config)

assert valid_chat_result({'success':True, 'contentItems':[{'type':'inputText','text':'{"ok":true}'}]})
assert not valid_chat_result({'success':True, 'contentItems':[{'type':'inputImage','imageUrl':'https://example.com/image.jpg'}]})
assert not valid_chat_result({'success':True, 'contentItems':[{'type':'inputText','text':'x' * 8193}]})
assert not valid_chat_result({'success':1, 'contentItems':[{'type':'inputText','text':'sent'}]})
`, relay], { stdin: Buffer.from(JSON.stringify(agentChatTool)), stderr: 'pipe' })
  expect(check.stderr.toString()).toBe('')
  expect(check.exitCode).toBe(0)
})

test('root relay scopes turn input and controls to the configured inbox and opened threads', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
from pathlib import Path
import runpy
import sys
from tempfile import TemporaryDirectory
${localConfig}

allowed = runpy.run_path(sys.argv[1])['allowed_request']
opened = {'thread'}

def request(method, **params):
    return allowed({'method':method, 'params':params}, opened, config)

def input_request(method, path=None, thread='thread', text='See attachment'):
    items = [{'type':'text', 'text':text, 'text_elements':[]}]
    if path is not None:
        items.append({'type':'localImage', 'path':path})
    extra = {'expectedTurnId':'turn', 'clientUserMessageId':'123'} if method == 'turn/steer' else {}
    return request(method, threadId=thread, input=items, **extra)

with TemporaryDirectory() as directory:
    root = Path(directory).resolve()
    inbox = root / 'inbox'
    inbox.mkdir()
    outside = root / 'outside.png'
    outside.touch()
    config.telegram_inbox = str(inbox)

    for method in ('turn/start', 'turn/steer'):
        assert input_request(method)
        assert input_request(method, str(inbox / 'photo.png'))
        assert not input_request(method, str(inbox / 'photo.png'), thread='unopened')
        assert not input_request(method, str(root / 'inbox-other' / 'photo.png'))
        assert not input_request(method, str(inbox / '..' / 'outside.png'))
        assert not input_request(method, str(inbox / 'photo.png') + chr(0))

assert input_request('turn/start', text='a' * 100001)
assert not input_request('turn/steer', text='a' * 100001)
assert request('turn/interrupt', threadId='thread', turnId='turn')
assert not request('turn/interrupt', threadId='unopened', turnId='turn')
assert not request('turn/interrupt', threadId='thread', turnId='')
assert request('thread/compact/start', threadId='thread')
assert not request('thread/compact/start', threadId='unopened')
`, relay], { stderr: 'pipe' })
  expect(check.stderr.toString()).toBe('')
  expect(check.exitCode).toBe(0)
})

test('root relay stages synthetic photos from a pinned inbox and removes its private copies', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
from base64 import b64decode
import os
from pathlib import Path
import runpy
import stat
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

MediaSpool = runpy.run_path(sys.argv[1])['MediaSpool']
png = b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf2kAAAAASUVORK5CYII=')

def image(path):
    return {'type':'localImage', 'path':str(path)}

def reject(spool, path):
    try:
        spool.stage([{'type':'text'}, image(path)])
    except (OSError, ValueError):
        return
    raise AssertionError('The relay must refuse this photo source')

with TemporaryDirectory() as directory:
    root = Path(directory).resolve()
    inbox, outside = root / 'inbox', root / 'other.png'
    inbox.mkdir()
    outside.write_bytes(b'outside')
    (inbox / 'photo.png').write_bytes(png)
    (inbox / 'next.png').write_bytes(png)
    (inbox / 'link.png').symlink_to(outside)
    os.link(outside, inbox / 'hardlink.png')
    os.mkfifo(inbox / 'fifo.png')
    spool = MediaSpool(str(inbox), str(root))
    try:
        inputs = [{'type':'text'}, image(inbox / 'photo.png')]
        forwarded = spool.stage(inputs)
        staged = Path(forwarded[1]['path'])
        assert forwarded[0] == inputs[0]
        assert staged.parent.parent == root and staged.parent != inbox and staged.suffix == '.png'
        assert staged.read_bytes() == png
        assert stat.S_IMODE(staged.stat().st_mode) == 0o600
        assert stat.S_IMODE(staged.parent.stat().st_mode) == 0o700
        reject(spool, inbox / 'link.png')
        reject(spool, inbox / 'hardlink.png')
        reject(spool, inbox / 'fifo.png')
        (inbox / 'photo.png').write_bytes(b'replacement')
        assert staged.read_bytes() == png
        inbox.rename(root / 'pinned')
        inbox.mkdir()
        (inbox / 'next.png').write_bytes(b'replacement')
        second = spool.stage([{'type':'text'}, image(inbox / 'next.png')])
        assert Path(second[1]['path']).read_bytes() == png
        with patch.dict(MediaSpool.stage.__globals__, {'MAX_SPOOL_BYTES': 2 * len(png)}):
            reject(spool, inbox / 'next.png')
    finally:
        spool.close()
    assert not staged.parent.exists()
`, relay], { stderr: 'pipe' })
  expect(check.stderr.toString()).toBe('')
  expect(check.exitCode).toBe(0)
})

test('root relay admits only one-time decisions for empty local MCP approval forms', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
import runpy
import sys

relay = runpy.run_path(sys.argv[1])
valid_form = relay['valid_mcp_form']
valid_decision = relay['valid_mcp_decision']
opened = {'thread'}
workers = {'worker': 'thread'}
form = {
    'threadId': 'worker', 'turnId': 'turn', 'serverName': 'codex_apps', 'mode': 'form',
    'message': 'Approve this write?',
    'requestedSchema': {'type': 'object', 'properties': {}},
    '_meta': {
        'codex_approval_kind': 'mcp_tool_call', 'tool_name': 'github.create_ref',
        'tool_params': {'repository_full_name': 'test/fixture'},
    },
}
assert valid_form(form, opened, workers)
assert valid_form(dict(form, threadId='thread'), opened, workers)
assert valid_form(dict(form, serverName='notes', _meta=dict(form['_meta'], tool_name='task_read')), opened, workers)
assert not valid_form(dict(form, threadId='unrelated'), opened, workers)
assert not valid_form(dict(form, environmentId='remote'), opened, workers)
assert not valid_form(dict(form, mode='url'), opened, workers)
assert not valid_form(dict(form, requestedSchema={'type':'object', 'properties':{'answer':{'type':'string'}}}), opened, workers)
assert not valid_form(dict(form, _meta=dict(form['_meta'], tool_name='github.delete_ref')), opened, workers)
assert not valid_form(dict(form, _meta=dict(form['_meta'], tool_params=dict(form['_meta']['tool_params'], force=True))), opened, workers)
assert not valid_form(dict(form, _meta=dict(form['_meta'], tool_params={'repository_full_name':'test/..'})), opened, workers)

assert valid_decision({'action':'accept', 'content':{}})
assert valid_decision({'action':'decline'})
assert valid_decision({'action':'cancel'})
assert not valid_decision({'action':'accept'})
assert not valid_decision({'action':'accept', 'content':{'answer':'yes'}})
assert not valid_decision({'action':'accept', 'content':{}, '_meta':{'persist':'always'}})
assert not valid_decision({'action':'decline', 'content':{}})
assert not valid_decision({'action':'acceptForSession', 'content':{}})
`, relay], { stderr: 'pipe' })
  expect(check.stderr.toString()).toBe('')
  expect(check.exitCode).toBe(0)
})

test('root relay forwards an MCP decision once for its matching pending RPC ID', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
import asyncio
from contextlib import ExitStack
import json
import runpy
import sys
from unittest.mock import patch
${localConfig}

source = runpy.run_path(sys.argv[1])

class Socket:
    def __init__(self):
        self.from_server = asyncio.Queue()
        self.to_server = asyncio.Queue()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        pass

    async def send(self, value):
        self.to_server.put_nowait(json.loads(value))

    def __aiter__(self):
        return self

    async def __anext__(self):
        return json.dumps(await self.from_server.get())

async def check():
    socket = Socket()
    reader = asyncio.StreamReader()
    to_client = asyncio.Queue()

    def client(message):
        reader.feed_data((json.dumps(message) + chr(10)).encode())

    async def take(queue):
        return await asyncio.wait_for(queue.get(), 1)

    async def ignored(message):
        client(message)
        client({'id':99, 'method':'test/barrier'})
        assert (await take(to_client))['id'] == 99
        assert socket.to_server.empty()

    async def connect_read_pipe(*_):
        pass

    def connect(path, **_):
        assert path == config.socket
        return socket

    with ExitStack() as stack:
        stack.enter_context(patch.dict(sys.modules, {'websockets': SimpleNamespace(unix_connect=connect)}))
        stack.enter_context(patch.object(asyncio, 'StreamReader', lambda **_: reader))
        stack.enter_context(patch.object(asyncio.get_running_loop(), 'connect_read_pipe', connect_read_pipe))
        stack.enter_context(patch.dict(source['relay'].__globals__, {'write': to_client.put_nowait}))
        spawn = stack.enter_context(patch.object(asyncio, 'create_subprocess_exec'))
        task = asyncio.create_task(source['relay'](config))
        try:
            client({'id':20, 'method':'krot/background/stop', 'params':{}})
            assert await take(to_client) == {'id':20, 'result':{'scheduled':False}}
            spawn.assert_not_called()
            opening = {'id':10, 'method':'thread/start', 'params':{
                'cwd':config.workspace, 'approvalPolicy':'on-request', 'sandbox':'workspace-write'}}
            client(opening)
            assert await take(socket.to_server) == opening
            socket.from_server.put_nowait({'id':10, 'result':{'thread':{'id':'thread', 'cwd':config.workspace}}})
            assert (await take(to_client))['id'] == 10
            for ident, method, extra, returned in (
                (11, 'thread/start', {}, {'id':'other', 'cwd':'/elsewhere'}),
                (12, 'thread/resume', {'threadId':'saved', 'excludeTurns':True}, {'id':'other', 'cwd':config.workspace}),
                (13, 'thread/fork', {'threadId':'thread', 'excludeTurns':True}, {'id':'thread', 'cwd':config.workspace}),
            ):
                opening = {'id':ident, 'method':method, 'params':{
                    'cwd':config.workspace, 'approvalPolicy':'on-request', 'sandbox':'workspace-write', **extra}}
                client(opening)
                assert await take(socket.to_server) == opening
                socket.from_server.put_nowait({'id':ident, 'result':{'thread':returned, 'private':'fixture'}})
                rejected = await take(to_client)
                assert rejected.keys() == {'id', 'error'} and rejected['id'] == ident
            form = {'id':1, 'method':source['MCP_ELICITATION'], 'params':{
                'threadId':'thread', 'turnId':'turn', 'serverName':'notes', 'mode':'form',
                'message':'Allow this tool call?', 'requestedSchema':{'type':'object', 'properties':{}},
                '_meta':{'codex_approval_kind':'mcp_tool_call', 'tool_name':'task_read'}}}
            socket.from_server.put_nowait(form)
            assert await take(to_client) == form

            decision = {'id':1, 'result':{'action':'accept', 'content':{}}}
            for wrong_id in (2, True, '1'):
                await ignored(dict(decision, id=wrong_id))
            for scope in ({'threadId':'other'}, {'threadId':'thread', 'turnId':'other'}):
                resolution = {'method':'serverRequest/resolved', 'params':{'requestId':1, **scope}}
                socket.from_server.put_nowait(resolution)
                assert await take(to_client) == resolution
            client(decision)
            assert await take(socket.to_server) == decision
            await ignored(decision)

            socket.from_server.put_nowait(dict(form, id=3))
            assert (await take(to_client))['id'] == 3
            client({'id':3, 'result':{'action':'accept', 'content':{'extra':True}}})
            assert await take(socket.to_server) == {'id':3, 'result':{'action':'cancel'}}

            socket.from_server.put_nowait(dict(form, id=4))
            assert (await take(to_client))['id'] == 4
            resolution = {'method':'serverRequest/resolved', 'params':{'requestId':4, 'threadId':'thread', 'turnId':'turn'}}
            socket.from_server.put_nowait(resolution)
            assert await take(to_client) == resolution
            await ignored(dict(decision, id=4))
        finally:
            reader.feed_eof()
            await asyncio.wait_for(task, 1)

asyncio.run(check())
`, relay], { stderr: 'pipe' })
  expect(check.stderr.toString()).toBe('')
  expect(check.exitCode).toBe(0)
})

test('root relay limits status reads to server-observed workers in its open session', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
import runpy
import sys
${localConfig}

relay = runpy.run_path(sys.argv[1])
observe = relay['observe_workers']
allowed = relay['allowed_request']
metadata = relay['worker_metadata']
opened = {'thread'}
workers = {}
child = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
descendant = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
foreign = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
read = {'method':'thread/read', 'params':{'threadId':child, 'includeTurns':False}}
activity = {'method':'item/started', 'params':{'threadId':'thread',
    'item':{'type':'subAgentActivity', 'kind':'started', 'agentThreadId':child}}}
assert not allowed(read, opened, config, observed_workers=workers)
observe(dict(activity, id=1), opened, workers)
assert not workers
observe(activity, opened, workers)
observe({'method':'item/completed', 'params':{'threadId':child,
    'item':{'type':'collabAgentToolCall', 'agentsStates':{descendant:{'status':'pendingInit'}}}}}, opened, workers)
observe(dict(activity, params={'threadId':'unowned', 'item':dict(activity['params']['item'], agentThreadId=foreign)}), opened, workers)
assert workers == {child:'thread', descendant:'thread'}
assert allowed(read, opened, config, observed_workers=workers)
assert not allowed(dict(read, params=dict(read['params'], includeTurns=True)), opened, config, observed_workers=workers)
assert not allowed(dict(read, params=dict(read['params'], threadId=foreign)), opened, config, observed_workers=workers)

source = {'subAgent':{'thread_spawn':{'parent_thread_id':'thread', 'depth':1}}}
thread = {'id':child, 'cwd':config.workspace, 'source':source, 'parentThreadId':'thread',
    'sessionId':'thread', 'status':{'type':'idle', 'hidden':'fixture'}, 'turns':['secret output']}
visible = metadata(thread, child, opened, 'thread', config.workspace)
assert visible == {'id':child, 'cwd':config.workspace, 'source':source,
    'parentThreadId':'thread', 'sessionId':'thread', 'status':{'type':'idle'}}
assert not metadata(dict(thread, cwd='/tmp'), child, opened, 'thread', config.workspace)
assert not metadata(dict(thread, id=foreign), child, opened, 'thread', config.workspace)
assert not metadata(dict(thread, sessionId='other'), child, opened, 'thread', config.workspace)
assert not metadata(dict(thread, parentThreadId='foreign'), child, opened, 'thread', config.workspace)
`, relay], { stderr: 'pipe' })
  expect(check.stderr.toString()).toBe('')
  expect(check.exitCode).toBe(0)
})

test('root relay forwards native unlimited goal budgets on open threads', () => {
  const check = Bun.spawnSync(['python3', '-B', '-c', `
import runpy
import sys
${localConfig}

allowed = runpy.run_path(sys.argv[1])['allowed_request']
opened = {'thread'}
params = {'threadId':'thread', 'status':'active', 'origin':'automatic', 'objective':'task', 'tokenBudget':None}
def check(**changes):
    return allowed({'method':'thread/goal/set', 'params':dict(params, **changes)}, opened, config)
assert check()
assert check(origin='user')
assert check(tokenBudget=60000)
assert not check(tokenBudget=1)
assert not check(threadId='different')
assert not check(status='paused')
assert not check(objective='')
assert not allowed({'method':'thread/goal/set', 'params':{k:v for k,v in params.items() if k != 'tokenBudget'}}, opened, config)
assert allowed({'method':'thread/goal/set', 'params':{'threadId':'thread','status':'paused','origin':'user'}}, opened, config)
`, relay], { stderr: 'pipe' })
  expect(check.stderr.toString()).toBe('')
  expect(check.exitCode).toBe(0)
})
