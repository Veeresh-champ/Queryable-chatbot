"use client";

import { useEffect, useState } from "react";
import { FolderKanban, LayoutDashboard, Lightbulb, Sparkles } from "lucide-react";

import { ClassicInsightsPage } from "@/components/tools/classic-insights-page";
import { LoadState, ToolPage, useApi, useAsk } from "@/components/tools/shared";
import { ChartCard, type ChartSpec } from "@/components/viz/charts";
import { CountUp } from "@/components/lab/shared";
import { type ValueFormat } from "@/lib/geo";
import { projectQuery, useUsableProject } from "@/lib/project";

type Kpi = { id: string; label: string; value: number; format: ValueFormat; hint: string };
type Board = {
  scope: string[];
  datasets: { name: string; label: string; rows: number; accounts: number; company: boolean }[];
  kpis: Kpi[];
  charts: ChartSpec[];
};

const STAT_HUES = ["var(--viz-series-1)", "var(--viz-series-3)", "var(--viz-series-7)", "var(--viz-series-2)", "var(--viz-series-5)", "var(--viz-series-4)"];

/** Headline number that counts up, with a ring for shares. */
function StatCard({ kpi, index }: { kpi: Kpi; index: number }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <article className="viz-stat" style={{ animationDelay: `${index * 70}ms`, ["--stat" as string]: STAT_HUES[index % STAT_HUES.length] }}>
      <span className="viz-stat__label">{kpi.label}</span>
      <span className="viz-stat__value"><CountUp value={kpi.value} format={kpi.format} start={on} /></span>
      <span className="viz-stat__hint">{kpi.hint}</span>
      {kpi.format === "percent" && (
        <svg viewBox="0 0 40 40" className="viz-stat__ring" aria-hidden="true">
          <circle cx="20" cy="20" r="16" className="track" />
          <circle cx="20" cy="20" r="16" className="arc" pathLength={1} style={{ strokeDasharray: `${on ? kpi.value : 0} 1` }} />
        </svg>
      )}
    </article>
  );
}

/** Project picker shared by the dashboard and Opportunities pages. */
export function ProjectScope({ label = "Project" }: { label?: string }) {
  const { projectId, projects, setActive } = useUsableProject();
  return (
    <label className="qc-scope-bar">
      <FolderKanban size={14} /> {label}
      <select className="qc-select" value={projectId} onChange={(e) => setActive(e.target.value)}>
        <option value="">All my data</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </label>
  );
}

function Dashboard() {
  const { projectId, project } = useUsableProject();
  const ask = useAsk();
  // The dataset tab belongs to one project: a project switch resets it.
  const [pick, setPick] = useState<{ project: string; collection: string }>({ project: "", collection: "" });
  const collection = pick.project === projectId ? pick.collection : "";
  const setCollection = (name: string) => setPick({ project: projectId, collection: name });
  const overview = useApi<Board>(`/api/dashboard${projectQuery(projectId)}`);
  const detail = useApi<Board>(collection ? `/api/dashboard?collection=${encodeURIComponent(collection)}${projectQuery(projectId, "&")}` : null);
  const board = collection ? detail.data : overview.data;
  const state = collection ? detail : overview;
  const datasets = overview.data?.datasets ?? [];

  return (
    <>
      <div className="qc-tabs" role="tablist" aria-label="Dataset">
        <button type="button" role="tab" className="qc-tab" aria-selected={!collection} onClick={() => setCollection("")}>
          <LayoutDashboard size={13} /> {datasets.length > 1 ? "Project overview" : "Overview"}
        </button>
        {datasets.length > 1 &&
          datasets.map((d) => (
            <button key={d.name} type="button" role="tab" className="qc-tab" aria-selected={collection === d.name} onClick={() => setCollection(d.name)}>
              {d.label} <small>{(d.company ? d.accounts : d.rows).toLocaleString()}</small>
            </button>
          ))}
      </div>

      <LoadState loading={state.loading && !board} error={state.error} onRetry={state.reload} />
      {board && (
        <div style={{ opacity: state.loading ? 0.55 : 1, transition: "opacity .2s", display: "grid", gap: 14 }}>
          <section className="viz-stats" aria-label="Key metrics">
            {board.kpis.map((kpi, i) => (
              <StatCard key={`${collection}-${kpi.id}`} kpi={kpi} index={i} />
            ))}
          </section>
          {board.charts.length === 0 && (
            <p className="qc-muted">
              <Sparkles size={13} /> No charts fit this data yet{project ? ` in ${project.name}` : ""}.
            </p>
          )}
          <section className="viz-grid-layout">
            {board.charts.map((chart) => (
              <ChartCard key={`${collection}-${chart.id}`} chart={chart} onAsk={ask} />
            ))}
          </section>
        </div>
      )}
    </>
  );
}

/**
 * Insights studio: auto-built charts for the selected project, or one dataset
 * in it (backend/dashboard.py). Replaces the earlier fixed overview.
 */
export function InsightsPage() {
  return (
    <ToolPage
      icon={<Lightbulb size={13} />}
      eyebrow="Insights studio"
      title="Your projects at a glance"
      description="Charts picked automatically from each dataset's fields: maps, coverage, distributions, comparisons and concentration. Every number comes straight from MongoDB; missing values are counted, never filled in."
      actions={
        <>
          <ProjectScope />
        </>
      }
    >
      <Dashboard />
      {/* The original overview (SPAN and IBM HR), kept below the new charts. */}
      <ClassicInsightsPage embedded />
    </ToolPage>
  );
}
