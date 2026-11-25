"""Read the local administrator's settings for a dedicated Codex backend."""

from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

CONFIG_PATH = Path('/etc/krotov-plugin/root-backend.json')
MAX_CONFIG_BYTES = 16_384
SERVICE_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,199}\.service')


@dataclass(frozen=True)
class RootBackend:
    socket: str
    workspace: str
    telegram_inbox: str
    restart_unit: str | None


def configured_path(value):
    if (not isinstance(value, str) or not value.startswith('/') or value.startswith('//')
            or value == '/' or os.path.normpath(value) != value or len(value) > 4096
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise ValueError('Expected an absolute normalized backend path')
    return value


def parse_config(data):
    paths = {'socket', 'workspace', 'telegram_inbox'}
    if not isinstance(data, dict) or not paths <= data.keys() <= paths | {'restart_unit'}:
        raise ValueError('Invalid backend configuration fields')
    socket = configured_path(data['socket'])
    workspace = configured_path(data['workspace'])
    inbox = configured_path(data['telegram_inbox'])
    if os.path.commonpath((workspace, inbox)) in (workspace, inbox):
        raise ValueError('Workspace and Telegram inbox must use separate directories')
    unit = data.get('restart_unit')
    if unit is not None and (not isinstance(unit, str) or not SERVICE_NAME.fullmatch(unit)):
        raise ValueError('Expected one named systemd service')
    return RootBackend(socket, workspace, inbox, unit)


def unique_fields(pairs):
    data = dict(pairs)
    if len(data) != len(pairs):
        raise ValueError('Duplicate backend configuration field')
    return data


def load_config(path=CONFIG_PATH):
    """The relay and its monitor use only the fixed local configuration path."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    parent = os.open(path.parent, flags | os.O_DIRECTORY)
    try:
        directory = os.fstat(parent)
        if directory.st_uid != 0 or directory.st_mode & 0o022:
            raise ValueError('Backend configuration directory must be controlled by root')
        fd = os.open(path.name, flags | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, 'rb') as config:
            info = os.fstat(config.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise ValueError('Backend configuration must be a regular file controlled by root')
            data = config.read(MAX_CONFIG_BYTES + 1)
            if len(data) > MAX_CONFIG_BYTES:
                raise ValueError('Backend configuration exceeds its size limit')
    finally:
        os.close(parent)
    return parse_config(json.loads(data, object_pairs_hook=unique_fields))
