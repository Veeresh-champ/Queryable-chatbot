"use client";

import { useMemo, useState } from "react";
import { ArrowRight, Bot, Cable, MessagesSquare, RefreshCw, ShieldCheck, Users, Workflow } from "lucide-react";

import { PersonalAgent, TryA2A, TryA2U, TryMCP, type Persona } from "@/components/tools/agent-live";
import { LoadState, ToolPage, useApi, useAsk } from "@/components/tools/shared";

/** Agent connections (GET /api/admin/agent-queries): the three ways in, side by side, and what agents ask. */

type Count = { key: string; count: number };
type Entry = {
  ts: string;
  channel?: string;
  agent: string;
  persona?: string | null;
  tool: string;
  status: string;
  latency_ms: number;
  row_count?: number;
  intent?: string | null;
  missing_field?: string | null;
  input?: { question?: string } & Record<string, unknown>;
};
type Summary = {
  days: number;
  total: number;
  agents: number;
  channels: Record<"a2u" | "mcp" | "a2a" | "api", number>;
  answered_rate: number | null;
  p50_latency_ms: number | null;
  p90_latency_ms: number | null;
  by_tool: Count[];
  by_status: Count[];
  by_agent: Count[];
  by_intent: Count[];
  topics: Count[];
  data_gaps: Count[];
  recent: Entry[];
};

type ChannelId = "a2u" | "mcp" | "a2a";

type Status = {
  channels: Record<ChannelId, { ok: boolean; detail: string }>;
  model: string | null;
  personal_agent: { ok: boolean; detail: string };
  personas: Persona[];
};

const CHANNELS: {
  id: ChannelId;
  name: string;
  full: string;
  icon: React.ReactNode;
  who: string;
  thinks: string;
  shape: string;
  endpoint: string;
  use: string;
  connect: string;
}[] = [
  {
    id: "a2u",
    name: "A2U",
    full: "Agent → User",
    icon: <Users size={16} />,
    who: "A person types in the chat",
    thinks: "Our agent plans, queries and explains",
    shape: "Conversation; answers rendered as tables and charts",
    endpoint: "POST /api/chat",
    use: "Analysts and sales teams exploring the data themselves.",
    connect: "Open the chat and ask:\n\"Which fintech companies are in India?\"",
  },
  {
    id: "mcp",
    name: "MCP",
    full: "Agent uses our tools",
    icon: <Cable size={16} />,
    who: "Another agent's model calls our functions",
    thinks: "The caller decides which tool and when; we execute",
    shape: "Tool calls in, JSON out (query, rows, evidence)",
    endpoint: "mcp_server → /api/agent/*",
    use: "Claude, ChatGPT or any MCP client plugging our data in as a toolbox.",
    connect:
      '{\n  "mcpServers": {\n    "queryable-data": {\n      "command": "python",\n      "args": ["-m", "mcp_server.server"],\n      "env": { "QC_API_KEY": "qc-..." }\n    }\n  }\n}',
  },
  {
    id: "a2a",
    name: "A2A",
    full: "Agent ↔ Agent",
    icon: <MessagesSquare size={16} />,
    who: "A personal agent sends our agent a message",
    thinks: "Both agents reason: they delegate a task and get a result back",
    shape: "Agent Card discovery, then message → Task with artifacts",
    endpoint: "GET /.well-known/agent-card.json · POST /a2a",
    use: "A person's own agent asking ours for insights on their behalf.",
    connect:
      'POST /a2a\n{ "jsonrpc": "2.0", "id": 1, "method": "message/send",\n  "params": { "message": { "role": "user", "parts": [\n    { "kind": "text", "text": "Payroll prospects in India" } ] } } }',
  },
];

const FLOW: Record<ChannelId, string[]> = {
  a2u: ["Person", "Chat UI", "Our agent", "Shared pipeline", "Answer + charts"],
  mcp: ["Other agent's model", "MCP server (tools)", "/api/agent/*", "Shared pipeline", "JSON result"],
  a2a: ["Personal agent", "Agent Card + /a2a", "Our agent picks a skill", "Shared pipeline", "Task + artifacts"],
};

const STATUS_LABEL: Record<string, string> = {
  answered: "Answered",
  no_data: "No matching data",
  unanswerable: "Data gap",
  general: "General",
  failed: "Failed",
  blocked: "Blocked",
  error: "Error",
  bad_request: "Bad request",
};

const fmt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString());
const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const ms = (n: number | null) => (n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);

/** One readable line for a logged request: the question, or the non-empty filters of a call. */
function describeInput(input: Entry["input"]) {
  if (!input) return "—";
  if (typeof input.question === "string") return input.question;
  const parts: string[] = [];
  const add = (label: string, value: unknown) => {
    if (Array.isArray(value) ? value.length : value !== null && value !== undefined && value !== "") {
      parts.push(`${label}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
    }
  };
  const profile = (input.profile ?? {}) as Record<string, unknown>;
  for (const key of ["industries", "countries", "sizes", "revenues", "growth"]) add(key, profile[key]);
  for (const key of ["use_case", "dataset", "project"]) add(key.replace("_", " "), input[key]);
  return parts.length ? parts.join(" · ") : "All datasets";
}

function when(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function Bars({ title, items, empty }: { title: string; items: Count[]; empty: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <section className="ac-card">
      <h3 className="ac-card__title">{title}</h3>
      {items.length === 0 ? (
        <p className="qc-muted ac-empty">{empty}</p>
      ) : (
        <ul className="ac-bars">
          {items.map((item) => (
            <li key={item.key}>
              <span className="ac-bars__label">{STATUS_LABEL[item.key] ?? item.key}</span>
              <span className="ac-bars__track">
                <span className="ac-bars__fill" style={{ width: `${(item.count / max) * 100}%` }} />
              </span>
              <span className="ac-bars__value">{item.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AgentConnectionsPage() {
  const [days, setDays] = useState(30);
  const [channel, setChannel] = useState<ChannelId | "all">("all");
  const [open, setOpen] = useState<ChannelId>("a2a");
  const { data, error, loading, reload } = useApi<Summary>(`/api/admin/agent-queries?days=${days}&limit=200`);
  const status = useApi<Status>("/api/agent/playground/status");
  const ask = useAsk();

  const recent = useMemo(
    () => (data?.recent ?? []).filter((e) => channel === "all" || (e.channel ?? "api") === channel),
    [data, channel],
  );
  const active = CHANNELS.find((c) => c.id === open)!;

  return (
    <ToolPage
      icon={<Workflow size={13} />}
      eyebrow="Agent connections · Admin"
      title="Three ways into the data agent"
      description="People chat with it (A2U), other agents use its tools (MCP), and personal agents talk to it as a peer (A2A). Pick a box, run it live and watch each step. All three use the same guarded, read-only pipeline."
      actions={
        <div className="ac-actions">
          <select className="ac-select" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button type="button" className="qc-icon-button" onClick={() => { reload(); status.reload(); }} aria-label="Refresh" title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>
      }
    >
      {/* ---------------------------------------------------------- the three channels */}
      <section className="ac-lanes" aria-label="Connection types">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            type="button"
            className="ac-lane"
            data-active={open === c.id}
            onClick={() => setOpen(c.id)}
            aria-pressed={open === c.id}
          >
            <span className="ac-lane__head">
              <span className="ac-lane__icon">{c.icon}</span>
              <span>
                <span className="ac-lane__name">{c.name}</span>
                <span className="ac-lane__full">{c.full}</span>
              </span>
              <span
                className="ac-light"
                data-state={!status.data ? "unknown" : status.data.channels[c.id]?.ok ? "ok" : "error"}
                title={status.data?.channels[c.id]?.detail ?? "Checking…"}
                aria-label={status.data?.channels[c.id]?.ok ? "Ready" : "Not ready"}
              />
              <span className="ac-lane__count" title={`Calls in the last ${days} days`}>
                {data ? fmt(data.channels?.[c.id]) : "·"}
              </span>
            </span>
            <span className="ac-lane__status">{status.data?.channels[c.id]?.detail ?? "Checking status…"}</span>
            <dl className="ac-lane__facts">
              <div><dt>Who starts</dt><dd>{c.who}</dd></div>
              <div><dt>Who reasons</dt><dd>{c.thinks}</dd></div>
              <div><dt>Shape</dt><dd>{c.shape}</dd></div>
              <div><dt>Endpoint</dt><dd><code>{c.endpoint}</code></dd></div>
            </dl>
          </button>
        ))}
      </section>

      <section className="ac-card ac-flow-card">
        <header className="ac-flow-card__head">
          <h3 className="ac-card__title">How {active.name} works</h3>
          <span className="qc-muted">{active.use}</span>
        </header>
        <ol className="ac-flow">
          {FLOW[open].map((step, i) => (
            <li key={step} className="ac-flow__step" data-shared={step === "Shared pipeline"}>
              <span className="ac-flow__n">{i + 1}</span>
              {step}
              {i < FLOW[open].length - 1 && <ArrowRight size={14} className="ac-flow__arrow" aria-hidden="true" />}
            </li>
          ))}
        </ol>
        <div className="ac-pipeline">
          <ShieldCheck size={14} />
          <span>
            <strong>Shared pipeline:</strong> guardrails → project scope and API-key auth → question to MongoDB query →
            validator (read-only allowlist) → MongoDB → PII masked → answer with the exact query and rows
          </span>
        </div>
        <div className="ac-live">
          <span className="ac-card__title">Try {active.name} live</span>
          {open === "a2u" && <TryA2U onDone={reload} openInChat={ask} />}
          {open === "mcp" && <TryMCP onDone={reload} />}
          {open === "a2a" && <TryA2A onDone={reload} />}
        </div>
        <details className="ac-connect">
          <summary className="ac-card__title">How an outside agent connects</summary>
          <pre className="ac-code">{active.connect}</pre>
        </details>
      </section>

      {status.data && (
        <PersonalAgent personas={status.data.personas} ready={status.data.personal_agent.ok} onDone={reload} />
      )}

      <LoadState loading={loading && !data} error={error} onRetry={reload} />

      {data && (
        <>
          {/* ------------------------------------------------------ what agents ask */}
          <h2 className="qc-section-title"><Bot size={15} /> What agents ask</h2>
          <section className="ac-kpis">
            <article className="ac-kpi"><span>Agent calls</span><strong>{fmt(data.total)}</strong><small>MCP + A2A + API</small></article>
            <article className="ac-kpi"><span>Distinct agents</span><strong>{fmt(data.agents)}</strong><small>by X-Agent-Name</small></article>
            <article className="ac-kpi"><span>Answered</span><strong>{pct(data.answered_rate)}</strong><small>returned data</small></article>
            <article className="ac-kpi"><span>Latency p50 / p90</span><strong>{ms(data.p50_latency_ms)}</strong><small>p90 {ms(data.p90_latency_ms)}</small></article>
          </section>

          <div className="ac-grid">
            <Bars title="Tools called" items={data.by_tool} empty="No calls yet." />
            <Bars title="Question types" items={data.by_intent} empty="No data questions yet." />
            <Bars title="Outcome" items={data.by_status} empty="No calls yet." />
            <Bars title="Recurring topics" items={data.topics} empty="No questions yet." />
            <Bars title="Data gaps (asked, not in data)" items={data.data_gaps} empty="No gaps found yet." />
            <Bars title="Agents" items={data.by_agent} empty="No agents yet." />
          </div>

          {/* ------------------------------------------------------ the log */}
          <section className="ac-card ac-log">
            <header className="ac-log__head">
              <h3 className="ac-card__title">Recent agent calls</h3>
              <div className="ac-chips" role="group" aria-label="Filter by channel">
                {(["all", "mcp", "a2a"] as const).map((id) => (
                  <button key={id} type="button" className="ac-chip" aria-pressed={channel === id} onClick={() => setChannel(id)}>
                    {id === "all" ? "All" : id.toUpperCase()}
                  </button>
                ))}
              </div>
            </header>
            {recent.length === 0 ? (
              <p className="qc-muted ac-empty">
                No agent calls yet. Run <code>python -m scripts.a2a_demo</code> or{" "}
                <code>python -m scripts.agent_persona_test</code>, or connect an MCP client.
              </p>
            ) : (
              <div className="qc-table-wrap">
                <table className="ac-table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Channel</th>
                      <th>Agent</th>
                      <th>Tool</th>
                      <th>Request</th>
                      <th>Outcome</th>
                      <th className="is-num">Rows</th>
                      <th className="is-num">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((e, i) => (
                      <tr key={`${e.ts}-${i}`}>
                        <td className="ac-nowrap">{when(e.ts)}</td>
                        <td><span className="ac-badge" data-channel={e.channel ?? "api"}>{(e.channel ?? "api").toUpperCase()}</span></td>
                        <td title={e.persona ?? undefined}>{e.agent}</td>
                        <td><code>{e.tool}</code></td>
                        <td className="ac-request">
                          {describeInput(e.input)}
                          {e.persona && <small className="qc-muted">for: {e.persona}</small>}
                        </td>
                        <td>
                          <span className="ac-status" data-status={e.status}>{STATUS_LABEL[e.status] ?? e.status}</span>
                          {e.missing_field && <small className="qc-muted"> missing: {e.missing_field}</small>}
                        </td>
                        <td className="is-num">{fmt(e.row_count)}</td>
                        <td className="is-num">{ms(e.latency_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </ToolPage>
  );
}
