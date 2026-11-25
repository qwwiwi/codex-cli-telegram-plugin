#!/usr/bin/python3 -Es
"""Probe the locally configured Codex backend and restart the opted-in unit."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys

import websockets
from root_backend import load_config

COUNTER = Path("/run/krotov-plugin-health/failures")
SYSTEMCTL = "/usr/bin/systemctl"


async def probe(socket):
    async with websockets.unix_connect(socket, uri="ws://localhost/", max_size=1024 * 1024) as ws:
        await ws.send(json.dumps({
            "id": 1, "method": "initialize",
            "params": {"clientInfo": {"name": "krot_health", "version": "1"}},
        }))
        while True:
            response = json.loads(await ws.recv())
            if response.get("id") == 1 and "method" not in response:
                return "result" in response


def main():
    try:
        config = load_config()
    except (OSError, ValueError):
        print("Could not load the local Codex backend configuration", file=sys.stderr)
        return 2
    unit = config.restart_unit
    probing = sys.argv[1:] == ["--probe"]
    if unit and subprocess.run([SYSTEMCTL, "is-active", "--quiet", unit]).returncode != 0:
        if not probing:
            COUNTER.unlink(missing_ok=True)
        return int(probing)
    try:
        healthy = asyncio.run(asyncio.wait_for(probe(config.socket), timeout=12))
    except Exception:
        healthy = False
    if probing or unit is None:
        print("Codex backend reachable" if healthy else "Codex backend unreachable")
        return int(not healthy)
    if healthy:
        COUNTER.unlink(missing_ok=True)
        return 0
    try:
        failures = int(COUNTER.read_text()) + 1
    except (OSError, ValueError):
        failures = 1
    if failures >= 2:
        print("Restarting the configured unresponsive Codex backend")
        subprocess.run([SYSTEMCTL, "--no-block", "restart", unit], check=True)
        failures = 0
    temp = COUNTER.with_suffix(".tmp")
    temp.write_text(str(failures))
    os.replace(temp, COUNTER)
    return 0


if __name__ == "__main__":
    sys.exit(main())
