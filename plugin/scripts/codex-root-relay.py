#!/usr/bin/python3
"""Relay Krot's narrow stdio protocol to the private root Codex socket."""

import asyncio
import json
import os
import sys

SOCKET = "/run/example/rpc.sock"
WORKSPACE = "/srv/example/workspace"
TELEGRAM_INBOX = "/srv/example/live-state/inbox"
MAX_MESSAGE = 16 * 1024 * 1024
CHAT_TOOL_CALL = "item/tool/call"
# Only this client-owned catalog may cross the root relay. Match chat-actions.ts.
CHAT_TOOL = {
    "type": "function",
    "name": "telegram_action",
    "description": "Perform an action requested by the Telegram owner in the private chat. Returns the Telegram result before the next step.",
    "inputSchema": {
        "type": "object", "additionalProperties": False, "required": ["action"],
        "properties": {
            "action": {"type": "string", "enum": [
                "reply", "edit", "pin", "unpin", "react", "download", "revoke_mandate", "resolve_question",
            ]},
            "target": {"anyOf": [{"type": "integer", "minimum": 1}, {"type": "string", "enum": ["last_reply"]}]},
            "text": {"type": "string", "maxLength": 3900},
            "emoji": {"type": "string"},
            "files": {"type": "array", "maxItems": 10, "items": {"type": "string", "maxLength": 4096}},
            "id": {"type": "string", "maxLength": 256},
            "resolution": {"type": "string", "enum": ["answered"]},
        },
    },
}
ALLOWED = {
    "initialize": {"clientInfo", "capabilities"},
    "initialized": set(),
    "account/read": {"refreshToken"},
    "account/rateLimits/read": set(),
    "model/list": {"limit", "includeHidden"},
    "thread/start": {"cwd", "approvalPolicy", "sandbox", "model", "dynamicTools"},
    "thread/resume": {"cwd", "approvalPolicy", "sandbox", "model", "threadId", "excludeTurns"},
    "thread/fork": {"cwd", "approvalPolicy", "sandbox", "threadId", "excludeTurns"},
    "thread/compact/start": {"threadId"},
    "thread/inject_items": {"threadId", "items"},
    "thread/read": {"threadId", "includeTurns"},
    "thread/goal/get": {"threadId"},
    "thread/goal/set": {"threadId", "status", "origin", "objective", "tokenBudget"},
    "thread/goal/clear": {"threadId"},
    "thread/turns/list": {"threadId", "cursor", "limit", "itemsView", "sortDirection"},
    "turn/start": {"threadId", "input", "model"},
    "turn/steer": {"threadId", "expectedTurnId", "clientUserMessageId", "input"},
    "turn/interrupt": {"threadId", "turnId"},
}
APPROVALS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
}


def valid_answers(result):
    if not isinstance(result, dict) or result.keys() != {"answers"}:
        return False
    answers = result["answers"]
    return isinstance(answers, dict) and len(answers) <= 4 and all(
        isinstance(entry, dict) and entry.keys() == {"answers"}
        and isinstance(values := entry["answers"], list) and 1 <= len(values) <= 7
        and all(isinstance(value, str) and len(value) <= 2000 for value in values)
        for entry in answers.values()
    )


def valid_chat_call(params, opened):
    if not isinstance(params, dict) or params.keys() != {"threadId", "turnId", "callId", "namespace", "tool", "arguments"}:
        return False
    thread = params["threadId"]
    args = params["arguments"]
    properties = CHAT_TOOL["inputSchema"]["properties"]
    return (
        isinstance(thread, str) and thread in opened
        and all(isinstance(params[key], str) and 0 < len(params[key]) <= 128 for key in ("turnId", "callId"))
        and params["namespace"] is None and params["tool"] == CHAT_TOOL["name"]
        and isinstance(args, dict) and args.keys() <= properties.keys()
        and args.get("action") in properties["action"]["enum"]
        and len(json.dumps(args, ensure_ascii=False)) <= 65536
    )


def valid_chat_result(result):
    if not isinstance(result, dict) or result.keys() != {"success", "contentItems"} or type(result["success"]) is not bool:
        return False
    items = result["contentItems"]
    return (isinstance(items, list) and len(items) == 1 and isinstance(items[0], dict)
            and items[0].keys() == {"type", "text"} and items[0]["type"] == "inputText"
            and isinstance(items[0]["text"], str) and 0 < len(items[0]["text"]) <= 8192)


def allowed_request(message, opened, approval_threads=()):
    method = message.get("method")
    params = message.get("params", {})
    if method not in ALLOWED or not isinstance(params, dict) or not params.keys() <= ALLOWED[method]:
        return False
    if method == "initialize":
        return "capabilities" not in params or params["capabilities"] == {
            "experimentalApi": True, "requestAttestation": False,
        }
    if method in {"thread/start", "thread/resume", "thread/fork"}:
        return (
            params.get("cwd") == WORKSPACE
            and params.get("approvalPolicy") == "on-request"
            and params.get("sandbox") == "workspace-write"
            and ("dynamicTools" not in params or params["dynamicTools"] == [CHAT_TOOL])
            and (method != "thread/fork" or
                 (isinstance(params.get("threadId"), str) and params["threadId"] in opened
                  and params.get("excludeTurns") is True))
        )
    if method == "account/read":
        return params.get("refreshToken") is False
    if method == "model/list":
        return params == {"limit": 100, "includeHidden": False}
    if method == "thread/read":
        thread = params.get("threadId")
        return (isinstance(thread, str) and (thread in opened or thread in approval_threads)
                and params.get("includeTurns") is False)
    if method in {"thread/goal/get", "thread/goal/set", "thread/goal/clear"}:
        thread = params.get("threadId")
        if not isinstance(thread, str) or thread not in opened:
            return False
        if method != "thread/goal/set":
            return params == {"threadId": thread}
        objective = params.get("objective")
        if params.get("origin") == "automatic":
            return (params.get("status") == "active" and isinstance(objective, str)
                    and 0 < len(objective) <= 4000 and params.get("tokenBudget") == 60000)
        return (
            params.get("origin") == "user" and params.get("status") in {"active", "paused"}
            and ((objective is None and "tokenBudget" not in params) or
                 (isinstance(objective, str) and 0 < len(objective) <= 4000 and params.get("tokenBudget") == 60000))
        )
    if method == "thread/turns/list":
        thread = params.get("threadId")
        cursor = params.get("cursor", "")
        return (
            isinstance(thread, str) and thread in opened
            and params.get("limit") == 10 and params.get("itemsView") == "full"
            and params.get("sortDirection") == "desc" and isinstance(cursor, str)
            and len(cursor) <= 2048
        )
    if method == "thread/compact/start":
        return isinstance(params.get("threadId"), str) and bool(params["threadId"])
    if method == "thread/inject_items":
        thread = params.get("threadId")
        items = params.get("items")
        if not isinstance(thread, str) or thread not in opened or not isinstance(items, list) or len(items) != 1:
            return False
        message = items[0]
        if (not isinstance(message, dict) or message.keys() != {"type", "role", "content"}
                or message["type"] != "message" or message["role"] != "user"):
            return False
        content = message["content"]
        if not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], dict):
            return False
        part = content[0]
        return (part.keys() == {"type", "text"} and part["type"] == "input_text" and isinstance(part["text"], str)
                and len(part["text"]) <= 90000
                and part["text"].startswith(("Архив Claude Code, выбранный владельцем как справочный контекст.",
                                             "Мандаты владельца Telegram для этой задачи Codex.")))
    if method == "turn/steer":
        thread = params.get("threadId")
        turn = params.get("expectedTurnId")
        client_id = params.get("clientUserMessageId")
        inputs = params.get("input")
        if (not isinstance(thread, str) or thread not in opened or not isinstance(turn, str)
                or not 0 < len(turn) <= 128 or not isinstance(client_id, str)
                or not client_id.isascii() or not client_id.isdecimal() or len(client_id) > 16
                or not isinstance(inputs, list) or not 1 <= len(inputs) <= 11):
            return False
        item = inputs[0]
        return (isinstance(item, dict) and item.keys() == {"type", "text", "text_elements"}
                and item["type"] == "text" and isinstance(item["text"], str)
                and 0 < len(item["text"]) <= 100000 and item["text_elements"] == []
                and all(isinstance(image, dict) and image.keys() == {"type", "path"}
                        and image["type"] == "localImage" and isinstance(path := image["path"], str)
                        and path.startswith(TELEGRAM_INBOX + "/")
                        and os.path.realpath(path).startswith(TELEGRAM_INBOX + "/")
                        for image in inputs[1:]))
    return True


def write(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def relay():
    import websockets

    pending = {}
    requests = {}
    opened = set()
    restart_task = None
    reader = asyncio.StreamReader(limit=MAX_MESSAGE)
    await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer
    )
    async with websockets.unix_connect(SOCKET, uri="ws://localhost/", max_size=MAX_MESSAGE) as server:
        async def restart_backend():
            await asyncio.sleep(0.7)
            child = await asyncio.create_subprocess_exec(
                "/usr/bin/systemctl", "--no-block", "restart", "example-backend.service",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            if await child.wait() == 0:
                # The restart transaction may wait for the Telegram bridge. Signal only
                # the backend cgroup now so a running command stops independently.
                await asyncio.create_subprocess_exec(
                    "/usr/bin/systemctl", "kill", "--kill-whom=all", "--signal=SIGTERM",
                    "example-backend.service",
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )

        async def to_server():
            nonlocal restart_task
            while line := await reader.readline():
                message = json.loads(line)
                if message.get("method") == "krot/background/stop":
                    if message.get("params") == {} and type(message.get("id")) is int:
                        if restart_task is None:
                            restart_task = asyncio.create_task(restart_backend())
                        write({"id": message["id"], "result": {"scheduled": True}})
                    continue
                if "method" in message:
                    approval_threads = {
                        thread for method, thread in pending.values() if method in APPROVALS
                    }
                    accepted = allowed_request(message, opened, approval_threads)
                    if accepted and "id" in message and message["method"] in (
                        "thread/start", "thread/resume", "thread/fork", "thread/turns/list"
                    ):
                        requests[message["id"]] = message["method"]
                    if accepted and message["method"] == "thread/read" and message["params"]["threadId"] not in opened:
                        requests[message["id"]] = "child-metadata"
                elif message.get("id") in pending:
                    method, _ = pending.pop(message["id"])
                    result = message.get("result")
                    if method == CHAT_TOOL_CALL:
                        if set(message) != {"id", "result"} or not valid_chat_result(result):
                            message = {"id": message["id"], "error": {"code": -32601, "message": "Krot relay denied tool response"}}
                        await server.send(json.dumps(message))
                        continue
                    decision = result.get("decision") if isinstance(result, dict) else None
                    accepted = (
                        "error" in message
                        or method in APPROVALS and decision in ("accept", "decline", "cancel")
                        or method == "item/tool/requestUserInput" and valid_answers(result)
                    )
                else:
                    accepted = False

                if accepted:
                    await server.send(json.dumps(message))
                elif "id" in message:
                    write({"id": message["id"], "error": {"code": -32601, "message": "Krot relay denied request"}})

        async def to_client():
            async for value in server:
                message = json.loads(value)
                if "method" in message and "id" in message:
                    method = message["method"]
                    params = message.get("params")
                    if method == CHAT_TOOL_CALL and not valid_chat_call(params, opened):
                        await server.send(json.dumps({
                            "id": message["id"], "error": {"code": -32601, "message": "Krot relay denied tool request"},
                        }))
                        continue
                    thread = params.get("threadId") if isinstance(params, dict) else None
                    pending[message["id"]] = (method, thread if isinstance(thread, str) else None)
                elif message.get("id") in requests:
                    method = requests.pop(message["id"])
                    result = message.get("result")
                    if isinstance(result, dict):
                        if method == "child-metadata":
                            thread = result.get("thread") or {}
                            message["result"] = {"thread": {
                                key: thread.get(key)
                                for key in ("id", "cwd", "source", "parentThreadId", "sessionId")
                            }}
                        elif method == "thread/turns/list":
                            for turn in result.get("data", []):
                                turn["items"] = [
                                    item for item in turn.get("items", [])
                                    if item.get("type") == "userMessage" or
                                    (item.get("type") == "agentMessage" and item.get("phase") != "commentary")
                                ]
                        else:
                            thread = result.get("thread") or {}
                            if thread.get("cwd") == WORKSPACE and isinstance(thread.get("id"), str):
                                opened.add(thread["id"])
                write(message)

        tasks = [asyncio.create_task(to_server()), asyncio.create_task(to_client())]
        done, remaining = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in remaining:
            task.cancel()
        for task in done:
            task.result()


if __name__ == "__main__":
    if len(sys.argv) != 1:
        sys.exit("This relay accepts no arguments")
    asyncio.run(relay())
