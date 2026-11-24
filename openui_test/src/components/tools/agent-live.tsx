"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Loader2, Play, UserRound, XCircle } from "lucide-react";

import { authFetch, errorMessage } from "@/lib/api";

/** Live, runnable versions of each channel for the Agent connections page. */

export type Signal = { step: string; detail: string; ok: boolean | null; ms?: number | null };
export type Persona = { id: string; person: string; goal: string };

type Json = Record<string, unknown>;

async function postJson(url: string, body: unknown): Promise<Json> {
  const response = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorMessage(response, `Request failed (${response.status}).`));
  return (await response.json()) as Json;
}

/* ----------------------------------------------------------------- signals */

export function Signals({ items }: { items: Signal[] }) {
  if (!items.length) return null;
  return (
    <ol className="ac-signals" aria-label="Steps">
      {items.map((s, i) => (
        <li key={`${s.step}-${i}`} className="ac-signal" data-state={s.ok === null ? "running" : s.ok ? "ok" : "error"}>
          <span className="ac-signal__icon" aria-hidden="true">
            {s.ok === null ? <Loader2 size={14} className="ac-spin" /> : s.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          </span>
          <span className="ac-signal__step">{s.step}</span>
          <span className="ac-signal__detail">{s.detail}</span>
          {s.ms != null && <span className="ac-signal__ms">{s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)} s` : `${s.ms} ms`}</span>}
        </li>
      ))}
    </ol>
  );
}

/* ----------------------------------------------------------------- answers */

/** Plain text with markdown tables (what the agent writes) rendered as real tables. */
export function AnswerText({ text }: { text: string }) {
  const blocks: { table?: string[][]; text?: string }[] = [];
  let buffer: string[] = [];
  let table: string[][] = [];
  const flushText = () => {
    if (buffer.join("").trim()) blocks.push({ text: buffer.join("\n").trim() });
    buffer = [];
  };
  const flushTable = () => {
    if (table.length) blocks.push({ table });
    table = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushText();
      if (/^\|[\s:|-]+\|$/.test(trimmed)) continue; // separator row
      table.push(trimmed.slice(1, -1).split("|").map((c) => c.trim()));
    } else {
      flushTable();
      buffer.push(line);
    }
  }
  flushText();
  flushTable();
  return (
    <div className="ac-answer">
      {blocks.map((b, i) =>
        b.table ? (
          <div key={i} className="qc-table-wrap">
            <table className="ac-table ac-table--compact">
              <thead>
                <tr>{b.table[0].map((c, j) => <th key={j}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {b.table.slice(1).map((row, r) => (
                  <tr key={r}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p key={i}>{b.text!.replace(/\*\*/g, "")}</p>
        ),
      )}
    </div>
  );
}

function RowsTable({ rows, limit = 10 }: { rows: Json[]; limit?: number }) {
  const shown = rows.slice(0, limit);
  const keys = Array.from(new Set(shown.flatMap((r) => Object.keys(r)))).slice(0, 8);
  if (!shown.length) return <p className="qc-muted ac-empty">No rows.</p>;
  const cell = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <div className="qc-table-wrap">
      <table className="ac-table ac-table--compact">
        <thead>
          <tr>{keys.map((k) => <th key={k}>{k}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>{keys.map((k) => <td key={k}>{cell(r[k])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && <p className="qc-muted ac-note">Showing {limit} of {rows.length} rows.</p>}
    </div>
  );
}

/** Renders whatever a tool / skill returned: answer, rows, accounts, use cases or datasets. */
export function ResultView({ data, onAsk }: { data: Json; onAsk?: (q: string) => void }) {
  const status = data.status as string | undefined;
  const answer = data.answer as string | undefined;
  const rows = data.rows as Json[] | undefined;
  const accounts = data.accounts as Json[] | undefined;
  const useCases = data.use_cases as Json[] | undefined;
  const datasets = data.datasets as Json[] | undefined;
  const next = data.suggested_next_questions as string[] | undefined;
  return (
    <div className="ac-result">
      {status && (
        <p className="ac-result__meta">
          <span className="ac-status" data-status={status}>{status.replace("_", " ")}</span>
          {typeof data.row_count === "number" && <span className="qc-muted"> · {data.row_count} rows</span>}
          {Array.isArray(data.collections) && data.collections.length > 0 && (
            <span className="qc-muted"> · from {(data.collections as string[]).join(", ")}</span>
          )}
        </p>
      )}
      {answer && <AnswerText text={answer} />}
      {data.missing_field ? <p className="qc-muted">Data gap: the data has no field for {String(data.missing_field)}.</p> : null}
      {rows && rows.length > 0 && !answer?.includes("|") && <RowsTable rows={rows} />}
      {accounts && (
        <>
          {Array.isArray(data.funnel) && (
            <p className="ac-funnel">
              {(data.funnel as { step: string; count: number }[]).map((f) => `${f.step} ${f.count}`).join("  →  ")}
            </p>
          )}
          <RowsTable
            rows={accounts.map((a) => ({
              name: a.name, country: a.country, dataset: a.dataset_label, size: a.size_band, score: a.score,
              evidence: ((a.evidence as Json[]) ?? []).map((e) => `${e.label}: ${e.value}`).join("; "),
            }))}
          />
        </>
      )}
      {useCases && (
        <ul className="ac-usecases">
          {useCases.map((c) => (
            <li key={String(c.title)}>
              <strong>{String(c.title)}</strong>{" "}
              <span className="ac-status" data-status={c.status === "ready" ? "answered" : "no_data"}>{String(c.status).replace("_", " ")}</span>
              <span className="qc-muted"> · {String(c.accounts ?? 0)} accounts</span>
              {c.action ? <small className="qc-muted">{String(c.action)}</small> : null}
            </li>
          ))}
        </ul>
      )}
      {datasets && (
        <RowsTable rows={datasets.map((d) => ({ name: d.name, kind: d.kind, documents: d.documents, fields: d.field_count }))} limit={20} />
      )}
      {Array.isArray(data.industries) && (
        <p className="qc-muted">
          Industries: {(data.industries as string[]).slice(0, 12).join(", ")} · Countries:{" "}
          {((data.countries as { name: string }[]) ?? []).slice(0, 12).map((c) => c.name).join(", ")}
        </p>
      )}
      {data.query ? (
        <details className="ac-query">
          <summary>Query that ran (read-only)</summary>
          <pre className="ac-code">{JSON.stringify(data.query, null, 2)}</pre>
        </details>
      ) : null}
      {next && next.length > 0 && onAsk && (
        <div className="ac-next">
          <span className="qc-muted">Ask next:</span>
          {next.map((q) => (
            <button key={q} type="button" className="ac-chip" onClick={() => onAsk(q)}>{q}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- shared form bits */

const EXAMPLES = [
  "Which fintech companies are licensed?",
  "What is the average annual HR tech spend by deployment type?",
  "Which departments have the highest attrition rate?",
  "Which 5 countries have the most companies using Deel?",
];

function QuestionBox({ value, onChange, onRun, busy, label }: {
  value: string; onChange: (v: string) => void; onRun: () => void; busy: boolean; label: string;
}) {
  return (
    <div className="ac-ask">
      <textarea
        className="ac-input"
        rows={2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && value.trim() && !busy) {
            e.preventDefault();
            onRun();
          }
        }}
        placeholder="Ask a question about the data…"
        aria-label="Question"
      />
      <div className="ac-ask__row">
        <div className="ac-examples">
          {EXAMPLES.map((q) => (
            <button key={q} type="button" className="ac-chip ac-chip--ghost" onClick={() => onChange(q)}>{q}</button>
          ))}
        </div>
        <button type="button" className="qc-primary-button ac-run" onClick={onRun} disabled={busy || !value.trim()}>
          {busy ? <Loader2 size={14} className="ac-spin" /> : <Play size={14} />} {label}
        </button>
      </div>
    </div>
  );
}

function useElapsed(running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const id = window.setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 500);
    return () => {
      window.clearInterval(id);
      setSeconds(0);
    };
  }, [running]);
  return seconds;
}

/* ----------------------------------------------------------------- A2U */

export function TryA2U({ onDone, openInChat }: { onDone: () => void; openInChat: (q: string) => void }) {
  const [question, setQuestion] = useState(EXAMPLES[0]);
  const [busy, setBusy] = useState(false);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [answer, setAnswer] = useState<string | null>(null);

  async function run(q = question) {
    setQuestion(q);
    setBusy(true);
    setAnswer(null);
    const t0 = performance.now();
    setSignals([{ step: "user → agent", detail: "Question sent from the chat to our agent (POST /api/ask).", ok: null }]);
    try {
      const body = await postJson("/api/ask", { question: q });
      const ms = Math.round(performance.now() - t0);
      setSignals([
        { step: "user → agent", detail: "Question received.", ok: true },
        { step: "agent → user", detail: "Our agent planned the query, ran it and wrote the answer.", ok: true, ms },
      ]);
      setAnswer(String(body.answer ?? ""));
    } catch (err) {
      setSignals([{ step: "error", detail: err instanceof Error ? err.message : "Request failed.", ok: false }]);
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className="ac-try">
      <QuestionBox value={question} onChange={setQuestion} onRun={() => run()} busy={busy} label="Ask as a user" />
      <Signals items={signals} />
      {answer !== null && (
        <>
          <AnswerText text={answer} />
          <button type="button" className="ac-chip" onClick={() => openInChat(question)}>Open in the full chat (charts)</button>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- MCP */

const MCP_TOOLS = [
  { id: "ask_data", label: "ask_data: ask a question" },
  { id: "list_datasets", label: "list_datasets: what data exists" },
  { id: "find_opportunities", label: "find_opportunities: business use cases" },
  { id: "profile_options", label: "profile_options: valid filter values" },
  { id: "match_profile", label: "match_profile: accounts that fit a profile" },
];

const SIZES = ["small", "mid", "large", "enterprise"];

function ProfileFields({ countries, setCountries, sizes, setSizes }: {
  countries: string; setCountries: (v: string) => void; sizes: string[]; setSizes: (v: string[]) => void;
}) {
  return (
    <div className="ac-profile">
      <label>
        <span>Countries (comma separated)</span>
        <input className="ac-input" value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="India, United States" />
      </label>
      <div>
        <span>Company size</span>
        <div className="ac-chips">
          {SIZES.map((s) => (
            <button key={s} type="button" className="ac-chip" aria-pressed={sizes.includes(s)}
              onClick={() => setSizes(sizes.includes(s) ? sizes.filter((x) => x !== s) : [...sizes, s])}>
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const list = (text: string) => text.split(",").map((s) => s.trim()).filter(Boolean);

export function TryMCP({ onDone }: { onDone: () => void }) {
  const [tool, setTool] = useState("ask_data");
  const [question, setQuestion] = useState(EXAMPLES[1]);
  const [countries, setCountries] = useState("India");
  const [sizes, setSizes] = useState<string[]>(["large", "enterprise"]);
  const [busy, setBusy] = useState(false);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [result, setResult] = useState<Json | null>(null);

  async function run(q = question) {
    setQuestion(q);
    setBusy(true);
    setResult(null);
    setSignals([{ step: "connect", detail: "Opening an MCP session to our MCP server…", ok: null }]);
    const args: Json =
      tool === "ask_data" ? { question: q } :
      tool === "match_profile" ? { countries: list(countries), sizes, limit: 10 } : {};
    try {
      const body = await postJson("/api/agent/playground/mcp", { tool, arguments: args });
      setSignals((body.signals as Signal[]) ?? []);
      setResult((body.result as Json) ?? null);
    } catch (err) {
      setSignals([{ step: "error", detail: err instanceof Error ? err.message : "Request failed.", ok: false }]);
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className="ac-try">
      <label className="ac-field">
        <span>Tool the other agent calls</span>
        <select className="ac-select" value={tool} onChange={(e) => setTool(e.target.value)}>
          {MCP_TOOLS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      {tool === "ask_data" ? (
        <QuestionBox value={question} onChange={setQuestion} onRun={() => run()} busy={busy} label="Call ask_data" />
      ) : (
        <>
          {tool === "match_profile" && <ProfileFields countries={countries} setCountries={setCountries} sizes={sizes} setSizes={setSizes} />}
          <button type="button" className="qc-primary-button ac-run" onClick={() => run()} disabled={busy}>
            {busy ? <Loader2 size={14} className="ac-spin" /> : <Play size={14} />} Call {tool}
          </button>
        </>
      )}
      <Signals items={signals} />
      {result && <ResultView data={result} onAsk={(q) => { setTool("ask_data"); void run(q); }} />}
    </div>
  );
}

/* ----------------------------------------------------------------- A2A */

export function TryA2A({ onDone }: { onDone: () => void }) {
  const [skill, setSkill] = useState("ask");
  const [question, setQuestion] = useState(EXAMPLES[2]);
  const [countries, setCountries] = useState("India");
  const [sizes, setSizes] = useState<string[]>(["large"]);
  const [busy, setBusy] = useState(false);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [task, setTask] = useState<Json | null>(null);

  async function run(q = question) {
    setQuestion(q);
    setBusy(true);
    setTask(null);
    const steps: Signal[] = [{ step: "discover", detail: "Reading our Agent Card…", ok: null }];
    setSignals([...steps]);
    try {
      const t0 = performance.now();
      const cardRes = await authFetch("/api/a2a/agent-card");
      if (!cardRes.ok) throw new Error("Could not read the Agent Card.");
      const card = (await cardRes.json()) as { name: string; skills: { id: string }[] };
      steps[0] = { step: "discover", detail: `Found "${card.name}" with skills: ${card.skills.map((s) => s.id).join(", ")}.`, ok: true, ms: Math.round(performance.now() - t0) };
      steps.push({ step: "message/send", detail: `Sending a message for skill "${skill}"…`, ok: null });
      setSignals([...steps]);

      const parts: Json[] = [{ kind: "text", text: skill === "ask" ? q : skill === "match_profile" ? "Accounts that fit my profile" : "What opportunities are in the data?" }];
      if (skill !== "ask") {
        parts.push({ kind: "data", data: skill === "match_profile"
          ? { skill, limit: 10, profile: { countries: list(countries), sizes } } : { skill } });
      }
      const t1 = performance.now();
      const rpc = await postJson("/api/a2a", {
        jsonrpc: "2.0", id: Date.now(), method: "message/send",
        params: { message: { role: "user", kind: "message", messageId: crypto.randomUUID(), parts } },
      });
      if (rpc.error) throw new Error(String((rpc.error as Json).message));
      const result = rpc.result as Json;
      const state = String((result.status as Json).state);
      steps[1] = { step: "message/send", detail: `Our agent accepted the task (id ${String(result.id).slice(0, 8)}).`, ok: true };
      steps.push({ step: `task ${state}`, detail: state === "completed" ? "Task finished; the result is attached as an artifact." : String(((result.status as Json).message as Json)?.parts ? (((result.status as Json).message as Json).parts as Json[])[0].text : state), ok: state === "completed", ms: Math.round(performance.now() - t1) });
      setSignals([...steps]);
      setTask(result);
    } catch (err) {
      steps.push({ step: "error", detail: err instanceof Error ? err.message : "Request failed.", ok: false });
      setSignals(steps.map((s) => (s.ok === null ? { ...s, ok: false } : s)));
    } finally {
      setBusy(false);
      onDone();
    }
  }

  const artifact = ((task?.artifacts as Json[]) ?? [])[0];
  const data = ((artifact?.parts as Json[]) ?? []).find((p) => p.kind === "data")?.data as Json | undefined;
  const reply = (((task?.status as Json)?.message as Json)?.parts as Json[] | undefined)?.[0]?.text as string | undefined;

  return (
    <div className="ac-try">
      <label className="ac-field">
        <span>Skill the other agent asks for</span>
        <select className="ac-select" value={skill} onChange={(e) => setSkill(e.target.value)}>
          <option value="ask">ask: answer a data question</option>
          <option value="find_opportunities">find_opportunities: business use cases</option>
          <option value="match_profile">match_profile: accounts that fit a profile</option>
        </select>
      </label>
      {skill === "ask" ? (
        <QuestionBox value={question} onChange={setQuestion} onRun={() => run()} busy={busy} label="Send A2A message" />
      ) : (
        <>
          {skill === "match_profile" && <ProfileFields countries={countries} setCountries={setCountries} sizes={sizes} setSizes={setSizes} />}
          <button type="button" className="qc-primary-button ac-run" onClick={() => run()} disabled={busy}>
            {busy ? <Loader2 size={14} className="ac-spin" /> : <Play size={14} />} Send A2A message
          </button>
        </>
      )}
      <Signals items={signals} />
      {data ? <ResultView data={data} onAsk={(q) => { setSkill("ask"); void run(q); }} /> : reply ? <AnswerText text={reply} /> : null}
    </div>
  );
}

/* ----------------------------------------------------------------- personal agent */

type Call = { tool: string; arguments: Json; ms: number; status?: string | null; summary: string; error?: boolean };
type Run = {
  ok: boolean;
  error?: string;
  persona: Persona;
  calls: Call[];
  result: { insights?: { title: string; detail: string; why_it_matters?: string }[]; data_gaps?: string[]; raw?: string };
  judge: { relevance?: number; grounding?: number; actionability?: number; verdict?: string; missing?: string };
  seconds?: number;
};

const TITLES: Record<string, string> = {
  "payroll-sales-india": "Payroll SaaS sales head (India)",
  "hr-tech-analyst": "HR-tech investment analyst",
  "eor-expansion-us": "EOR partnerships lead",
  "ecommerce-ops": "E-commerce operations manager",
  "hr-director-attrition": "HR director (attrition)",
  "fintech-licensed": "Fintech compliance consultant",
};

export function PersonalAgent({ personas, ready, onDone }: { personas: Persona[]; ready: boolean; onDone: () => void }) {
  const [choice, setChoice] = useState(personas[0]?.id ?? "custom");
  const [person, setPerson] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const elapsed = useElapsed(busy);
  const preset = personas.find((p) => p.id === choice);

  async function start() {
    setBusy(true);
    setRun(null);
    setError(null);
    try {
      const body = (await postJson("/api/agent/playground/personal",
        choice === "custom" ? { person, goal, steps: 5 } : { persona_id: choice, steps: 5 })) as unknown as Run;
      if (!body.ok) setError(body.error ?? "The personal agent failed.");
      setRun(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
      onDone();
    }
  }

  const score = (n?: number) => (typeof n === "number" ? `${n}/5` : "—");

  return (
    <section className="ac-card ac-personal">
      <header className="ac-flow-card__head">
        <h3 className="ac-card__title"><UserRound size={14} /> Personal agent → our agent</h3>
        <span className="qc-muted">A person&apos;s own agent knows their needs, not our data. Watch what it asks and which insights it brings back.</span>
      </header>
      <div className="ac-personal__form">
        <label className="ac-field">
          <span>Who the personal agent works for</span>
          <select className="ac-select" value={choice} onChange={(e) => setChoice(e.target.value)}>
            {personas.map((p) => <option key={p.id} value={p.id}>{TITLES[p.id] ?? p.id}</option>)}
            <option value="custom">Describe your own person…</option>
          </select>
        </label>
        {choice === "custom" ? (
          <>
            <textarea className="ac-input" rows={2} value={person} onChange={(e) => setPerson(e.target.value)}
              placeholder="e.g. Founder of a payroll startup selling to fintech companies in India and Singapore" />
            <input className="ac-input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Goal, e.g. find 20 target accounts" />
          </>
        ) : (
          preset && <p className="ac-persona"><strong>Person:</strong> {preset.person}<br /><strong>Goal:</strong> {preset.goal}</p>
        )}
        <button type="button" className="qc-primary-button ac-run" onClick={start}
          disabled={busy || !ready || (choice === "custom" && !person.trim())}>
          {busy ? <Loader2 size={14} className="ac-spin" /> : <Play size={14} />}
          {busy ? `Agents are talking… ${elapsed}s` : "Run personal agent"}
        </button>
        {!ready && <p className="qc-muted">The personal agent needs a model: set OPENROUTER_API_KEY in .env.</p>}
      </div>

      {busy && (
        <Signals items={[
          { step: "connect", detail: "Personal agent opened an MCP session to our agent.", ok: true },
          { step: "thinking", detail: "It is choosing tools and asking questions for its person (usually 20–60 s).", ok: null },
        ]} />
      )}
      {error && <Signals items={[{ step: "error", detail: error, ok: false }]} />}

      {run && run.calls.length > 0 && (
        <>
          <h4 className="ac-subtitle">What the personal agent asked our agent</h4>
          <Signals items={run.calls.map((c) => ({
            step: c.tool,
            detail: `${typeof c.arguments.question === "string" ? `“${c.arguments.question}” → ` : ""}${c.summary}`,
            ok: !c.error, ms: c.ms,
          }))} />
        </>
      )}

      {run?.ok && (
        <>
          <h4 className="ac-subtitle">Insights it brought back for its person</h4>
          {(run.result.insights ?? []).length === 0 ? (
            <p className="qc-muted">{run.result.raw ? run.result.raw : "No insights: the data did not cover this person's needs."}</p>
          ) : (
            <div className="ac-insights">
              {(run.result.insights ?? []).map((i) => (
                <article key={i.title} className="ac-insight">
                  <strong>{i.title}</strong>
                  <p>{i.detail}</p>
                  {i.why_it_matters && <small className="qc-muted">Why it matters: {i.why_it_matters}</small>}
                </article>
              ))}
            </div>
          )}
          {(run.result.data_gaps ?? []).length > 0 && (
            <>
              <h4 className="ac-subtitle">Data gaps it reported</h4>
              <ul className="ac-gaps">{(run.result.data_gaps ?? []).map((g) => <li key={g}><CircleDashed size={13} /> {g}</li>)}</ul>
            </>
          )}
          <div className="ac-judge">
            <span>Relevance <strong>{score(run.judge.relevance)}</strong></span>
            <span>Grounding <strong>{score(run.judge.grounding)}</strong></span>
            <span>Actionability <strong>{score(run.judge.actionability)}</strong></span>
            {run.seconds != null && <span>Time <strong>{run.seconds}s</strong></span>}
          </div>
          {run.judge.verdict && <p className="qc-muted ac-note">Judge: {run.judge.verdict}{run.judge.missing ? ` Missing: ${run.judge.missing}` : ""}</p>}
        </>
      )}
    </section>
  );
}
