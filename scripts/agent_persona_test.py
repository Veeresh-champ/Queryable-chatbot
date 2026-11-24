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
from datetime import datetime
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import Implementation

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.config import settings  # noqa: E402

from backend.personal_agent import PERSONAS, run as run_persona  # noqa: E402

OUT_DIR = ROOT / "logs" / "agent_eval"


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
                    run = await run_persona(session, persona, args.steps)
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
