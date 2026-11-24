"""Agent-to-agent test: simulated personal agents talk to our MCP server.

Each persona is a "personal agent" that knows one person's role, market and
goal. It connects to the Queryable Data Agent over MCP (stdio, exactly as an
external client would), decides which tools to call, and reports the
insights it found for its person. A judge model then scores how useful those
insights are for that person.

Every tool call is also stored by the backend in ``agent_query_log``, so the
Admin console -> Agent queries view shows what the agents asked.

Run (backend on :8000, MongoDB up, a personal API key from Settings):

    set QC_API_KEY=qc-...                     # PowerShell: $env:QC_API_KEY="qc-..."
    python -m scripts.agent_persona_test             # all personas
    python -m scripts.agent_persona_test --only 2    # first 2 personas
    python -m scripts.agent_persona_test --steps 8   # tool-call budget per persona

Writes logs/agent_eval/<timestamp>.json and .md.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import Implementation

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.config import settings  # noqa: E402

OUT_DIR = ROOT / "logs" / "agent_eval"

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
- Start with list_datasets.
- Always pass caller_context = a one-line description of your person.
- Ask focused questions. Quote numbers only from tool results.
- If the data cannot answer something, note it as a data gap; do not guess.
- You have at most {steps} tool calls. Then stop calling tools and reply with JSON only:
{{"insights":[{{"title":"...","detail":"numbers + evidence","why_it_matters":"..."}}],
  "data_gaps":["..."], "questions_asked":["..."]}}"""

JUDGE_SYSTEM = """You judge whether a data agent helped a person. Person: {person} Goal: {goal}
Score the insights 1-5 on each: relevance (to this person's goal), grounding (backed by numbers/evidence
from tool results, not invented), actionability (they can act on it). Reply JSON only:
{{"relevance":n,"grounding":n,"actionability":n,"verdict":"one sentence","missing":"what would have helped"}}"""


def _llm(messages, tools=None, max_tokens=1800):
    body = {"model": settings.agent_model, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens}
    if tools:
        body["tools"] = tools
    response = httpx.post(f"{settings.openrouter_base_url.rstrip('/')}/chat/completions", json=body, timeout=120,
                          headers={"Authorization": f"Bearer {settings.openrouter_api_key}"})
    response.raise_for_status()
    return response.json()["choices"][0]["message"]


def _json(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.strip("`").split("\n", 1)[-1]
    start, end = text.find("{"), text.rfind("}")
    try:
        return json.loads(text[start:end + 1])
    except (ValueError, TypeError):
        return {"raw": text[:2000]}


def _tool_schema(tool):
    return {"type": "function", "function": {"name": tool.name, "description": tool.description or "",
                                             "parameters": tool.inputSchema}}


def _short(result, limit=14000):
    text = "\n".join(getattr(c, "text", "") for c in result.content)
    return text if len(text) <= limit else text[:limit] + "\n...[truncated]"


async def run_persona(session, tools, persona, steps):
    messages = [{"role": "system", "content": AGENT_SYSTEM.format(steps=steps, **persona)},
                {"role": "user", "content": "Find the most useful insights for me."}]
    calls = []
    started = time.perf_counter()
    for _ in range(steps + 1):
        message = await asyncio.to_thread(_llm, messages, tools if len(calls) < steps else None)
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
            text = _short(result)
            parsed = _json(text)
            calls.append({"tool": name, "arguments": arguments, "ms": int((time.perf_counter() - t0) * 1000),
                          "status": parsed.get("status") if isinstance(parsed, dict) else None})
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": text})
    final = _json(messages[-1].get("content") if messages[-1]["role"] == "assistant" else "")
    judge = await asyncio.to_thread(_llm, [
        {"role": "system", "content": JUDGE_SYSTEM.format(**persona)},
        {"role": "user", "content": json.dumps(final)[:8000]}], None, 400)
    return {"persona": persona, "calls": calls, "result": final, "judge": _json(judge.get("content")),
            "seconds": round(time.perf_counter() - started, 1)}


def _markdown(report):
    lines = [f"# Agent-to-agent test, {report['started']}", "",
             f"Model: `{report['model']}`, personas: {len(report['runs'])}", "",
             "| Persona | Tool calls | Relevance | Grounding | Actionability | Verdict |", "|---|---|---|---|---|---|"]
    for run in report["runs"]:
        j = run.get("judge") or {}
        lines.append(f"| {run['persona']['id']} | {len(run.get('calls', []))} | {j.get('relevance', '-')} | "
                     f"{j.get('grounding', '-')} | {j.get('actionability', '-')} | {j.get('verdict', run.get('error', ''))} |")
    for run in report["runs"]:
        lines += ["", f"## {run['persona']['id']}", "", f"_{run['persona']['person']}_", "", "**Calls**", ""]
        lines += [f"- `{c['tool']}` {json.dumps(c['arguments'])[:200]} → {c['status'] or 'ok'} ({c['ms']} ms)"
                  for c in run.get("calls", [])]
        for insight in (run.get("result") or {}).get("insights", []):
            lines += ["", f"**{insight.get('title')}**: {insight.get('detail')}",
                      f"  Why: {insight.get('why_it_matters')}"]
        gaps = (run.get("result") or {}).get("data_gaps") or []
        if gaps:
            lines += ["", "Data gaps: " + "; ".join(map(str, gaps))]
    return "\n".join(lines) + "\n"


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", type=int, default=len(PERSONAS))
    parser.add_argument("--steps", type=int, default=6)
    args = parser.parse_args()
    if not os.getenv("QC_API_KEY"):
        sys.exit("Set QC_API_KEY to a personal API key (Settings -> API keys).")
    if not settings.openrouter_api_key:
        sys.exit("Set OPENROUTER_API_KEY in .env (the persona agents and judge use it).")

    server = StdioServerParameters(command=sys.executable, args=["-m", "mcp_server.server"], cwd=str(ROOT),
                                   env={**os.environ})
    report = {"started": datetime.now().isoformat(timespec="seconds"), "model": settings.agent_model, "runs": []}
    # One MCP session per persona, named after it, so the Agent connections
    # page shows which simulated person asked what.
    for persona in PERSONAS[: args.only]:
        print(f"> {persona['id']} ...", flush=True)
        try:
            async with stdio_client(server) as (read, write):
                async with ClientSession(read, write,
                                         client_info=Implementation(name=f"persona-{persona['id']}",
                                                                    version="1")) as session:
                    await session.initialize()
                    tools = [_tool_schema(t) for t in (await session.list_tools()).tools]
                    run = await run_persona(session, tools, persona, args.steps)
        except Exception as error:  # noqa: BLE001 - keep going with the next persona
            run = {"persona": persona, "error": f"{type(error).__name__}: {error}"}
        report["runs"].append(run)
        j = run.get("judge") or {}
        print(f"  calls={len(run.get('calls', []))} relevance={j.get('relevance')} "
              f"grounding={j.get('grounding')} actionability={j.get('actionability')} {run.get('error', '')}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    (OUT_DIR / f"{stamp}.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    (OUT_DIR / f"{stamp}.md").write_text(_markdown(report), encoding="utf-8")
    print(f"\nReport: {OUT_DIR / (stamp + '.md')}")


if __name__ == "__main__":
    asyncio.run(main())
