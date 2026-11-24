"""Live playground for the Agent connections page.

Lets an admin *run* each channel from the browser and watch every step:

    GET  /api/agent/playground/status    -> is each channel ready? (signals for the page)
    POST /api/agent/playground/mcp       -> one real MCP session: initialize, tools/list, tools/call
    POST /api/agent/playground/personal  -> a personal agent (LLM) uses our MCP tools for one person

The MCP runs are genuine MCP: the same ``mcp_server`` is started in-process
and spoken to over the MCP protocol (JSON-RPC over in-memory streams). Its
tools call this backend with the signed-in user's own session, so the
user's project permissions apply and no extra API key is needed.

A2U uses the existing ``POST /api/ask``; A2A uses ``POST /api/a2a``.
"""

import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from backend import personal_agent
from backend.a2a import agent_card
from backend.admin import require_admin
from backend.config import settings
from backend.db import ping

router = APIRouter(prefix="/api/agent/playground", tags=["agent-to-agent"])

TOOLS = {"list_datasets", "ask_data", "find_opportunities", "profile_options", "match_profile"}


def _forward(request: Request):
    """Credentials of the signed-in user, passed on to the in-process MCP tools."""

    headers = {}
    for name in ("cookie", "authorization"):
        if request.headers.get(name):
            headers[name] = request.headers[name]
    return headers


def _session(request: Request, name: str):
    """An MCP client session connected to our MCP server, in-process."""

    from mcp.shared.memory import create_connected_server_and_client_session
    from mcp.types import Implementation

    from backend.main import app
    from mcp_server.server import IN_PROCESS, mcp

    IN_PROCESS.set({"transport": httpx.ASGITransport(app=app), "headers": _forward(request)})
    return create_connected_server_and_client_session(
        mcp._mcp_server, client_info=Implementation(name=name, version="1"))


def _root(error):
    """The real error inside anyio's ExceptionGroup wrappers."""

    while getattr(error, "exceptions", None):
        error = error.exceptions[0]
    return error


def _describe(error):
    error = _root(error)
    return str(error) if isinstance(error, personal_agent.AgentError) else f"{type(error).__name__}: {error}"[:300]


def _signal(signals, step, detail, ok=True, started=None):
    signals.append({"step": step, "detail": detail, "ok": ok,
                    "ms": int((time.perf_counter() - started) * 1000) if started else None})


@router.get("/status")
async def status(request: Request, admin=Depends(require_admin)):
    channels = {}
    db_ok = ping()
    llm_ok = bool(settings.openrouter_api_key)
    channels["a2u"] = {
        "ok": db_ok and llm_ok,
        "detail": "Chat ready: MongoDB connected, model configured." if db_ok and llm_ok else
                  ("MongoDB is not reachable." if not db_ok else "OPENROUTER_API_KEY is missing."),
    }
    try:
        from mcp_server.server import mcp

        names = [t.name for t in await mcp.list_tools()]
        channels["mcp"] = {"ok": db_ok, "detail": f"MCP server loaded with {len(names)} tools.", "tools": names}
    except Exception as error:  # noqa: BLE001 - shown as a red signal
        channels["mcp"] = {"ok": False, "detail": f"MCP server could not load ({type(error).__name__}). "
                                                  "Run: pip install -r requirements-mcp.txt", "tools": []}
    card = agent_card(str(request.base_url))
    channels["a2a"] = {"ok": db_ok, "detail": f"Agent Card served with {len(card['skills'])} skills.",
                       "skills": [s["id"] for s in card["skills"]]}
    return {"channels": channels, "model": settings.agent_model if llm_ok else None,
            "personal_agent": {"ok": llm_ok, "detail": "Model configured." if llm_ok else
                               "OPENROUTER_API_KEY is missing, so the personal agent cannot think."},
            "personas": personal_agent.PERSONAS}


class McpCall(BaseModel):
    tool: str
    arguments: dict = Field(default_factory=dict)


@router.post("/mcp")
async def run_mcp(payload: McpCall, request: Request, admin=Depends(require_admin)):
    if payload.tool not in TOOLS:
        raise HTTPException(status_code=400, detail={"code": "bad_request",
                                                     "message": f"Unknown tool. Use one of: {', '.join(sorted(TOOLS))}."})
    signals = []
    t0 = time.perf_counter()
    try:
        async with _session(request, "playground") as session:
            _signal(signals, "initialize", "Connected to the MCP server and agreed the protocol version.", True, t0)
            t1 = time.perf_counter()
            tools = (await session.list_tools()).tools
            _signal(signals, "tools/list", f"{len(tools)} tools offered: " + ", ".join(t.name for t in tools), True, t1)
            t2 = time.perf_counter()
            result = await session.call_tool(payload.tool, payload.arguments)
            text = "\n".join(getattr(c, "text", "") for c in result.content)
            parsed = personal_agent.parse_json(text)
            failed = bool(result.isError) or (isinstance(parsed, dict) and parsed.get("status") == "error")
            _signal(signals, f"tools/call {payload.tool}",
                    personal_agent._summary(payload.tool, parsed) if not result.isError else text[:300],
                    not failed, t2)
    except Exception as error:  # noqa: BLE001 - reported as a red signal, never a 500
        _signal(signals, "error", _describe(error), False)
        return {"ok": False, "signals": signals, "result": None}
    return {"ok": not failed, "signals": signals, "result": parsed}


class PersonalRun(BaseModel):
    persona_id: str | None = None
    person: str | None = Field(default=None, max_length=600)
    goal: str | None = Field(default=None, max_length=300)
    steps: int = Field(default=5, ge=1, le=8)


@router.post("/personal")
async def run_personal(payload: PersonalRun, request: Request, admin=Depends(require_admin)):
    preset = next((p for p in personal_agent.PERSONAS if p["id"] == payload.persona_id), None)
    if payload.person:
        persona = {"id": "custom", "person": payload.person.strip(),
                   "goal": (payload.goal or "Find the most useful insights for me.").strip()}
    elif preset:
        persona = preset
    else:
        raise HTTPException(status_code=400, detail={"code": "bad_request",
                                                     "message": "Pick a persona or describe the person."})
    try:
        async with _session(request, f"persona-{persona['id']}") as session:
            run = await personal_agent.run(session, persona, payload.steps)
    except Exception as error:  # noqa: BLE001 - shown on the page, never a 500
        return {"ok": False, "error": _describe(error), "persona": persona,
                "calls": [], "result": {}, "judge": {}}
    return {"ok": True, **run}
