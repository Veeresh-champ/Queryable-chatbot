"""A simulated *personal agent* that talks to our data agent over MCP.

This is the agent-to-agent scenario: an agent that knows one person (role,
market, goal) but not our data. It connects to our MCP server, decides which
tools to call and what to ask, and reports insights for its person. A judge
model then scores relevance, grounding and actionability.

Used by the in-app playground (``backend/agent_playground.py``) and by
``scripts/agent_persona_test.py``.
"""

import asyncio
import json
import time

import httpx

from backend.config import settings

PERSONAS = [
    {"id": "payroll-sales-india",
     "person": "Head of Sales at a payroll SaaS company. Sells to mid-size and large companies in India "
               "and wants a target list of accounts that run payroll on a competitor or have no payroll tool.",
     "goal": "Build this quarter's target account list."},
    {"id": "hr-tech-analyst",
     "person": "Market analyst at an HR-tech investment fund comparing HR technology spend by industry "
               "and deployment type (SaaS vs on-premise vs hybrid).",
     "goal": "Find which segments spend the most and where on-premise is still common."},
    {"id": "eor-expansion-us",
     "person": "Partnerships lead at an Employer-of-Record (global employment) provider looking for "
               "US and European companies that hire across countries.",
     "goal": "Find accounts with international hiring signals and how big they are."},
    {"id": "ecommerce-ops",
     "person": "Operations manager at an online retailer who wants to know which product categories "
               "and customer regions drive revenue.",
     "goal": "Decide where to focus next quarter's marketing budget."},
    {"id": "hr-director-attrition",
     "person": "HR director worried about employee attrition, wants to know which departments, roles "
               "and overtime patterns are linked with people leaving.",
     "goal": "Pick two retention actions with the biggest likely impact."},
    {"id": "fintech-licensed",
     "person": "Compliance consultant who advises fintech startups and wants a list of licensed "
               "financial services companies by country.",
     "goal": "Find licensed fintech companies to partner with."},
]

AGENT_SYSTEM = """You are a personal AI agent working for this person:
{person}
Their goal: {goal}

You can use tools from an external data agent (MCP). Rules:
- Start with list_datasets to see what data exists.
- Always pass caller_context = a one-line description of your person.
- For target / prospect / account lists, call profile_options and then match_profile with the person's
  countries, industries and sizes. For numbers and comparisons use ask_data with focused questions.
- Quote numbers only from tool results. If the data cannot answer something, note it as a data gap.
- You have at most {steps} tool calls. Then stop calling tools and reply with JSON only:
{{"insights":[{{"title":"...","detail":"numbers + evidence","why_it_matters":"..."}}],
  "data_gaps":["..."], "questions_asked":["..."]}}"""

JUDGE_SYSTEM = """You judge whether a data agent helped a person. Person: {person} Goal: {goal}
Score the insights 1-5 on each: relevance (to this person's goal), grounding (backed by numbers/evidence
from tool results, not invented), actionability (they can act on it). Reply JSON only:
{{"relevance":n,"grounding":n,"actionability":n,"verdict":"one sentence","missing":"what would have helped"}}"""


class AgentError(RuntimeError):
    """The model behind the personal agent could not be reached."""


def llm(messages, tools=None, max_tokens=1800):
    if not settings.openrouter_api_key:
        raise AgentError("OPENROUTER_API_KEY is not set, so the personal agent has no model.")
    body = {"model": settings.agent_model, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens}
    if tools:
        body["tools"] = tools
    try:
        response = httpx.post(f"{settings.openrouter_base_url.rstrip('/')}/chat/completions", json=body,
                              timeout=settings.llm_timeout_seconds or 120,
                              headers={"Authorization": f"Bearer {settings.openrouter_api_key}"})
        response.raise_for_status()
        return response.json()["choices"][0]["message"]
    except (httpx.HTTPError, KeyError, IndexError, ValueError) as error:
        raise AgentError(f"The personal agent's model call failed: {type(error).__name__}") from error


def parse_json(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`").split("\n", 1)[-1]
    start, end = text.find("{"), text.rfind("}")
    try:
        return json.loads(text[start:end + 1])
    except (ValueError, TypeError):
        return {"raw": text[:2000]}


def tool_schema(tool):
    return {"type": "function", "function": {"name": tool.name, "description": tool.description or "",
                                             "parameters": tool.inputSchema}}


def _text(result, limit=14000):
    text = "\n".join(getattr(c, "text", "") for c in result.content)
    return text if len(text) <= limit else text[:limit] + "\n...[truncated]"


def _summary(name, parsed):
    """One line describing what a tool call returned, for the timeline."""

    if not isinstance(parsed, dict):
        return "returned a result"
    if parsed.get("status") == "error":
        return f"error: {parsed.get('message')}"
    if name == "list_datasets" and "datasets" in parsed:
        return f"{len(parsed['datasets'])} datasets: " + ", ".join(d["name"] for d in parsed["datasets"][:8])
    if name == "ask_data":
        return f"{parsed.get('status')} · {parsed.get('row_count', 0)} rows"
    if name == "match_profile":
        return f"{parsed.get('total', 0)} matching accounts"
    if name == "find_opportunities":
        ready = [c["title"] for c in parsed.get("use_cases", []) if c.get("status") == "ready"]
        return f"{len(ready)} supported use cases: " + ", ".join(ready[:4])
    if name == "profile_options":
        return f"{len(parsed.get('industries', []))} industries, {len(parsed.get('countries', []))} countries"
    return "returned a result"


async def run(session, persona, steps=6):
    """Run one personal agent over an initialised MCP ClientSession."""

    tools = [tool_schema(t) for t in (await session.list_tools()).tools]
    messages = [{"role": "system", "content": AGENT_SYSTEM.format(steps=steps, **persona)},
                {"role": "user", "content": "Find the most useful insights for me."}]
    calls = []
    started = time.perf_counter()
    for _ in range(steps + 1):
        message = await asyncio.to_thread(llm, messages, tools if len(calls) < steps else None)
        tool_calls = message.get("tool_calls") or []
        messages.append({k: v for k, v in message.items() if k in ("role", "content", "tool_calls")})
        if not tool_calls:
            break
        for call in tool_calls:
            name = call["function"]["name"]
            try:
                arguments = json.loads(call["function"].get("arguments") or "{}")
            except ValueError:
                arguments = {}
            t0 = time.perf_counter()
            result = await session.call_tool(name, arguments)
            text = _text(result)
            parsed = parse_json(text)
            calls.append({"tool": name, "arguments": arguments, "ms": int((time.perf_counter() - t0) * 1000),
                          "status": parsed.get("status") if isinstance(parsed, dict) else None,
                          "summary": _summary(name, parsed),
                          "error": bool(result.isError) or (isinstance(parsed, dict)
                                                            and parsed.get("status") == "error")})
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
    last = messages[-1]
    final = parse_json(last.get("content") if last.get("role") == "assistant" else "")
    judge = parse_json((await asyncio.to_thread(llm, [
        {"role": "system", "content": JUDGE_SYSTEM.format(**persona)},
        {"role": "user", "content": json.dumps(final)[:8000]}], None, 400)).get("content"))
    return {"persona": persona, "calls": calls, "result": final, "judge": judge,
            "seconds": round(time.perf_counter() - started, 1)}
