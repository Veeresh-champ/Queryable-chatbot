"""Queryable Data Agent as an MCP server.

Wraps the backend's agent API (``/api/agent/*``) so any MCP client (Claude
Desktop, Claude Code, a custom agent, another company's personal agent) can
use our data without its own database access, schema knowledge or keys: this
server holds one personal API key and knows which endpoint to call for what.

Run it:

    # stdio, for Claude Desktop / Claude Code / local agents
    python -m mcp_server.server

    # Streamable HTTP, for remote agents (http://127.0.0.1:8765/mcp)
    python -m mcp_server.server --http --port 8765

Environment:

    QC_API_URL   backend base URL           (default http://127.0.0.1:8000)
    QC_API_KEY   a personal key, qc-...      (Settings -> API keys in the app)
    QC_PROJECT   optional default project id to scope every call
"""

import argparse
import contextvars
import json
import os
import uuid

import warnings

import httpx

# FastMCP's settings model (pydantic-settings) warns about its own 'lifespan'
# field on import; it is harmless and not ours to fix, so keep consoles clean.
warnings.filterwarnings("ignore", message=r"Field 'lifespan' has an incomplete definition",
                        module=r"pydantic_settings\..*")

from mcp.server.fastmcp import Context, FastMCP  # noqa: E402

API_URL = os.getenv("QC_API_URL", "http://127.0.0.1:8000").rstrip("/")
API_KEY = os.getenv("QC_API_KEY", "")
DEFAULT_PROJECT = os.getenv("QC_PROJECT") or None
TIMEOUT = float(os.getenv("QC_TIMEOUT_SECONDS", "120"))
SESSION = uuid.uuid4().hex[:12]

# Set by the backend's in-app playground (backend/agent_playground.py) when it
# runs this server in-process: calls then go straight to the FastAPI app with
# the signed-in user's own credentials instead of QC_API_KEY over the network.
IN_PROCESS = contextvars.ContextVar("in_process", default=None)

mcp = FastMCP(
    "queryable-data-agent",
    instructions=(
        "You are talking to a data agent that holds company and business datasets "
        "(firmographics, HR technology, e-commerce, HR). Start with list_datasets to see what exists. "
        "Use ask_data for factual questions, find_opportunities for business use cases, and "
        "profile_options + match_profile to find accounts that fit the person you work for. "
        "Pass caller_context (one line about the person you work for: role, industry, market, goal) "
        "so results can be judged against their needs. Answers include the executed query and rows: "
        "quote values from the rows, never invent them. status 'unanswerable' or 'no_data' means the "
        "data does not contain it; say so instead of guessing."
    ),
)


def _headers(ctx: Context | None, caller_context: str | None):
    agent = "mcp-client"
    try:
        info = ctx.session.client_params.clientInfo  # type: ignore[union-attr]
        agent = info.name if info and info.name else agent
    except Exception:  # noqa: BLE001 - client info is optional
        pass
    headers = {"X-Agent-Name": agent[:64], "X-Agent-Session": SESSION, "X-Agent-Channel": "mcp"}
    local = IN_PROCESS.get()
    if local:
        headers.update(local.get("headers") or {})
    elif API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    if caller_context:
        headers["X-Agent-Persona"] = " ".join(caller_context.split())[:300]
    return headers


async def _call(method, path, ctx, caller_context=None, **kwargs):
    local = IN_PROCESS.get()
    client = (httpx.AsyncClient(transport=local["transport"], base_url="http://in-process", timeout=TIMEOUT)
              if local else httpx.AsyncClient(base_url=API_URL, timeout=TIMEOUT))
    async with client:
        response = await client.request(method, path, headers=_headers(ctx, caller_context), **kwargs)
    if response.status_code >= 400:
        try:
            detail = response.json().get("detail")
        except ValueError:
            detail = response.text[:300]
        message = detail.get("message") if isinstance(detail, dict) else detail
        return {"status": "error", "http_status": response.status_code, "message": message}
    return response.json()


def _project(project):
    return project or DEFAULT_PROJECT


@mcp.tool()
async def list_datasets(ctx: Context, dataset: str | None = None, project: str | None = None) -> dict:
    """List the datasets this agent can query: name, kind of records, row count and field names.

    Call this first. Pass dataset=<name> to get one dataset's field types and sample values.
    """

    params = {k: v for k, v in {"project": _project(project), "dataset": dataset}.items() if v}
    return await _call("GET", "/api/agent/datasets", ctx, params=params or None)


@mcp.tool()
async def ask_data(question: str, ctx: Context, caller_context: str | None = None,
                   project: str | None = None) -> dict:
    """Ask a plain-English question about the data (counts, lists, rankings, comparisons, filters).

    Returns: status (answered | no_data | unanswerable | general | failed), answer text, the exact
    read-only query that ran, up to 50 result rows, intent, and suggested_next_questions.
    caller_context: one line about the person you work for, e.g. "VP Sales at a payroll SaaS selling
    into mid-size fintechs in India". Used for logging and evaluation, never for access.
    """

    return await _call("POST", "/api/agent/ask", ctx, caller_context,
                       json={"question": question, "project": _project(project)})


@mcp.tool()
async def find_opportunities(ctx: Context, caller_context: str | None = None,
                             project: str | None = None) -> dict:
    """Business use cases the data supports (e.g. international payroll, pre-renewal campaign,
    cloud migration), each with status, recommended action, timing and the top accounts with the
    field-level evidence behind them. 'needs_data' means the field is missing, not that the answer is no.
    """

    params = {"project": _project(project)} if _project(project) else None
    return await _call("GET", "/api/agent/opportunities", ctx, caller_context, params=params)


@mcp.tool()
async def profile_options(ctx: Context, project: str | None = None) -> dict:
    """Valid values for match_profile: industries, countries, size/revenue bands and use-case ids."""

    params = {"project": _project(project)} if _project(project) else None
    return await _call("GET", "/api/agent/profile-options", ctx, params=params)


@mcp.tool()
async def match_profile(ctx: Context,
                        industries: list[str] | None = None,
                        countries: list[str] | None = None,
                        sizes: list[str] | None = None,
                        revenues: list[str] | None = None,
                        growth: bool | None = None,
                        use_case: str | None = None,
                        include_unknown: bool = True,
                        limit: int = 20,
                        caller_context: str | None = None,
                        project: str | None = None) -> dict:
    """Rank accounts that fit an ideal customer profile (the person you work for sells to them).

    sizes / revenues use bands: small, mid, large, enterprise (percentiles within each dataset).
    Returns a drop-out funnel, ranked accounts with a score, per-criterion fit
    (match / unknown / any) and evidence, plus notes on missing data. Call profile_options first.
    """

    body = {
        "project": _project(project),
        "use_case": use_case,
        "include_unknown": include_unknown,
        "limit": max(1, min(limit, 200)),
        "profile": {"industries": industries or [], "countries": countries or [], "sizes": sizes or [],
                    "revenues": revenues or [], "growth": growth},
    }
    return await _call("POST", "/api/agent/match", ctx, caller_context, json=body)


@mcp.resource("queryable://manifest")
async def manifest() -> str:
    """What this data agent can do (its agent card)."""

    async with httpx.AsyncClient(base_url=API_URL, timeout=30) as client:
        return json.dumps((await client.get("/api/agent/manifest")).json(), indent=2)


@mcp.prompt()
def research_for(person: str) -> str:
    """Starter prompt: research the data on behalf of a person."""

    return (f"You work for: {person}. Use the queryable-data-agent tools to find the 3 most useful, "
            "evidence-backed insights in the data for this person. Start with list_datasets, then use "
            "ask_data, find_opportunities and match_profile. Pass caller_context every time. For each "
            "insight give the numbers, the query or evidence behind it, and why it matters to them.")


def main():
    parser = argparse.ArgumentParser(description="Queryable Data Agent MCP server")
    parser.add_argument("--http", action="store_true", help="serve Streamable HTTP instead of stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.http:
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        mcp.run(transport="streamable-http")
    else:
        mcp.run()


if __name__ == "__main__":
    main()
