# Agent connections: A2U, MCP and A2A

The data agent can be reached three ways. All three run the **same** guarded,
read-only pipeline, so an answer is equally correct whichever way it was asked.

| | **A2U**: agent → user | **MCP**: agent uses our tools | **A2A**: agent ↔ agent |
|---|---|---|---|
| Who starts | A person types in the chat | Another agent's model calls our functions | A person's own agent sends our agent a message |
| Who reasons | Our agent | The caller picks the tool; we execute | Both: the caller delegates a task, our agent plans it |
| What goes in | A chat message | A tool call: `ask_data(question)`, `match_profile(profile)` | A message with text and optional data parts |
| What comes out | Tables, charts, text (OpenUI) | JSON: answer, query, rows, next questions | A Task with artifacts (text + structured data) |
| Endpoint | `POST /api/chat` | `mcp_server/server.py` → `/api/agent/*` | `GET /.well-known/agent-card.json`, `POST /a2a` |
| Example client | The web app | Claude Desktop, Claude Code, any MCP client | `scripts/a2a_demo.py`, any A2A client |
| Best for | Analysts exploring data | Plugging our data into someone else's assistant | Personal agents asking for insights on a person's behalf |

```text
A2U   Person ─► Chat UI ─────────────────────────────┐
MCP   Other agent's LLM ─► MCP server ─► /api/agent/* ├─► Shared pipeline ─► MongoDB
A2A   Personal agent ─► Agent Card ─► /a2a (skills) ──┘
      Shared pipeline = guardrails → API-key auth + project scope → question → MongoDB query
                        → validator (read-only allowlist) → run → PII masked → answer + query + rows
```

**MCP or A2A?** With MCP, the other agent treats us as a toolbox and must know
which tool to call. With A2A, it just says what it needs ("large payroll
prospects in India") and our agent decides how. Ship MCP first, since most
assistants support it today. A2A is the peer-to-peer step on top.

## Try it live (Admin → Agent connections)

- **Status lights** on each box: green = ready (MongoDB connected, model key set, MCP server loaded, Agent Card served).
- **Click a box, ask a question, press Run.** Each step shows as a signal: green = done, blue spinner = running, red = failed with the reason.
  - A2U: `user → agent` → `agent → user`, plus the answer and a button to open it in the full chat.
  - MCP: `initialize` → `tools/list` → `tools/call <tool>`, a real MCP session run inside the app with your login.
  - A2A: `discover` (Agent Card) → `message/send` → `task completed`, with the result artifact.
- **Personal agent → our agent:** pick a person (or describe your own) and run it. You see every tool call it made,
  the insights it brought back, the data gaps it reported and the judge's scores. This is the scenario: a personal
  agent that knows a person's needs talks to our agent, which knows the data.

## What was added

| Piece | File |
|---|---|
| Agent JSON API (`/api/agent/manifest, datasets, ask, opportunities, profile-options, match`) | `backend/agent_api.py` |
| A2A Agent Card and JSON-RPC endpoint (`message/send`, `tasks/get`) | `backend/a2a.py` |
| MCP server (5 tools, 1 resource, 1 prompt; stdio or HTTP) | `mcp_server/server.py` |
| Query log of every agent call (channel, agent, persona, tool, outcome, latency) | `agent_query_log` collection |
| Admin page **Agent connections** (the three channels, what agents ask, data gaps, call log) | `openui_test/src/components/tools/agent-connections-page.tsx` |
| Persona test: 6 simulated personal agents over MCP, scored by a judge model | `scripts/agent_persona_test.py` |
| Accuracy check: agent answers vs. numbers computed straight from MongoDB | `scripts/agent_accuracy_check.py` |
| A2A demo client | `scripts/a2a_demo.py` |
| Tests (14) | `tests/test_agent_api.py` |
| Flat single-colour theme | `openui_test/src/app/solid.css` |

## Run it

```powershell
pip install -r requirements-mcp.txt          # adds the MCP SDK
.\start.ps1                                   # or start the backend and frontend as usual
```

Create a personal API key in **Settings → API keys** and set it for the scripts:

```powershell
$env:QC_API_KEY = "qc-..."
python -m scripts.a2a_demo                    # A2A: discover the agent card, send messages
python -m scripts.agent_persona_test          # MCP: 6 persona agents (uses OpenRouter credits)
python -m scripts.agent_accuracy_check        # answers vs. the database, exits 1 on any mismatch
```

Then open **Admin → Agent connections** to see what the agents asked.

### Connect Claude Desktop (MCP)

`%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "queryable-data": {
      "command": "C:\\path\\to\\queryable_chatbot\\.venv\\Scripts\\python.exe",
      "args": ["-m", "mcp_server.server"],
      "cwd": "C:\\path\\to\\queryable_chatbot",
      "env": { "QC_API_KEY": "qc-...", "QC_API_URL": "http://127.0.0.1:8000" }
    }
  }
}
```

Remote agents use Streamable HTTP instead: `python -m mcp_server.server --http --port 8765` → `http://<host>:8765/mcp`.

### Call A2A by hand

```bash
curl http://127.0.0.1:8000/.well-known/agent-card.json
curl -X POST http://127.0.0.1:8000/a2a -H "Authorization: Bearer qc-..." -H "Content-Type: application/json" -d '{
  "jsonrpc": "2.0", "id": 1, "method": "message/send",
  "params": {"message": {"role": "user", "parts": [
    {"kind": "text", "text": "Large accounts in India"},
    {"kind": "data", "data": {"skill": "match_profile", "profile": {"countries": ["India"], "sizes": ["large"]}}}]}}}'
```

## Results from the first test run (24 Nov 2026, project datasets)

**Accuracy:** 8/8 answers matched numbers computed directly from MongoDB
(counts, averages, attrition rates, maximums).

**Persona agents over MCP** (judge scores 1–5):

| Persona | Relevance | Grounding | Actionability | Notes |
|---|---|---|---|---|
| HR director (attrition) | 5 | 5 | 4 | Sales Representatives 39.8% attrition, Sales dept 20.6% |
| HR-tech analyst | 4 | 5 | 4 | Professional Services leads spend at $311,987 average |
| EOR partnerships lead | 4 | 3 | 3 | 75 international accounts, 102 fast-growth |
| Fintech compliance consultant | 3 | 4 | 3 | 46 licensed institutions, 66 in the USA |
| Payroll sales head (India) | 3 | 3 | 3 | Did not filter to India: should have used `match_profile` |
| E-commerce ops | 1 | 1 | 1 | The e-commerce tables were not in that run; the agent correctly said so. Re-run on the full database. |

**What we learned**

1. Agents ask *ranking* and *aggregation* questions most ("top industries by spend", "attrition by department").
2. Agents under-use `match_profile`, our most person-specific tool. Next: sharpen its description, or route "target list" requests to it.
3. Agents report gaps we can fill: payroll-provider / competitor field, contract renewal dates, fintech-specific licence types.
4. Data quality shows up immediately: country names are stored in two spellings ("India" / "INDIA"), which splits counts.
5. Fixed during testing: the dataset list was too big for an agent's context (it only saw one dataset), and the login audit log (`security_log`) was queryable as a dataset. It is now internal.
