"""Agent-to-agent API: the same data, answered as structured JSON for other agents.

A person's own agent (it knows that person's role, market and goals) calls
these endpoints, usually through the MCP server in ``mcp_server/``. Answers
are JSON, not OpenUI, and every call is logged so we can study which
questions agents really send and which answers helped.

    GET  /api/agent/manifest               -> what this agent can do (an "agent card")
    GET  /api/agent/datasets?project=      -> datasets, fields, types, sample values
    POST /api/agent/ask                    -> answer + executed query + rows + next questions
    GET  /api/agent/opportunities?project= -> use cases backed by field-level evidence
    GET  /api/agent/profile-options        -> valid industries / countries / bands for match
    POST /api/agent/match                  -> accounts ranked against a customer profile

    GET  /api/admin/agent-queries          -> the query log and its summary (admins)

Callers identify themselves with optional headers, stored in the log:
``X-Agent-Name`` (which agent), ``X-Agent-Session`` (one conversation) and
``X-Agent-Persona`` (short description of the person the agent works for).

Auth, scope and safety are the same as the chat: the caller's API key or
session, the projects that user may see, read-only validated queries, PII
masked by the database tool, and the same guardrails and quotas.
"""

import asyncio
import re
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from backend import account, opportunities
from backend.admin import require_admin
from backend.auth import require_user
from backend.db import business_collection_names, db, project_scope
from backend.guardrails import GuardrailViolation, check_question
from backend.langchain_agent import RUN_TRACE, run_langchain_agent
from backend.observability import logger
from backend.projects import allowed_collections
from backend.schema_discovery import get_schema

router = APIRouter(prefix="/api/agent", tags=["agent-to-agent"])
admin_router = APIRouter(prefix="/api/admin", tags=["agent-to-agent"])

LOG = db["agent_query_log"]
MAX_ROWS = 50
HEADER_LIMITS = {"x-agent-name": 64, "x-agent-session": 64, "x-agent-persona": 300}

# Set by main.py so agent calls share the chat's per-user rate limit.
rate_limit = None


def ensure_indexes():
    # Keep 90 days of agent traffic.
    LOG.create_index("ts", expireAfterSeconds=90 * 24 * 3600)
    LOG.create_index([("agent", 1), ("ts", -1)])


# --------------------------------------------------
# Logging
# --------------------------------------------------

def _caller(request: Request):
    out = {}
    for header, limit in HEADER_LIMITS.items():
        value = (request.headers.get(header) or "").strip()
        out[header.removeprefix("x-agent-")] = value[:limit] or None
    return out


CHANNELS = ("a2u", "mcp", "a2a", "api")


def _channel(request):
    """How the caller reached us: the MCP server sets X-Agent-Channel: mcp,
    the A2A endpoint passes channel="a2a", anything else is a direct API call."""

    value = (request.headers.get("x-agent-channel") or "").strip().lower()
    return value if value in {"mcp", "a2a"} else "api"


def _log(request, user, tool, payload, status, started, channel=None, **extra):
    now = datetime.now(timezone.utc)
    caller = _caller(request)
    entry = {
        "ts": now,
        "channel": channel or _channel(request),
        "user": user["username"],
        "agent": caller["name"] or "unnamed-agent",
        "session": caller["session"],
        "persona": caller["persona"],
        "tool": tool,
        "input": payload,
        "status": status,
        "latency_ms": int((time.perf_counter() - started) * 1000),
        **extra,
    }
    try:
        LOG.insert_one(entry)
    except Exception:  # noqa: BLE001 - logging must never break an answer
        logger.exception("agent query log write failed")


def _scope(user, project):
    return allowed_collections(user, project or None)


# --------------------------------------------------
# Helpers
# --------------------------------------------------

def _intent(query):
    """Rough type of question, for the analytics view."""

    if not isinstance(query, dict):
        return None
    operation = query.get("operation")
    if operation in {"count", "distinct"}:
        return "count" if operation == "count" else "list-values"
    if operation == "find":
        return "lookup"
    stages = " ".join(str(stage) for stage in (query.get("pipeline") or []))
    if "$group" in stages and "$sort" in stages:
        return "ranking"
    if "$group" in stages:
        return "aggregation"
    return "filter"


def _collections_of(query):
    if not isinstance(query, dict):
        return []
    names = {query.get("collection")}
    for stage in query.get("pipeline") or []:
        if isinstance(stage, dict):
            for key in ("$lookup", "$unionWith"):
                inner = stage.get(key)
                if isinstance(inner, dict):
                    names.add(inner.get("from") or inner.get("coll"))
                elif isinstance(inner, str):
                    names.add(inner)
    return sorted(n for n in names if n)


def _fields(collection):
    return get_schema().get(collection, {})


_NOT_METRIC = re.compile(r"(^|_)(id|ids|number|no|code|zip|postal|phone|charter|year|lat|lon|lng|"
                         r"latitude|longitude|rank|index|cik|ein|duns|naics|sic|fips|ncua|rssd|fdic)($|_)", re.I)
# Business measures, most useful first (used to pick the metric for follow-ups).
_MEASURES = ("spend", "revenue", "sales", "income", "salary", "deposits", "assets", "amount", "price", "cost",
             "employee", "headcount", "growth", "size", "total", "count", "value", "rate")


def _measure_rank(field):
    lower = field.lower()
    return next((i for i, word in enumerate(_MEASURES) if word in lower), len(_MEASURES))


def _label(field):
    words = re.sub(r"([a-z])([A-Z])", r"\1 \2", field).replace("_", " ").split()
    words = [w for w in words if w.lower() not in {"num", "usd"}] or words
    label = " ".join(words).lower()
    return f"{label} (USD)" if "usd" in field.lower() else label


def suggested_questions(collections, rows):
    """Grounded follow-ups built from real field names, no model call."""

    out = []
    for name in collections[:1]:
        fields = _fields(name)
        text = [f for f, d in fields.items() if d.get("type") == "str" and not _NOT_METRIC.search(f)]
        numbers = [f for f, d in fields.items()
                   if d.get("type") in {"int", "float"} and not _NOT_METRIC.search(f)]
        # Prefer business measures (spend, revenue, headcount) over other numbers.
        numbers.sort(key=_measure_rank)
        category = next((f for f in text if any(k in f.lower() for k in ("country", "industry", "category", "type",
                                                                    "department", "segment"))), None)
        if category and numbers:
            out.append(f"What is the average {_label(numbers[0])} by {_label(category)} in {name}?")
        if numbers:
            out.append(f"Which 10 records in {name} have the highest {_label(numbers[0])}?")
        if category:
            out.append(f"How many records are there per {_label(category)} in {name}?")
        out.append(f"What opportunities are in {name}?")
    if not out:
        out.append("Which datasets are available and what fields do they have?")
    return out[:4]


def _answer_status(trace, answer, rows):
    if trace.get("status") == "unanswerable":
        return "unanswerable"
    if trace.get("route") == "general":
        return "general"
    if trace.get("query") is None:
        return "failed"
    if isinstance(rows, list) and not rows:
        return "no_data"
    return "answered"


# --------------------------------------------------
# Endpoints
# --------------------------------------------------

MANIFEST = {
    "name": "Queryable Data Agent",
    "description": "Answers questions about company and business datasets (firmographics, HR tech, "
                   "e-commerce, HR) with read-only, validated MongoDB queries. Every answer includes the "
                   "query that ran and the rows it returned, so nothing is invented.",
    "auth": "Authorization: Bearer qc-<personal API key>",
    "identify_yourself": {"X-Agent-Name": "your agent's name", "X-Agent-Session": "one conversation id",
                          "X-Agent-Persona": "one line about the person you work for (optional)"},
    "tools": [
        {"name": "list_datasets", "method": "GET", "path": "/api/agent/datasets",
         "use_when": "First call: learn which datasets and fields exist before asking."},
        {"name": "ask_data", "method": "POST", "path": "/api/agent/ask",
         "use_when": "Any factual question about the data: counts, lists, rankings, comparisons."},
        {"name": "find_opportunities", "method": "GET", "path": "/api/agent/opportunities",
         "use_when": "What business use cases the data supports, with field-level evidence."},
        {"name": "profile_options", "method": "GET", "path": "/api/agent/profile-options",
         "use_when": "Valid industries, countries and size bands before calling match_profile."},
        {"name": "match_profile", "method": "POST", "path": "/api/agent/match",
         "use_when": "Rank accounts that fit the person's ideal customer profile."},
    ],
    "limits": {"rows_returned": MAX_ROWS, "read_only": True, "pii": "masked"},
}


@router.get("/manifest")
def manifest():
    return MANIFEST


def _describe(name, fields):
    """One line an agent can read: what kind of records, and the main fields."""

    lower = " ".join(fields).lower()
    if "company_name" in lower or "company" in lower:
        kind = "company / account records"
    elif "employee" in lower or "attrition" in lower or "department" in lower:
        kind = "employee records"
    elif "order" in lower or "product" in lower or "customer" in lower:
        kind = "commerce records"
    else:
        kind = "records"
    return kind


@router.get("/datasets")
def datasets(request: Request, project: str | None = None, dataset: str | None = None,
             user=Depends(require_user)):
    """Compact overview of every dataset, or full field detail for one ``dataset``.

    The overview stays small on purpose: an agent's context is limited, and a
    wall of sample values for 15 datasets hides the one it needs.
    """

    started = time.perf_counter()
    allowed = _scope(user, project)
    with project_scope(allowed):
        names = sorted(business_collection_names())
        schema = get_schema()
        if dataset:
            if dataset not in names:
                raise HTTPException(status_code=404, detail={
                    "code": "dataset_not_found", "message": f"No dataset '{dataset}'. Available: {', '.join(names)}"})
            fields = schema.get(dataset, {})
            body = {
                "name": dataset,
                "documents": db[dataset].estimated_document_count(),
                "fields": [{"name": f, "type": d.get("type"), "samples": d.get("sample_values", [])[:3]}
                           for f, d in fields.items()],
            }
            _log(request, user, "list_datasets", {"dataset": dataset}, "answered", started, row_count=1)
            return body
        out = []
        for name in names:
            fields = list(schema.get(name, {}))
            out.append({
                "name": name,
                "kind": _describe(name, fields),
                "documents": db[name].estimated_document_count(),
                "field_count": len(fields),
                "fields": fields[:40],
            })
    _log(request, user, "list_datasets", {"project": project}, "answered", started, row_count=len(out))
    return {"datasets": out,
            "tip": "Call again with dataset=<name> for field types and sample values. "
                   "Ask questions with ask_data; the agent picks the dataset itself."}


class AskRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    project: str | None = None


@router.post("/ask")
async def ask(payload: AskRequest, request: Request, user=Depends(require_user)):
    return await answer_question(request, user, payload.question, payload.project)


async def answer_question(request, user, text, project=None, tool="ask_data", channel=None):
    """The shared question pipeline for the agent channels (API, MCP, A2A).

    Same guardrails, quota, project scope and validated read-only query as
    the chat; returns structured JSON instead of OpenUI.
    """

    started = time.perf_counter()
    if rate_limit:
        rate_limit(user)
    try:
        question = check_question(text)
    except GuardrailViolation as violation:
        _log(request, user, tool, {"question": str(text)[:500]}, "blocked", started, channel,
             error=violation.code)
        raise HTTPException(status_code=400, detail={"code": violation.code, "message": violation.message})
    try:
        await asyncio.to_thread(account.count_message, user)
    except account.QuotaExceeded as limit:
        raise HTTPException(status_code=429, detail={"code": "quota_exceeded", "message": limit.message})

    allowed = await asyncio.to_thread(_scope, user, project)
    trace = {}

    def run():
        token = RUN_TRACE.set(trace)
        try:
            with project_scope(allowed):
                answer = run_langchain_agent(question)
                collections = _collections_of(trace.get("query"))
                return answer, suggested_questions(collections, trace.get("rows"))
        finally:
            RUN_TRACE.reset(token)

    try:
        answer, follow_ups = await asyncio.to_thread(run)
    except Exception:
        logger.exception("/api/agent/ask failed")
        _log(request, user, tool, {"question": question}, "error", started, channel)
        raise HTTPException(status_code=500, detail={"code": "agent_error", "message": "The data agent failed."})

    rows = trace.get("rows")
    rows = rows if isinstance(rows, list) else ([] if rows is None else [rows])
    status = _answer_status(trace, answer, rows)
    query = trace.get("query")
    collections = _collections_of(query)
    body = {
        "status": status,
        "answer": answer,
        "query": query,
        "rows": rows[:MAX_ROWS],
        "row_count": len(rows),
        "truncated": len(rows) > MAX_ROWS,
        "collections": collections,
        "intent": _intent(query),
        "missing_field": trace.get("missing"),
        "suggested_next_questions": follow_ups,
        "grounding": "Values come only from the rows above. PII is masked." if query else
                     "No database query ran; this is a general answer, not data.",
        "latency_ms": int((time.perf_counter() - started) * 1000),
    }
    _log(request, user, tool, {"question": question, "project": project}, status, started, channel,
         row_count=len(rows), intent=body["intent"], collections=collections,
         missing_field=trace.get("missing"))
    return body


@router.get("/opportunities")
def find_opportunities(request: Request, project: str | None = None, user=Depends(require_user)):
    started = time.perf_counter()
    allowed = _scope(user, project)
    with project_scope(allowed):
        summary = opportunities.chat_summary(sorted(set(business_collection_names())))
    ready = sum(1 for c in summary["use_cases"] if c["status"] == "ready")
    _log(request, user, "find_opportunities", {"project": project}, "answered" if ready else "no_data",
         started, row_count=ready)
    return summary


@router.get("/profile-options")
def profile_options(request: Request, project: str | None = None, user=Depends(require_user)):
    allowed = _scope(user, project)
    with project_scope(allowed):
        names = sorted(set(business_collection_names()))
        return opportunities.profile_options(opportunities.Context(names))


@router.post("/match")
def match_profile(payload: opportunities.MatchRequest, request: Request, user=Depends(require_user)):
    started = time.perf_counter()
    allowed = _scope(user, payload.project)
    with project_scope(allowed):
        try:
            result = opportunities.match(payload, sorted(set(business_collection_names())))
        except ValueError as error:
            _log(request, user, "match_profile", payload.model_dump(), "bad_request", started, error=str(error))
            raise HTTPException(status_code=400, detail={"code": "bad_request", "message": str(error)})
    status = "answered" if result["total"] else "no_data"
    _log(request, user, "match_profile", payload.model_dump(), status, started, row_count=result["total"])
    return result


# --------------------------------------------------
# Admin: what do agents ask?
# --------------------------------------------------

def _top(counter, n=8):
    return [{"key": k, "count": v} for k, v in counter.most_common(n)]


_WORDS = re.compile(r"[a-z][a-z_]{3,}")
_STOP = {"what", "which", "show", "list", "many", "with", "from", "that", "have", "there", "their", "they",
         "this", "does", "each", "give", "most", "much", "about", "companies", "company", "records", "data",
         "into", "than", "were", "some", "over", "under", "average", "highest", "lowest", "number", "total",
         "dataset", "datasets", "type", "types", "tech", "count", "breakdown", "distribution", "across",
         "between", "along", "including", "versus", "those", "these", "rate", "rates", "list", "unique",
         "field", "fields", "value", "values", "based", "within", "where", "when", "who", "work", "like"}
# Plurals that are topics in their own right (other plurals collapse into their singular).
_KEEP_PLURAL = {"sales", "services", "analytics", "operations", "business", "status", "saas", "aws"}


def _singular(word):
    if word in _KEEP_PLURAL or word.endswith("ss"):
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    return word[:-1] if word.endswith("s") else word


def query_summary(days=30, limit=100):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    entries = list(LOG.find({"ts": {"$gte": since}}, {"_id": 0}).sort("ts", -1).limit(5000))
    total = len(entries)
    by_tool, by_status, by_agent, by_intent, topics = Counter(), Counter(), Counter(), Counter(), Counter()
    by_channel = Counter()
    latencies, gaps = [], Counter()
    for e in entries:
        by_tool[e.get("tool")] += 1
        by_channel[e.get("channel") or "api"] += 1
        by_status[e.get("status")] += 1
        by_agent[e.get("agent")] += 1
        if e.get("intent"):
            by_intent[e["intent"]] += 1
        if e.get("missing_field"):
            gaps[e["missing_field"]] += 1
        latencies.append(e.get("latency_ms") or 0)
        question = (e.get("input") or {}).get("question")
        if question:
            topics.update({_singular(w) for w in _WORDS.findall(question.lower())
                           if w not in _STOP and "_" not in w} - _STOP)
    useful = by_status["answered"]
    latencies.sort()
    recent = []
    for e in entries[:limit]:
        ts = e.get("ts")
        if isinstance(ts, datetime):
            # MongoDB returns naive UTC datetimes: mark them as UTC for the browser.
            e["ts"] = (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)).isoformat()
        recent.append(e)
    # A2U: questions people typed in the chat. Daily usage counts every
    # question, including agent asks, so those are taken off.
    first_day = since.date().isoformat()
    typed = sum(d.get("messages", 0) for d in account.usage.find({"day": {"$gte": first_day}}, {"messages": 1}))
    agent_asks = sum(1 for e in entries if e.get("tool") in {"ask_data", "a2a:ask"} and e.get("status") != "blocked")
    channels = {name: by_channel.get(name, 0) for name in ("mcp", "a2a", "api")}
    channels["a2u"] = max(0, typed - agent_asks)
    return {
        "days": days,
        "total": total,
        "channels": channels,
        "agents": len(by_agent),
        "answered_rate": round(useful / total, 3) if total else None,
        "p50_latency_ms": latencies[len(latencies) // 2] if latencies else None,
        "p90_latency_ms": latencies[int(len(latencies) * 0.9)] if latencies else None,
        "by_tool": _top(by_tool),
        "by_status": _top(by_status),
        "by_agent": _top(by_agent),
        "by_intent": _top(by_intent),
        "topics": _top(topics, 12),
        "data_gaps": _top(gaps),
        "recent": recent,
    }


@admin_router.get("/agent-queries")
def agent_queries(days: int = 30, limit: int = 100, admin=Depends(require_admin)):
    return query_summary(max(1, min(days, 90)), max(1, min(limit, 500)))
