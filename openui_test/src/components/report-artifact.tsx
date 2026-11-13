"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { artifactViewId, useArtifactList } from "@openuidev/react-headless";
import { defineArtifactRenderer, useDetailedView } from "@openuidev/react-ui";
import { ArrowDownUp, Check, ChevronRight, ClipboardCopy, Code2, Download, FileBarChart, FileText, Globe2, Lightbulb, Search, Table2 } from "lucide-react";

import { InsightCards } from "@/components/analysis-renderers";
import { CountUp } from "@/components/lab/shared";
import { VisualAnalysisView, type VisualAnalysis } from "@/components/lab/answer-charts";
import { WorldMap } from "@/components/world-map";
import { parseJSON, type GeoPayload, type InsightsPayload } from "@/lib/geo";
import { csvCell } from "@/lib/csv";

/**
 * Claude-style report artifacts (backend/report_artifact.py).
 *
 * Every data answer ends with an artifact card. The artifact is one *topic*
 * (the dataset asked about): follow-up questions on the same dataset in the
 * same chat add versions (v1, v2, …) to the same artifact instead of new
 * cards, and the side panel can step through them. A card that arrives live
 * opens the panel by itself; cards in an old chat stay closed until clicked.
 */

type Finding = { kind: string; title: string; value: string; detail: string };
type Column = { key: string; label: string };
export type Report = {
  artifact_id: string;
  version: number;
  topic: string;
  collection: string;
  project: string | null;
  heading: string;
  title: string;
  question: string;
  created_at: string;
  kpis: { label: string; value: number }[];
  findings: Finding[];
  visual: VisualAnalysis | null;
  insights: InsightsPayload | null;
  geo: GeoPayload | null;
  table: { columns: Column[]; rows: Record<string, unknown>[] };
  total_rows: number;
  truncated: boolean;
  query: unknown;
  history: { version: number; title: string; created_at: string }[];
  /** Present when opened from the Artifacts library: every stored version. */
  versions?: Report[];
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function cell(value: unknown) {
  if (value == null) return "";
  if (typeof value === "number") return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

// ---------------------------------------------------------------- exports

function save(name: string, body: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function fileName(report: Report, ext: string) {
  return `${report.topic}-v${report.version}`.replace(/[^\w-]+/g, "-").toLowerCase() + `.${ext}`;
}

function toCsv(report: Report) {
  const esc = (v: unknown) => csvCell(typeof v === "number" ? v : cell(v));
  return [report.table.columns.map((c) => esc(c.label)).join(","),
    ...report.table.rows.map((r) => report.table.columns.map((c) => esc(r[c.key])).join(","))].join("\n");
}

function toMarkdown(report: Report) {
  const lines = [`# ${report.title}`, "", `*${report.topic} · version ${report.version} · ${when(report.created_at)}*`, "",
    `**Question:** ${report.question}`, ""];
  if (report.kpis.length) lines.push(...report.kpis.map((k) => `- **${k.label}:** ${cell(k.value)}`), "");
  if (report.findings.length) lines.push("## Findings", ...report.findings.map((f) => `- **${f.title}** ${f.value} — ${f.detail}`), "");
  const cols = report.table.columns;
  if (cols.length) {
    lines.push("## Data", `| ${cols.map((c) => c.label).join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`,
      ...report.table.rows.slice(0, 50).map((r) => `| ${cols.map((c) => cell(r[c.key]).replace(/\|/g, "/")).join(" | ")} |`), "");
    if (report.table.rows.length > 50) lines.push(`*${report.table.rows.length - 50} more rows in the CSV download.*`, "");
  }
  lines.push("## Query", "```json", JSON.stringify(report.query, null, 2), "```");
  return lines.join("\n");
}

function toHtml(report: Report) {
  const esc = (v: unknown) => cell(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cols = report.table.columns;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(report.title)}</title><style>
body{font:14px/1.5 system-ui,sans-serif;margin:32px auto;max-width:960px;padding:0 16px;color:#12152b;background:#fff}
h1{font-size:22px;margin:0}.meta{color:#666;margin:4px 0 20px}.kpis{display:flex;gap:12px;flex-wrap:wrap}
.kpi{border:1px solid #ddd;border-radius:12px;padding:10px 14px}.kpi b{display:block;font-size:20px}
table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:8px}th,td{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}
th{color:#555}pre{background:#f5f6fb;padding:12px;border-radius:8px;overflow:auto}
</style></head><body><h1>${esc(report.title)}</h1>
<p class="meta">${esc(report.topic)} · version ${report.version} · ${esc(when(report.created_at))} · question: ${esc(report.question)}</p>
<div class="kpis">${report.kpis.map((k) => `<div class="kpi">${esc(k.label)}<b>${esc(k.value)}</b></div>`).join("")}</div>
${report.findings.length ? `<h2>Findings</h2><ul>${report.findings.map((f) => `<li><b>${esc(f.title)}</b> ${esc(f.value)} — ${esc(f.detail)}</li>`).join("")}</ul>` : ""}
<h2>Data (${report.total_rows} rows)</h2><table><thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead>
<tbody>${report.table.rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c.key])}</td>`).join("")}</tr>`).join("")}</tbody></table>
<h2>Query</h2><pre>${esc(JSON.stringify(report.query, null, 2))}</pre></body></html>`;
}

// ---------------------------------------------------------------- card (inline in the chat)

/** Artifact versions already auto-opened in this tab (so re-renders don't reopen them). */
const AUTO_OPENED = new Set<string>();

function ReportCard({ report, isActive, isStreaming, open, toggle }: {
  report: Report | null;
  isActive: boolean;
  isStreaming: boolean;
  open: () => void;
  toggle: () => void;
}) {
  // Open the panel once for an answer that arrives live (it streamed, or was
  // created moments ago); never for cards in an old conversation.
  const sawStreaming = useRef(false);
  useEffect(() => {
    if (isStreaming) {
      sawStreaming.current = true;
      return;
    }
    if (!report) return;
    const key = `${report.artifact_id}:${report.version}`;
    const fresh = Date.now() - new Date(report.created_at).getTime() < 90_000;
    if ((sawStreaming.current || fresh) && !AUTO_OPENED.has(key)) {
      AUTO_OPENED.add(key);
      open();
    }
  }, [isStreaming, report, open]);

  if (!report) {
    return (
      <div className="qc-artifact-chip is-loading">
        <span className="qc-artifact-chip__icon"><FileText size={18} /></span>
        <span><strong>Building the report…</strong></span>
      </div>
    );
  }
  return (
    <button type="button" className="qc-artifact-chip" data-active={isActive} onClick={toggle} aria-pressed={isActive}>
      <span className="qc-artifact-chip__icon"><FileBarChart size={18} /></span>
      <span className="qc-artifact-chip__text">
        <strong>{report.heading}</strong>
        <span>
          {report.version > 1 ? `Updated to version ${report.version}` : "Version 1"} · {report.title}
        </span>
      </span>
      <span className="qc-artifact-chip__open">{isActive ? "Close" : "Open"} <ChevronRight size={14} /></span>
    </button>
  );
}

// ---------------------------------------------------------------- panel

function VersionTab({ id, version, current, title }: { id: string; version: number; current: boolean; title: string }) {
  const { open } = useDetailedView(artifactViewId(id, version));
  return (
    <button type="button" role="tab" aria-selected={current} className={current ? "is-active" : ""} onClick={open} title={title}>
      v{version}
    </button>
  );
}

function DataTable({ report }: { report: Report }) {
  const [needle, setNeedle] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    const q = needle.trim().toLowerCase();
    let list = q ? report.table.rows.filter((r) => Object.values(r).some((v) => cell(v).toLowerCase().includes(q))) : report.table.rows;
    if (sort) {
      list = [...list].sort((a, b) => {
        const x = a[sort.key];
        const y = b[sort.key];
        if (typeof x === "number" && typeof y === "number") return (x - y) * sort.dir;
        return cell(x).localeCompare(cell(y)) * sort.dir;
      });
    }
    return list;
  }, [report, needle, sort]);
  return (
    <section className="qc-report__section">
      <header className="qc-report__section-head">
        <h3><Table2 size={15} /> Data <span className="qc-muted">· {report.total_rows.toLocaleString()} row{report.total_rows === 1 ? "" : "s"}{report.truncated ? `, first ${report.table.rows.length} shown` : ""}</span></h3>
        {report.table.rows.length > 6 && (
          <label className="qc-report__search">
            <Search size={13} />
            <input value={needle} onChange={(e) => setNeedle(e.target.value)} placeholder="Filter rows…" aria-label="Filter rows" />
          </label>
        )}
      </header>
      <div className="qc-report__table">
        <table>
          <thead>
            <tr>
              {report.table.columns.map((c) => (
                <th key={c.key} scope="col">
                  <button type="button" onClick={() => setSort(sort?.key === c.key ? { key: c.key, dir: sort.dir === 1 ? -1 : 1 } : { key: c.key, dir: -1 })}>
                    {c.label} <ArrowDownUp size={11} aria-hidden="true" />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{report.table.columns.map((c) => <td key={c.key}>{cell(r[c.key])}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReportBody({ report }: { report: Report }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="qc-report__actions">
        <button type="button" className="qc-ghost-button" onClick={() => {
          void navigator.clipboard?.writeText(toMarkdown(report)).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}>
          {copied ? <Check size={13} /> : <ClipboardCopy size={13} />} {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="qc-ghost-button" onClick={() => save(fileName(report, "csv"), toCsv(report), "text/csv")}>
          <Download size={13} /> CSV
        </button>
        <button type="button" className="qc-ghost-button" onClick={() => save(fileName(report, "html"), toHtml(report), "text/html")}>
          <Download size={13} /> Report
        </button>
      </div>

      <p className="qc-report__question"><b>Question</b> {report.question}</p>

      <section className="viz-stats" aria-label="Key numbers">
        {report.kpis.map((k, i) => (
          <article key={k.label} className="viz-stat" style={{ animationDelay: `${i * 70}ms`, ["--stat" as string]: `var(--viz-series-${(i % 4) + 1})` }}>
            <span className="viz-stat__label">{k.label}</span>
            <span className="viz-stat__value"><CountUp value={k.value} format="number" start /></span>
          </article>
        ))}
      </section>

      {report.findings.length > 0 && !report.visual && !report.insights && (
        <section className="qc-report__section">
          <h3><Lightbulb size={15} /> Findings</h3>
          <ul className="qc-report__findings">
            {report.findings.map((f) => <li key={f.title}><b>{f.title}</b> {f.value} <span className="qc-muted">{f.detail}</span></li>)}
          </ul>
        </section>
      )}
      {report.visual && <VisualAnalysisView data={report.visual} />}
      {!report.visual && report.insights && <InsightCards data={report.insights} />}
      {report.geo && (
        <section className="qc-report__section">
          <h3><Globe2 size={15} /> Where</h3>
          <WorldMap places={report.geo.places} metric={report.geo.metric} />
        </section>
      )}
      {report.table.columns.length > 0 && <DataTable report={report} />}
      <details className="qc-report__query">
        <summary><Code2 size={13} /> The query behind this report</summary>
        <pre>{JSON.stringify(report.query, null, 2)}</pre>
      </details>
    </>
  );
}

function ReportPanel({ report }: { report: Report }) {
  // In a chat: versions come from the thread's artifact registry. From the
  // library: the stored versions travel inside the artifact itself.
  const live = useArtifactList({ type: ["qc_report"] })[report.artifact_id] ?? [];
  const stored = report.versions ?? [];
  const [pick, setPick] = useState<number | null>(null);
  const shown = stored.length ? stored.find((v) => v.version === pick) ?? stored[stored.length - 1] : report;
  return (
    <div className="qc-report">
      <header className="qc-report__head">
        <p className="qc-eyebrow"><FileBarChart size={13} /> Report · {shown.topic}</p>
        <h2>{shown.title}</h2>
        <p className="qc-muted">Version {shown.version} · {when(shown.created_at)}{shown.project ? ` · project ${shown.project}` : ""}</p>
        {(live.length > 1 || stored.length > 1) && (
          <div className="qc-report__versions" role="tablist" aria-label="Versions">
            {stored.length > 1
              ? stored.map((v) => (
                  <button key={v.version} type="button" role="tab" aria-selected={v.version === shown.version}
                          className={v.version === shown.version ? "is-active" : ""} onClick={() => setPick(v.version)} title={v.title}>
                    v{v.version}
                  </button>
                ))
              : live.map((entry) => (
                  <VersionTab key={entry.version} id={entry.id} version={entry.version} current={entry.version === report.version}
                              title={entry.heading} />
                ))}
          </div>
        )}
      </header>
      <ReportBody key={`${shown.artifact_id}-${shown.version}`} report={shown} />
    </div>
  );
}

export const reportRenderer = defineArtifactRenderer<{ report: Report | null }>({
  type: "qc_report",
  toolName: "answer_artifact",
  parser: ({ response }) => {
    const report = parseJSON<Report>(response);
    if (!report) return { props: { report: null }, meta: null };
    if (!report.artifact_id) return null;
    return {
      props: { report },
      meta: { id: report.artifact_id, version: report.version, heading: `${report.heading} · v${report.version}` },
    };
  },
  preview: ({ report }, controls) => (
    <ReportCard report={report} isActive={controls.isActive} isStreaming={controls.isStreaming} open={controls.open} toggle={controls.toggle} />
  ),
  actual: ({ report }) => (report ? <ReportPanel report={report} /> : null),
  label: "Report",
  icon: <FileBarChart size={16} />,
});
