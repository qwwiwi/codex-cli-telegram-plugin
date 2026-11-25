import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url))

test('root backend configuration accepts independent deployments and rejects untrusted input', () => {
  const check = Bun.spawnSync(['/usr/bin/python3', '-Es', '-c', `
import os
import sys
import json
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, sys.argv[1])
from root_backend import load_config, parse_config

first = {'socket': '/run/sample/app.sock', 'workspace': '/srv/sample/work',
         'telegram_inbox': '/srv/telegram/inbox', 'restart_unit': 'sample.service'}
second = {'socket': '/run/other/rpc.sock', 'workspace': '/var/other/project',
          'telegram_inbox': '/var/other/files'}
assert parse_config(first).restart_unit == 'sample.service'
assert parse_config(second).socket == second['socket']
assert parse_config(second).restart_unit is None
assert parse_config(dict(first, restart_unit='example@other.service')).restart_unit == 'example@other.service'

def rejects(action):
    try:
        action()
    except (OSError, ValueError):
        return
    raise AssertionError('unsafe configuration accepted')

for invalid in [dict(first, socket='relative.sock'), dict(first, workspace='/srv/../srv/sample'),
                dict(first, telegram_inbox='/'), dict(first, restart_unit='--all.service'),
                dict(first, restart_unit='*.service'), dict(first, restart_unit='x.service other.service'),
                dict(first, token='irrelevant'), dict(first, telegram_inbox='/srv/sample/work/uploads')]:
    rejects(lambda: parse_config(invalid))

with TemporaryDirectory() as root:
    config = Path(root) / 'backend.json'
    config.write_text(json.dumps(first))
    config.chmod(0o600)
    if os.getuid() == 0:
        assert load_config(config).workspace == first['workspace']
        config.chmod(0o622)
        rejects(lambda: load_config(config))
        config.chmod(0o600)
        Path(root).chmod(0o777)
        rejects(lambda: load_config(config))
        Path(root).chmod(0o700)
    else:
        rejects(lambda: load_config(config))
    link = Path(root) / 'link.json'
    link.symlink_to(config)
    rejects(lambda: load_config(link))
`, scripts])
  expect(check.exitCode, check.stderr.toString()).toBe(0)
})

test('health monitoring probes the configured socket and restarts only the opted-in unit', () => {
  const check = Bun.spawnSync(['/usr/bin/python3', '-Es', '-c', `
import runpy
import sys
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

scripts = Path(sys.argv[1])
sys.path.insert(0, str(scripts))
sys.modules['websockets'] = SimpleNamespace()
variables = runpy.run_path(str(scripts / 'codex-root-health.py'))['main'].__globals__
main = variables['main']
calls = []
probes = []

def command(args, **options):
    calls.append(args)
    return SimpleNamespace(returncode=0)

async def failed_probe(socket):
    probes.append(socket)
    return False

variables['subprocess'] = SimpleNamespace(run=command)
variables['probe'] = failed_probe
sys.argv = ['codex-root-health.py']
with TemporaryDirectory() as root:
    variables['COUNTER'] = Path(root) / 'failures'
    config = SimpleNamespace(socket='/run/example-codex/socket', restart_unit=None)
    variables['load_config'] = lambda: config
    with redirect_stdout(StringIO()):
        assert main() == 1
        assert not calls
        config.restart_unit = 'example-codex.service'
        assert main() == 0
        assert main() == 0
    assert probes == [config.socket] * 3
    assert [args[1:] for args in calls] == [
        ['is-active', '--quiet', config.restart_unit],
        ['is-active', '--quiet', config.restart_unit],
        ['--no-block', 'restart', config.restart_unit],
    ]
`, scripts])
  expect(check.exitCode, check.stderr.toString()).toBe(0)
})
