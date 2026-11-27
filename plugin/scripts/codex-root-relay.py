#!/usr/bin/python3 -Es
"""Relay Krot's narrow stdio protocol to the private root Codex socket."""

import asyncio
import json
import os
import re
import signal
import stat
import sys
import tempfile

MAX_MESSAGE = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_SPOOL_BYTES = 128 * 1024 * 1024
MAX_SPOOL_IMAGES = 128
# render_preview answers with its facts and one inline PNG; the data URL is capped well under MAX_MESSAGE.
MAX_PREVIEW_URL = 4_000_000
PREVIEW_URL = re.compile(r"data:image/png;base64,[A-Za-z0-9+/]+={0,2}")
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
THREAD_OPEN = {"thread/start", "thread/resume", "thread/fork"}
CHAT_TOOL_CALL = "item/tool/call"
MCP_ELICITATION = "mcpServer/elicitation/request"
# Match the hosted publishing tools previewed by mcp-approval.ts.
MCP_GITHUB_WRITES = {
    "github.create_blob", "github.create_tree", "github.create_commit", "github.create_ref",
    "github.update_ref", "github.create_branch", "github.create_pull_request", "github.push_files",
}
MCP_NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,100}")
GITHUB_REPOSITORY = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9-]{0,38}/[a-zA-Z0-9_.-]{1,100}")
SENSITIVE_ARG = re.compile(r"token|authorization|password|credential|secret|api[_-]?key", re.IGNORECASE)
WORKER_ID = re.compile(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}")
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
            "emoji": {"type": "string", "description":
                      "For react: one emoji from the reaction palette in your instructions, only on an inbound owner "
                      "message, at most one per message. React rarely and only when it fits the dialogue (a joke, good news, "
                      "thanks), never on every message."},
            "files": {"type": "array", "maxItems": 10, "items": {"type": "string", "maxLength": 4096}},
            "id": {"type": "string", "maxLength": 256},
            "resolution": {"type": "string", "enum": ["answered"]},
        },
    },
}
# Widget component tools. Match components.ts (componentTools).
COMPONENT_NAMES = [
    "kpi", "bars", "progress", "steps", "compare", "pros-cons", "faq", "status",
    "flowchart", "architecture", "line-area", "donut", "timeline-roadmap", "radar", "bars3d", "network3d",
]
COMPONENT_FIELD = {"type": "string", "enum": COMPONENT_NAMES}
COMPONENT_TOOLS = [
    {
        "type": "function",
        "name": "send_component",
        "description": "Send data to the Telegram owner as a visual widget instead of a wall of text. "
                       "Call component_schema first for the exact data fields. At most one component per answer. "
                       "If the widget cannot be shown, the data is sent as plain text and the result says so: then do not resend it.",
        "inputSchema": {
            "type": "object", "additionalProperties": False, "required": ["component", "data"],
            "properties": {
                "component": COMPONENT_FIELD,
                "data": {"type": "object"},
                "caption": {"type": "string", "maxLength": 1024},
                "target": {"type": "integer", "minimum": 1},
            },
        },
    },
    {
        "type": "function",
        "name": "update_component",
        "description": "Show new data for a component sent earlier: sends a new widget and deletes the old one. "
                       "message_id must come from send_component or update_component of this bridge run.",
        "inputSchema": {
            "type": "object", "additionalProperties": False, "required": ["message_id", "component", "data"],
            "properties": {
                "message_id": {"type": "integer", "minimum": 1},
                "component": COMPONENT_FIELD,
                "data": {"type": "object"},
            },
        },
    },
    {
        "type": "function",
        "name": "component_schema",
        "description": "Return the JSON schema of the data and a working example for one component. Sends nothing.",
        "inputSchema": {
            "type": "object", "additionalProperties": False, "required": ["component"],
            "properties": {"component": COMPONENT_FIELD},
        },
    },
]
# R42: a PNG of how a message looks in Telegram, for the agent only. Match render-preview.ts (renderPreviewTool).
RENDER_PREVIEW_TOOL = {
    "type": "function",
    "name": "render_preview",
    "description": "Show yourself how a message looks in the owner's Telegram, as a PNG picture with the facts: "
                   "message_id of a reply this bridge sent in this run, or text of a draft rendered the way the bridge sends it. "
                   "Give exactly one of them. Sends nothing to Telegram.",
    "inputSchema": {
        "type": "object", "additionalProperties": False,
        "properties": {
            "message_id": {"type": "integer", "minimum": 1},
            "text": {"type": "string", "maxLength": 3900},
        },
    },
}
# The exact dynamicTools list a trusted thread is opened with. Match chat-actions.ts (agentTools).
CHAT_TOOLS = [CHAT_TOOL, *COMPONENT_TOOLS, RENDER_PREVIEW_TOOL]
CHAT_TOOLS_WITHOUT_WIDGET_SEND = [tool for tool in CHAT_TOOLS if tool["name"] != "send_component"]
CHAT_TOOLS_BY_NAME = {tool["name"]: tool for tool in CHAT_TOOLS}
ALLOWED = {
    "initialize": {"clientInfo", "capabilities"},
    "initialized": set(),
    "account/read": {"refreshToken"},
    "account/rateLimits/read": set(),
    "model/list": {"limit", "includeHidden"},
    "thread/start": {"cwd", "approvalPolicy", "sandbox", "model", "dynamicTools"},
    "thread/resume": {"cwd", "approvalPolicy", "sandbox", "model", "threadId", "excludeTurns"},
    "thread/fork": {"cwd", "approvalPolicy", "sandbox", "threadId", "excludeTurns", "ephemeral", "lastTurnId"},
    "thread/compact/start": {"threadId"},
    "thread/inject_items": {"threadId", "items"},
    "thread/read": {"threadId", "includeTurns"},
    "thread/goal/get": {"threadId"},
    "thread/goal/set": {"threadId", "status", "origin", "objective", "tokenBudget"},
    "thread/goal/clear": {"threadId"},
    "thread/turns/list": {"threadId", "cursor", "limit", "itemsView", "sortDirection"},
    "turn/start": {"threadId", "input", "model", "approvalPolicy", "sandboxPolicy"},
    "turn/steer": {"threadId", "expectedTurnId", "clientUserMessageId", "input"},
    "turn/interrupt": {"threadId", "turnId"},
}
APPROVALS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
}


def as_dict(value):
    return value if isinstance(value, dict) else {}


def open_directories(parent_fd, parts):
    directory = os.dup(parent_fd)
    try:
        for part in parts:
            child = os.open(part, DIRECTORY_FLAGS, dir_fd=directory)
            os.close(directory)
            directory = child
        return directory
    except OSError:
        os.close(directory)
        raise


def image_parts(path, inbox):
    prefix = inbox.rstrip(os.sep) + os.sep
    if not isinstance(path, str) or "\0" in path or not path.startswith(prefix):
        return None
    parts = path[len(prefix):].split(os.sep)
    return parts if all(part not in ("", ".", "..") for part in parts) else None


class MediaSpool:
    def __init__(self, inbox, parent="/run"):
        self.inbox = inbox
        self.parent = parent
        self.inbox_fd = None
        self.directory = None
        self.bytes = 0
        self.files = 0

    def read_image(self, path, limit):
        parts = image_parts(path, self.inbox)
        if not parts:
            raise ValueError("Invalid image path")
        if self.inbox_fd is None:
            root = os.open("/", DIRECTORY_FLAGS)
            try:
                self.inbox_fd = open_directories(root, self.inbox.split("/")[1:])
            finally:
                os.close(root)
        directory = open_directories(self.inbox_fd, parts[:-1])
        try:
            descriptor = os.open(parts[-1], os.O_PATH | os.O_NOFOLLOW, dir_fd=directory)
            try:
                source = os.fstat(descriptor)
                if (not stat.S_ISREG(source.st_mode) or source.st_nlink != 1
                        or source.st_uid != os.fstat(self.inbox_fd).st_uid or not 0 < source.st_size <= limit):
                    raise ValueError("Unsafe image source")
                # O_PATH identifies the inode before attempting to open it for reading.
                with open("/proc/self/fd/" + str(descriptor), "rb") as stream:
                    contents = stream.read(limit + 1)
            finally:
                os.close(descriptor)
        finally:
            os.close(directory)
        if not 0 < len(contents) <= limit:
            raise ValueError("Image exceeds the spool budget")
        return contents

    def stage(self, inputs):
        images = inputs[1:]
        if not images:
            return inputs
        if self.files + len(images) > MAX_SPOOL_IMAGES:
            raise ValueError("Image count exceeds the spool budget")
        if self.directory is None:
            if self.parent == "/run" and os.geteuid() != 0:
                raise ValueError("Image staging requires the root relay")
            self.directory = tempfile.TemporaryDirectory(prefix="krotov-media-", dir=self.parent)
        paths = []
        size = 0
        try:
            for image in images:
                path = image["path"]
                data = self.read_image(path, min(MAX_IMAGE_BYTES, MAX_SPOOL_BYTES - self.bytes - size))
                suffix = os.path.splitext(path)[1].lower()
                if not re.fullmatch(r"\.[a-z0-9]{1,10}", suffix):
                    suffix = ""
                with tempfile.NamedTemporaryFile(dir=self.directory.name, suffix=suffix, delete=False) as copy:
                    paths.append(copy.name)
                    copy.write(data)
                size += len(data)
        except (OSError, ValueError):
            for path in paths:
                os.unlink(path)
            raise
        self.files += len(paths)
        self.bytes += size
        return [inputs[0], *({"type": "localImage", "path": path} for path in paths)]

    def close(self):
        if self.inbox_fd is not None:
            os.close(self.inbox_fd)
        if self.directory is not None:
            self.directory.cleanup()


def valid_mcp_form(params, opened, workers):
    params = as_dict(params)
    thread = params.get("threadId")
    turn = params.get("turnId")
    server = params.get("serverName")
    message = params.get("message")
    meta = as_dict(params.get("_meta"))
    tool = meta.get("tool_name")
    schema = as_dict(params.get("requestedSchema"))
    if (not isinstance(thread, str) or (thread not in opened and workers.get(thread) not in opened)
            or not isinstance(turn, str) or not 0 < len(turn) <= 128
            or not isinstance(server, str) or not MCP_NAME.fullmatch(server)
            or not isinstance(tool, str) or not MCP_NAME.fullmatch(tool)
            or params.get("mode") != "form" or params.get("environmentId") not in (None, "local")
            or meta.get("codex_approval_kind") != "mcp_tool_call"
            or not isinstance(message, str) or not message.strip() or len(message) > 400
            or schema.get("type") != "object" or schema.get("properties") != {}
            or schema.get("required") not in (None, [])):
        return False
    if server == "codex_apps":
        args = as_dict(meta.get("tool_params"))
        repository = args.get("repository_full_name")
        owner, repo = args.get("owner"), args.get("repo")
        if repository is None and isinstance(owner, str) and isinstance(repo, str):
            repository = owner + "/" + repo
        return (tool in MCP_GITHUB_WRITES and ("force" not in args or args["force"] is False)
                and isinstance(repository, str) and bool(GITHUB_REPOSITORY.fullmatch(repository))
                and not repository.endswith(("/.", "/..")) and not any(SENSITIVE_ARG.search(key) for key in args))
    return not tool.lower().startswith("github.")


def valid_mcp_decision(result):
    if not isinstance(result, dict):
        return False
    if result.get("action") == "accept":
        return result.keys() == {"action", "content"} and result["content"] == {}
    return result.keys() == {"action"} and result["action"] in ("decline", "cancel")


def observe_workers(message, opened, workers):
    if "id" in message or message.get("method") not in ("item/started", "item/completed"):
        return
    params = as_dict(message.get("params"))
    parent = params.get("threadId")
    if not isinstance(parent, str):
        return
    session = parent if parent in opened else workers.get(parent)
    if session not in opened:
        return
    item = as_dict(params.get("item"))
    if item.get("type") == "subAgentActivity" and item.get("kind") in ("started", "interacted"):
        children = [item.get("agentThreadId")]
    elif item.get("type") == "collabAgentToolCall":
        children = [child for child, state in as_dict(item.get("agentsStates")).items()
                    if as_dict(state).get("status") in ("running", "pendingInit")]
    else:
        return

    for child in children:
        if not isinstance(child, str) or not WORKER_ID.fullmatch(child) or child == parent or child in opened:
            continue
        if len(workers) >= 128 and child not in workers:
            del workers[next(iter(workers))]
        workers[child] = session


def worker_metadata(thread, requested, opened, expected_session, workspace):
    thread = as_dict(thread)
    session = thread.get("sessionId")
    parent = thread.get("parentThreadId")
    source = as_dict(thread.get("source"))
    subagent = as_dict(source.get("subAgent"))
    spawn = as_dict(subagent.get("thread_spawn"))
    depth = spawn.get("depth")
    if (thread.get("id") != requested or thread.get("cwd") != workspace
            or not isinstance(session, str) or session not in opened
            or (expected_session is not None and session != expected_session)
            or not isinstance(parent, str) or spawn.get("parent_thread_id") != parent
            or type(depth) is not int or depth < 1 or (depth == 1 and parent != session)):
        return {}
    visible = {
        "id": requested, "cwd": workspace, "parentThreadId": parent, "sessionId": session,
        "source": {"subAgent": {"thread_spawn": {"parent_thread_id": parent, "depth": depth}}},
    }
    status = as_dict(thread.get("status")).get("type")
    if status in ("idle", "notLoaded", "active"):
        visible["status"] = {"type": status}
    return visible


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
    tool = CHAT_TOOLS_BY_NAME.get(params["tool"]) if isinstance(params["tool"], str) else None
    if tool is None or not isinstance(args, dict):
        return False
    properties = tool["inputSchema"]["properties"]
    if tool is CHAT_TOOL:
        known_choice = args.get("action") in properties["action"]["enum"]
    elif tool is RENDER_PREVIEW_TOOL:
        message_id, text = args.get("message_id"), args.get("text")
        known_choice = len(args) == 1 and (
            type(message_id) is int and message_id >= 1
            or isinstance(text, str) and len(text) <= properties["text"]["maxLength"]
        )
    else:
        known_choice = (args.get("component") in COMPONENT_NAMES
                        and ("data" not in args or isinstance(args["data"], dict)))
    return (
        isinstance(thread, str) and thread in opened
        and all(isinstance(params[key], str) and 0 < len(params[key]) <= 128 for key in ("turnId", "callId"))
        and params["namespace"] is None
        and args.keys() <= properties.keys() and known_choice
        and len(json.dumps(args, ensure_ascii=False)) <= 65536
    )


def valid_chat_result(result):
    if not isinstance(result, dict) or result.keys() != {"success", "contentItems"} or type(result["success"]) is not bool:
        return False
    items = result["contentItems"]
    return (isinstance(items, list) and len(items) in (1, 2) and isinstance(items[0], dict)
            and items[0].keys() == {"type", "text"} and items[0]["type"] == "inputText"
            and isinstance(items[0]["text"], str) and 0 < len(items[0]["text"]) <= 8192
            and (len(items) == 1 or valid_preview_image(items[1])))


def valid_preview_image(item):
    # Only an inline PNG (render_preview): never a URL Codex would fetch.
    return (isinstance(item, dict) and item.keys() == {"type", "imageUrl"} and item["type"] == "inputImage"
            and isinstance(url := item["imageUrl"], str) and len(url) <= MAX_PREVIEW_URL
            and PREVIEW_URL.fullmatch(url) is not None)


def valid_turn_input(inputs, telegram_inbox, max_text_length):
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 11:
        return False
    item = inputs[0]
    return (isinstance(item, dict) and item.keys() == {"type", "text", "text_elements"}
            and item["type"] == "text" and isinstance(item["text"], str)
            and 0 < len(item["text"]) <= max_text_length and item["text_elements"] == []
            and all(isinstance(image, dict) and image.keys() == {"type", "path"}
                    and image["type"] == "localImage" and image_parts(image["path"], telegram_inbox)
                    for image in inputs[1:]))


def inside_workspace(path, workspace):
    return (isinstance(path, str) and "\0" not in path and path.startswith("/")
            and os.path.normpath(path) == path and (path == workspace or path.startswith(workspace.rstrip("/") + "/")))


def valid_turn_policy(params, workspace):
    """A turn override is either absent or the restricted workspace-write shape.

    approvalPolicy "never" is the agent turn; "on-request" restores the owner
    policy the relay opens every thread with. Both write only inside the
    configured workspace; full access and any other shape are refused.
    """
    if "approvalPolicy" not in params and "sandboxPolicy" not in params:
        return True
    policy = params.get("sandboxPolicy")
    if params.get("approvalPolicy") not in ("never", "on-request") or not isinstance(policy, dict):
        return False
    roots = policy.get("writableRoots")
    return (policy.keys() == {"type", "writableRoots", "networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"}
            and policy["type"] == "workspaceWrite"
            and all(type(policy[key]) is bool for key in ("networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"))
            and isinstance(roots, list) and 1 <= len(roots) <= 8
            and all(inside_workspace(root, workspace) for root in roots))


def allowed_request(message, opened, config, approval_threads=(), observed_workers=()):
    method = message.get("method")
    params = message.get("params", {})
    if method not in ALLOWED or not isinstance(params, dict) or not params.keys() <= ALLOWED[method]:
        return False
    if method == "initialize":
        return "capabilities" not in params or params["capabilities"] == {
            "experimentalApi": True, "requestAttestation": False,
        }
    if method in THREAD_OPEN:
        return (
            params.get("cwd") == config.workspace
            and params.get("approvalPolicy") == "on-request"
            and params.get("sandbox") == "workspace-write"
            and ("dynamicTools" not in params or params["dynamicTools"] in (CHAT_TOOLS, CHAT_TOOLS_WITHOUT_WIDGET_SEND))
            and (method == "thread/start" or
                 (isinstance(params.get("threadId"), str) and 0 < len(params["threadId"]) <= 128
                  and params.get("excludeTurns") is True))
            and (method != "thread/fork" or
                 (params["threadId"] in opened and params.get("ephemeral", True) is True
                  and ("lastTurnId" not in params or (isinstance(params["lastTurnId"], str)
                                                      and 0 < len(params["lastTurnId"]) <= 128))))
        )
    if method == "account/read":
        return params.get("refreshToken") is False
    if method == "model/list":
        return params == {"limit": 100, "includeHidden": False}
    if method == "thread/read":
        thread = params.get("threadId")
        return (isinstance(thread, str) and (thread in opened or thread in approval_threads or thread in observed_workers)
                and params.get("includeTurns") is False)
    if method in {"thread/goal/get", "thread/goal/set", "thread/goal/clear"}:
        thread = params.get("threadId")
        if not isinstance(thread, str) or thread not in opened:
            return False
        if method != "thread/goal/set":
            return params == {"threadId": thread}
        objective = params.get("objective")
        budget = params.get("tokenBudget")
        valid_objective = (isinstance(objective, str) and 0 < len(objective) <= 4000
                           and "tokenBudget" in params and (budget is None or budget == 60000))
        if params.get("origin") == "automatic":
            return params.get("status") == "active" and valid_objective
        return (
            params.get("origin") == "user" and params.get("status") in {"active", "paused"}
            and ((objective is None and "tokenBudget" not in params) or valid_objective)
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
    if method in {"thread/compact/start", "turn/start", "turn/steer", "turn/interrupt"}:
        thread = params.get("threadId")
        if not isinstance(thread, str) or thread not in opened:
            return False
        if method == "thread/compact/start":
            return True
        if method == "turn/interrupt":
            turn = params.get("turnId")
            return isinstance(turn, str) and 0 < len(turn) <= 128
        inputs = params.get("input")
        if method == "turn/start":
            return (valid_turn_input(inputs, config.telegram_inbox, MAX_MESSAGE)
                    and valid_turn_policy(params, config.workspace))
        turn = params.get("expectedTurnId")
        client_id = params.get("clientUserMessageId")
        return (isinstance(turn, str) and 0 < len(turn) <= 128 and isinstance(client_id, str)
                and client_id.isascii() and client_id.isdecimal() and len(client_id) <= 16
                and valid_turn_input(inputs, config.telegram_inbox, 100000))
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
    return True


def write(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def relay(config):
    import websockets

    pending = {}
    requests = {}
    opened = set()
    observed_workers = {}
    restart_task = None
    spool = MediaSpool(config.telegram_inbox)
    reader = asyncio.StreamReader(limit=MAX_MESSAGE)
    await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer
    )
    async with websockets.unix_connect(config.socket, uri="ws://localhost/", max_size=MAX_MESSAGE) as server:
        async def restart_backend(unit):
            await asyncio.sleep(0.7)
            child = await asyncio.create_subprocess_exec(
                "/usr/bin/systemctl", "--no-block", "restart", unit,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await child.wait()

        async def to_server():
            nonlocal restart_task
            while line := await reader.readline():
                message = json.loads(line)
                message_id = message.get("id")
                if message.get("method") == "krot/background/stop":
                    if message.get("params") == {} and type(message.get("id")) is int:
                        unit = config.restart_unit
                        if unit is not None and restart_task is None:
                            restart_task = asyncio.create_task(restart_backend(unit))
                        write({"id": message_id, "result": {"scheduled": unit is not None}})
                    continue
                if "method" in message:
                    method = message["method"]
                    approval_threads = {
                        thread for method, thread, _ in pending.values() if method in APPROVALS
                    }
                    accepted = allowed_request(message, opened, config, approval_threads, observed_workers)
                    if accepted and method in ("turn/start", "turn/steer"):
                        try:
                            message["params"]["input"] = spool.stage(message["params"]["input"])
                        except (OSError, ValueError):
                            accepted = False
                    if accepted and "id" in message and (method in THREAD_OPEN or method == "thread/turns/list"):
                        requests[message_id] = (method, message["params"].get("threadId"))
                    if accepted and "id" in message and method == "thread/read":
                        thread = message["params"]["threadId"]
                        if thread not in opened:
                            requests[message_id] = ("child-metadata", (thread, observed_workers.get(thread)))
                elif type(message_id) in (str, int) and message_id in pending:
                    method, _, _ = pending.pop(message_id)
                    result = message.get("result")
                    if method == MCP_ELICITATION:
                        if set(message) != {"id", "result"} or not valid_mcp_decision(result):
                            message = {"id": message_id, "result": {"action": "cancel"}}
                        await server.send(json.dumps(message))
                        continue
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
                elif "method" in message and "id" in message:
                    write({"id": message["id"], "error": {"code": -32601, "message": "Krot relay denied request"}})

        async def to_client():
            async for value in server:
                message = json.loads(value)
                observe_workers(message, opened, observed_workers)
                if message.get("method") == "serverRequest/resolved" and "id" not in message:
                    resolution = as_dict(message.get("params"))
                    request_id = resolution.get("requestId")
                    entry = pending.get(request_id) if type(request_id) in (str, int) else None
                    if (entry and entry[0] == MCP_ELICITATION
                            and resolution.get("threadId") in (None, entry[1])
                            and resolution.get("turnId") in (None, entry[2])):
                        del pending[request_id]
                if "method" in message and "id" in message:
                    method = message["method"]
                    params = message.get("params")
                    if method == MCP_ELICITATION and (
                        type(message["id"]) not in (str, int) or not valid_mcp_form(params, opened, observed_workers)
                    ):
                        await server.send(json.dumps({"id": message["id"], "result": {"action": "cancel"}}))
                        continue
                    if method == CHAT_TOOL_CALL and not valid_chat_call(params, opened):
                        await server.send(json.dumps({
                            "id": message["id"], "error": {"code": -32601, "message": "Krot relay denied tool request"},
                        }))
                        continue
                    params = as_dict(params)
                    thread = params.get("threadId")
                    pending[message["id"]] = (method, thread if isinstance(thread, str) else None, params.get("turnId"))
                elif message.get("id") in requests:
                    method, scope = requests.pop(message["id"])
                    result = message.get("result")
                    if method in THREAD_OPEN:
                        thread = as_dict(as_dict(result).get("thread"))
                        thread_id = thread.get("id")
                        if (isinstance(thread_id, str) and 0 < len(thread_id) <= 128 and thread.get("cwd") == config.workspace
                                and (thread_id == scope if method == "thread/resume" else thread_id not in opened)):
                            opened.add(thread_id)
                        else:
                            message = {"id": message["id"], "error": {"code": -32601, "message": "Krot relay denied thread result"}}
                    elif isinstance(result, dict):
                        if method == "child-metadata":
                            thread, expected_session = scope
                            message["result"] = {"thread": worker_metadata(
                                result.get("thread"), thread, opened, expected_session, config.workspace,
                            )}
                        elif method == "thread/turns/list":
                            for turn in result.get("data", []):
                                turn["items"] = [
                                    item for item in turn.get("items", [])
                                    if item.get("type") == "userMessage" or
                                    (item.get("type") == "agentMessage" and item.get("phase") != "commentary")
                                ]
                write(message)

        tasks = [asyncio.create_task(to_server()), asyncio.create_task(to_client())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            spool.close()
        for task in done:
            task.result()


async def run_relay(config):
    loop = asyncio.get_running_loop()
    task = asyncio.current_task()
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        await relay(config)
    except asyncio.CancelledError:
        pass
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


if __name__ == "__main__":
    if len(sys.argv) != 1:
        sys.exit("This relay accepts no arguments")
    from root_backend import load_config

    try:
        config = load_config()
    except (OSError, ValueError):
        sys.exit("Trusted root backend configuration is unavailable")
    asyncio.run(run_relay(config))
