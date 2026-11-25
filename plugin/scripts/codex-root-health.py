#!/usr/bin/python3
"""Probe only the dedicated example-agent App Server and restart after two failures."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys

import websockets

UNIT = "example-backend.service"
SOCKET = "/run/example/rpc.sock"
COUNTER = Path("/run/krotov-plugin-health/failures")
SYSTEMCTL = "/usr/bin/systemctl"


async def probe():
    async with websockets.unix_connect(SOCKET, uri="ws://localhost/", max_size=1024 * 1024) as ws:
        await ws.send(json.dumps({
            "id": 1, "method": "initialize",
            "params": {"clientInfo": {"name": "krot_health", "version": "1"}},
        }))
        while True:
            response = json.loads(await ws.recv())
            if response.get("id") == 1 and "method" not in response:
                return "result" in response


def main():
    active = subprocess.run([SYSTEMCTL, "is-active", "--quiet", UNIT]).returncode == 0
    probing = sys.argv[1:] == ["--probe"]
    if not active:
        if not probing:
            COUNTER.unlink(missing_ok=True)
        return int(probing)
    try:
        healthy = asyncio.run(asyncio.wait_for(probe(), timeout=12))
    except Exception:
        healthy = False
    if probing:
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
        print("Restarting unresponsive example-agent App Server")
        subprocess.run([SYSTEMCTL, "--no-block", "restart", UNIT], check=True)
        failures = 0
    temp = COUNTER.with_suffix(".tmp")
    temp.write_text(str(failures))
    os.replace(temp, COUNTER)
    return 0


if __name__ == "__main__":
    sys.exit(main())
