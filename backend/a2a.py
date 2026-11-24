"""A2A (agent-to-agent): our data agent as a peer that other agents talk to.

How the three channels differ:

* A2U, agent to user: a person types in the chat UI (``/api/chat``) and gets
  OpenUI answers (tables, charts). Human in the loop.
* MCP, agent uses our tools: another agent's model calls our *functions*
  (``list_datasets``, ``ask_data``, ``match_profile``) through
  ``mcp_server/``. The caller does the reasoning; we are a toolbox.
* A2A, agent talks to our agent: another agent sends a *message* to our
  agent ("find payroll prospects in India for my user") and our agent
  decides how to handle it and returns a task with artifacts. We do the
  reasoning on our side; the two agents are peers.

This module implements the core of the A2A protocol (JSON-RPC 2.0):

    GET  /.well-known/agent-card.json   -> Agent Card: who we are, skills, auth (public)
    GET  /.well-known/agent.json        -> same card (older path)
    POST /a2a                           -> JSON-RPC: message/send, tasks/get
    (also /api/a2a/agent-card and /api/a2a, so the web app can call them through its /api proxy)

A message is ``{"role": "user", "parts": [...]}``. A ``text`` part is the
request in plain English. An optional ``data`` part steers the skill:

    {"kind": "data", "data": {"skill": "match_profile", "profile": {...}, "project": "..."}}

``skill`` is ``ask`` (default), ``find_opportunities`` or ``match_profile``.
The reply is a completed Task whose artifact carries the answer as text and
the full structured result (query, rows, evidence) as data.
"""

import time
import uuid
from collections import OrderedDict
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from backend import agent_api, opportunities
from backend.auth import require_user
from backend.db import business_collection_names, project_scope

router = APIRouter(tags=["a2a"])

PROTOCOL_VERSION = "0.3.0"
_TASKS: "OrderedDict[str, dict]" = OrderedDict()  # recent tasks for tasks/get (per process)
_MAX_TASKS = 500

SKILLS = [
    {"id": "ask", "name": "Answer data questions",
     "description": "Answers questions about company, HR-tech, e-commerce and HR datasets with a validated "
                    "read-only query. Returns the answer, the query and the rows.",
     "tags": ["data", "analytics", "firmographics"],
     "examples": ["How many companies use Deel in India?", "Average HR tech spend by deployment type"]},
    {"id": "find_opportunities", "name": "Find business opportunities",
     "description": "Use cases the data supports (international payroll, renewals, cloud migration...) with "
                    "field-level evidence and the top accounts.",
     "tags": ["sales", "opportunities"],
     "examples": ["What opportunities are in this data?"]},
    {"id": "match_profile", "name": "Match an ideal customer profile",
     "description": "Ranks accounts against a profile (industries, countries, size/revenue bands, growth) "
                    "with a drop-out funnel. Send the profile in a data part.",
     "tags": ["icp", "prospecting"],
     "examples": ['data: {"skill": "match_profile", "profile": {"countries": ["India"], "sizes": ["large"]}}']},
]


def agent_card(base_url: str):
    base = base_url.rstrip("/")
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "name": "Queryable Data Agent",
        "description": "A data agent over company and business datasets. Talk to it in plain English; it plans "
                       "and runs read-only queries and replies with grounded, evidence-backed results.",
        "url": f"{base}/a2a",
        "preferredTransport": "JSONRPC",
        "version": "1.0.0",
        "provider": {"organization": "Queryable Chatbot", "url": base},
        "capabilities": {"streaming": False, "pushNotifications": False, "stateTransitionHistory": False},
        "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer",
                                       "description": "Personal API key (qc-...) from Settings -> API keys"}},
        "security": [{"bearer": []}],
        "defaultInputModes": ["text/plain", "application/json"],
        "defaultOutputModes": ["text/plain", "application/json"],
        "skills": SKILLS,
    }


@router.get("/.well-known/agent-card.json")
@router.get("/.well-known/agent.json")
@router.get("/api/a2a/agent-card")  # same card, reachable through the web app's /api proxy
def get_agent_card(request: Request):
    return agent_card(str(request.base_url))


def _now():
    return datetime.now(timezone.utc).isoformat()


def _rpc_error(rpc_id, code, message, status=200):
    return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}},
                        status_code=status)


def _rpc_result(rpc_id, result):
    return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": result})


def _split(message):
    text, data = [], {}
    for part in message.get("parts") or []:
        if not isinstance(part, dict):
            continue
        kind = part.get("kind") or part.get("type")
        if kind == "text" and isinstance(part.get("text"), str):
            text.append(part["text"])
        elif kind == "data" and isinstance(part.get("data"), dict):
            data.update(part["data"])
    return " ".join(text).strip(), data


def _task(message, context_id, state, text, data=None):
    task_id = uuid.uuid4().hex
    reply = {"kind": "message", "role": "agent", "messageId": uuid.uuid4().hex, "taskId": task_id,
             "contextId": context_id, "parts": [{"kind": "text", "text": text}]}
    task = {
        "kind": "task",
        "id": task_id,
        "contextId": context_id,
        "status": {"state": state, "timestamp": _now(), "message": reply},
        "history": [message],
        "artifacts": [],
    }
    if data is not None:
        task["artifacts"].append({
            "artifactId": uuid.uuid4().hex,
            "name": "result",
            "parts": [{"kind": "text", "text": text}, {"kind": "data", "data": data}],
        })
    _TASKS[task_id] = task
    while len(_TASKS) > _MAX_TASKS:
        _TASKS.popitem(last=False)
    return task


async def _handle(request, user, message):
    text, data = _split(message)
    skill = data.get("skill") or "ask"
    project = data.get("project")
    started = time.perf_counter()

    if skill == "match_profile":
        payload = opportunities.MatchRequest(**{k: v for k, v in data.items() if k != "skill"})
        allowed = agent_api._scope(user, payload.project)
        with project_scope(allowed):
            result = opportunities.match(payload, sorted(set(business_collection_names())))
        top = ", ".join(a["name"] or "?" for a in result["accounts"][:5])
        summary = f"{result['total']} account(s) fit this profile." + (f" Top: {top}." if top else "")
        agent_api._log(request, user, "a2a:match_profile", payload.model_dump(),
                       "answered" if result["total"] else "no_data", started, "a2a", row_count=result["total"])
        return "completed", summary, result

    if skill == "find_opportunities":
        allowed = agent_api._scope(user, project)
        with project_scope(allowed):
            result = opportunities.chat_summary(sorted(set(business_collection_names())))
        ready = [c["title"] for c in result["use_cases"] if c["status"] == "ready"]
        summary = (f"{len(ready)} use case(s) are supported by the data: " + "; ".join(ready) + ".") if ready \
            else "The data does not support any of the known use cases yet."
        agent_api._log(request, user, "a2a:find_opportunities", {"project": project},
                       "answered" if ready else "no_data", started, "a2a", row_count=len(ready))
        return "completed", summary, result

    if skill != "ask":
        return "rejected", f"Unknown skill '{skill}'. Use one of: ask, find_opportunities, match_profile.", None
    if not text:
        return "input-required", "Send the question as a text part.", None
    body = await agent_api.answer_question(request, user, text, project, tool="a2a:ask", channel="a2a")
    return "completed", body["answer"], body


@router.post("/a2a")
@router.post("/api/a2a")  # same endpoint, reachable through the web app's /api proxy
async def a2a_rpc(request: Request):
    try:
        rpc = await request.json()
    except Exception:  # noqa: BLE001
        return _rpc_error(None, -32700, "Parse error")
    if not isinstance(rpc, dict) or rpc.get("jsonrpc") != "2.0" or "method" not in rpc:
        return _rpc_error(rpc.get("id") if isinstance(rpc, dict) else None, -32600, "Invalid Request")
    rpc_id = rpc.get("id")

    try:
        user = require_user(request)
    except Exception:  # noqa: BLE001 - HTTPException 401
        return _rpc_error(rpc_id, -32001, "Unauthorized: send Authorization: Bearer qc-...", 401)

    params = rpc.get("params") or {}
    if rpc["method"] == "tasks/get":
        task = _TASKS.get(str(params.get("id")))
        return _rpc_result(rpc_id, task) if task else _rpc_error(rpc_id, -32001, "Task not found")
    if rpc["method"] != "message/send":
        return _rpc_error(rpc_id, -32601, f"Method not found: {rpc['method']}")

    message = params.get("message")
    if not isinstance(message, dict) or not message.get("parts"):
        return _rpc_error(rpc_id, -32602, "Invalid params: message with parts is required")
    message.setdefault("kind", "message")
    message.setdefault("messageId", uuid.uuid4().hex)
    context_id = message.get("contextId") or uuid.uuid4().hex

    from fastapi import HTTPException
    from pydantic import ValidationError

    try:
        state, text, data = await _handle(request, user, message)
    except HTTPException as error:
        detail = error.detail if isinstance(error.detail, dict) else {"message": str(error.detail)}
        state = "rejected" if error.status_code in (400, 404, 409) else "failed"
        state, text, data = state, detail.get("message", "Request failed."), None
    except (ValidationError, ValueError) as error:
        state, text, data = "rejected", f"Invalid request: {error}", None
    return _rpc_result(rpc_id, _task(message, context_id, state, text, data))
