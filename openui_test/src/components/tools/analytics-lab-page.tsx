"use client";

import { useCallback, useState } from "react";
import {
  Activity,
  CalendarClock,
  Database,
  FolderKanban,
  GitFork,
  Globe2,
  Grid3x3,
  Layers,
  Network,
  Orbit,
  PieChart,
  Radar,
  RefreshCw,
  Sparkles,
  Target,
  Waves,
} from "lucide-react";

import { ChordView } from "@/components/lab/connections";
import {
  CorrelationWeb,
  OutcomeRose,
  RecordSwarm,
  Ridgelines,
  Sunburst,
  TimeSpiral,
  type CorrelationData,
  type OutcomeData,
  type RidgeData,
  type SpiralData,
  type SunburstData,
  type SwarmData,
} from "@/components/lab/dataset";
import {
  AccountGalaxy,
  CapabilityWaffle,
  HealthRings,
  OpportunityConstellation,
  RadialRanking,
  type LabAccount,
  type LabDataset,
  type LabUseCase,
  type TopAccount,
  type WaffleRow,
} from "@/components/lab/project";
import { CountUp, series, useReveal, type Kpi } from "@/components/lab/shared";
import { ClassicLabPage } from "@/components/tools/classic-lab-page";
import { AskButton, LoadState, ToolPage, useApi } from "@/components/tools/shared";
import { useUsableProject } from "@/lib/project";
import { useLocalStorage } from "@/lib/use-browser";

/**
 * Analytics lab: animated views for every project (backend/project_lab.py).
 *
 * Company projects open with a portfolio (constellation, galaxy, radial
 * ranking, countries × industries, capability gaps, data health). Every
 * project then has a deep dive per dataset (sunburst, outcome rose,
 * correlation web, ridgelines, time spiral, record swarm), so employees,
 * orders and sales get their own views too. All numbers come from MongoDB.
 */

type ProjectLabData = {
  available: boolean;
  reason?: string;
  briefing: string;
  kpis: Kpi[];
  datasets: LabDataset[];
  use_cases: LabUseCase[];
  accounts: LabAccount[];
  chord: { names: string[]; groups: string[]; matrix: number[][] };
  waffle: WaffleRow[];
  top: TopAccount[];
};

type DatasetLabData = {
  available: boolean;
  reason?: string;
  name: string;
  label: string;
  kpis: Kpi[];
  sunburst: SunburstData | null;
  outcome: OutcomeData | null;
  correlations: CorrelationData | null;
  ridges: RidgeData | null;
  spiral: SpiralData | null;
  swarm: SwarmData | null;
};

const KPI_ICON: Record<string, React.ReactNode> = {
  accounts: <Layers size={16} />,
  records: <Layers size={16} />,
  countries: <Globe2 size={16} />,
  opportunity: <Target size={16} />,
  completeness: <Activity size={16} />,
  fields: <Grid3x3 size={16} />,
  groups: <PieChart size={16} />,
};

function LabTile({ id, icon, title, caption, ask, wide, children }: {
  id: string;
  icon: React.ReactNode;
  title: string;
  caption: string;
  ask?: string;
  wide?: boolean;
  children: (visible: boolean) => React.ReactNode;
}) {
  const { ref, visible } = useReveal<HTMLElement>();
  return (
    <article ref={ref} id={`lab-${id}`} className={`lab-tile ${wide ? "lab-tile--wide" : ""} ${visible ? "is-visible" : ""}`}>
      <header className="lab-tile__head">
        <div>
          <h2 className="lab-tile__title">{icon} {title}</h2>
          <p className="lab-tile__caption">{caption}</p>
        </div>
        {ask && <AskButton prompt={ask} label="Ask" />}
      </header>
      {children(visible)}
    </article>
  );
}

function KpiCard({ kpi, index }: { kpi: Kpi; index: number }) {
  const { ref, visible } = useReveal<HTMLElement>();
  const ratio = kpi.format === "percent" ? kpi.value : null;
  return (
    <article ref={ref} className={`lab-kpi ${visible ? "is-visible" : ""}`} style={{ animationDelay: `${index * 70}ms`, ["--kpi" as string]: series(index) }}>
      <span className="lab-kpi__icon">{KPI_ICON[kpi.id] ?? <Activity size={16} />}</span>
      <span className="lab-kpi__label">{kpi.label}</span>
      <span className="lab-kpi__value"><CountUp value={kpi.value} format={kpi.format} start={visible} /></span>
      <span className="lab-kpi__hint">{kpi.hint}</span>
      {ratio != null && (
        <svg viewBox="0 0 40 40" className="lab-kpi__ring" aria-hidden="true">
          <circle cx="20" cy="20" r="16" className="lab-kpi__ring-track" />
          <circle cx="20" cy="20" r="16" className="lab-kpi__ring-arc" pathLength={1} style={{ strokeDasharray: `${visible ? ratio : 0} 1` }} />
        </svg>
      )}
    </article>
  );
}

/** One-paragraph summary, revealed word by word. */
function Summary({ text }: { text: string }) {
  const { ref, visible } = useReveal<HTMLElement>();
  return (
    <section ref={ref} className={`lab-brief ${visible ? "is-visible" : ""}`} aria-label="Summary">
      <div className="lab-brief__orb" aria-hidden="true"><span /><span /><span /></div>
      <div>
        <p className="lab-brief__eyebrow">Summary · from live data</p>
        <p className="lab-brief__text">
          {text.split(" ").map((word, i) => (
            <span key={i} style={{ animationDelay: `${i * 28}ms` }}>{word} </span>
          ))}
        </p>
      </div>
    </section>
  );
}

export function AnalyticsLabPage() {
  const { projects, projectId } = useUsableProject();
  const [stored, setStored] = useLocalStorage("qc-lab-project");
  const chosen = projects.find((p) => p.id === stored) ?? projects.find((p) => p.id === projectId) ?? projects[0] ?? null;
  const switcher = (
    <div className="plab-switch" role="tablist" aria-label="Project">
      {projects.map((p) => (
        <button key={p.id} type="button" role="tab" aria-selected={chosen?.id === p.id} title={p.description}
                className={chosen?.id === p.id ? "is-active" : ""} onClick={() => setStored(p.id)}>
          <FolderKanban size={12} /> {p.name}
        </button>
      ))}
    </div>
  );
  return (
    <div className="qc-lab">
      <ToolPage
        icon={<Orbit size={13} />}
        eyebrow="Analytics lab"
        title={chosen ? chosen.name : "Analytics lab"}
        description="Animated views of every project, computed live from MongoDB. Hover any slice, petal, star or dot for the numbers behind it; missing values are shown as unknown, never filled in."
        actions={switcher}
      >
        {!chosen && <p className="qc-muted">No active project is available to you.</p>}
        {chosen && <ProjectLab key={chosen.id} projectId={chosen.id} name={chosen.name} />}
        {/* The original SPAN / IBM HR lab, kept below the project views. */}
        <ClassicLabPage embedded />
      </ToolPage>
    </div>
  );
}

function ProjectLab({ projectId, name }: { projectId: string; name: string }) {
  const portfolio = useApi<ProjectLabData>(`/api/analytics/project-lab?project=${encodeURIComponent(projectId)}`);
  const { data: projectList } = useApi<{ projects: { id: string; datasets: { name: string; label?: string }[] }[] }>("/api/projects");
  const datasets = projectList?.projects.find((p) => p.id === projectId)?.datasets ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const collection = pick && datasets.some((d) => d.name === pick) ? pick : datasets[0]?.name ?? null;
  const labelOf = (d: { name: string; label?: string }) =>
    d.label ?? portfolio.data?.datasets.find((x) => x.name === d.name)?.label ?? d.name.replace(/_/g, " ");
  const noFocus = useCallback(() => undefined, []);
  const data = portfolio.data;

  return (
    <>
      <div className="lab-toolbar">
        <button type="button" className="qc-ghost-button" onClick={portfolio.reload}><RefreshCw size={13} /> Refresh</button>
      </div>
      <LoadState loading={portfolio.loading && !data} error={portfolio.error} onRetry={portfolio.reload} />

      {data?.available && (
        <>
          <Summary text={data.briefing} />
          <section className="lab-kpis" aria-label="Key metrics">
            {data.kpis.map((kpi, i) => <KpiCard key={kpi.id} kpi={kpi} index={i} />)}
          </section>

          <h2 className="lab-section"><Sparkles size={15} /> Portfolio</h2>
          <div className="lab-grid">
            {data.use_cases.length > 0 && (
              <LabTile id="constellation" wide icon={<Orbit size={15} />} title="Opportunity constellation"
                       caption="Each planet is a use case sized by its accounts; each star is an account flying to its strongest use case. Click a planet to isolate it."
                       ask={`What opportunities are in the ${name} data?`}>
                {(visible) => <OpportunityConstellation accounts={data.accounts} cases={data.use_cases} visible={visible} />}
              </LabTile>
            )}
            <LabTile id="galaxy" wide icon={<Sparkles size={15} />} title="Account galaxy"
                     caption="Every account as a bubble settling into its dataset's cluster; bubble size is its size percentile inside its own dataset.">
              {(visible) => <AccountGalaxy accounts={data.accounts} datasets={data.datasets} visible={visible} />}
            </LabTile>
            <LabTile id="radial" icon={<Radar size={15} />} title="The biggest accounts"
                     caption="Arcs sweep out by combined size and financial percentile within each dataset.">
              {(visible) => <RadialRanking top={data.top} datasets={data.datasets} visible={visible} />}
            </LabTile>
            {data.chord.names.length > 2 && (
              <LabTile id="chord" icon={<GitFork size={15} />} title="Countries × datasets"
                       caption="Ribbons link each country to the datasets its accounts are in; width is the number of accounts.">
                {(visible) => (
                  <ChordView data={{ names: data.chord.names, matrix: data.chord.matrix,
                                     groups: data.chord.groups.map((g) => (g === "country" ? "country" : "category")) }}
                             focus={null} onFocus={noFocus} visible={visible}
                             valueText={(v) => `${Math.round(v).toLocaleString()} accounts`} totalLabel="account links" />
                )}
              </LabTile>
            )}
            {data.waffle.length > 0 && (
              <LabTile id="waffle" wide icon={<Grid3x3 size={15} />} title="Capability gaps"
                       caption="One square per account for every yes/no capability. Pink squares are accounts without it.">
                {(visible) => <CapabilityWaffle rows={data.waffle} visible={visible} />}
              </LabTile>
            )}
            <LabTile id="health" icon={<Activity size={15} />} title="Data health"
                     caption="How complete each dataset is; lower completeness means more accounts are left out of rankings.">
              {(visible) => <HealthRings datasets={data.datasets} visible={visible} />}
            </LabTile>
          </div>
        </>
      )}

      {datasets.length > 0 && (
        <>
          <h2 className="lab-section"><Database size={15} /> Deep dive</h2>
          <div className="qc-tabs" role="tablist" aria-label="Dataset">
            {datasets.map((d) => (
              <button key={d.name} type="button" role="tab" className="qc-tab" aria-selected={collection === d.name} onClick={() => setPick(d.name)}>
                {labelOf(d)}
              </button>
            ))}
          </div>
          {collection && <DatasetLab key={collection} projectId={projectId} collection={collection} />}
        </>
      )}
    </>
  );
}

function DatasetLab({ projectId, collection }: { projectId: string; collection: string }) {
  const { data, error, loading, reload } = useApi<DatasetLabData>(
    `/api/analytics/dataset-lab?project=${encodeURIComponent(projectId)}&collection=${encodeURIComponent(collection)}`,
  );
  if (!data) return <LoadState loading={loading} error={error} onRetry={reload} />;
  if (!data.available) return <p className="qc-muted">{data.reason}</p>;
  const views = [data.sunburst, data.outcome, data.correlations, data.ridges, data.spiral, data.swarm].filter(Boolean).length;
  return (
    <>
      <section className="lab-kpis" aria-label={`${data.label} metrics`}>
        {data.kpis.map((kpi, i) => <KpiCard key={kpi.id} kpi={kpi} index={i} />)}
      </section>
      {views === 0 && <p className="qc-muted">This dataset has no fields these views can use yet.</p>}
      <div className="lab-grid">
        {data.sunburst && (
          <LabTile id="sunburst" icon={<PieChart size={15} />} title={`${data.sunburst.outer}${data.sunburst.inner ? ` → ${data.sunburst.inner}` : ""}`}
                   caption="How the records split, ring by ring." ask={`Break down the ${collection} data by ${data.sunburst.outer.toLowerCase()}`}>
            {(visible) => <Sunburst data={data.sunburst!} visible={visible} />}
          </LabTile>
        )}
        {data.outcome && (
          <LabTile id="rose" icon={<Target size={15} />} title={`${data.outcome.field} by ${data.outcome.by}`}
                   caption={`How often ${data.outcome.field.toLowerCase()} is ${data.outcome.positive.toLowerCase()}, group by group.`}
                   ask={`What is the ${data.outcome.field.toLowerCase()} rate by ${data.outcome.by.toLowerCase()} in ${collection}?`}>
            {(visible) => <OutcomeRose data={data.outcome!} visible={visible} />}
          </LabTile>
        )}
        {data.correlations && (
          <LabTile id="web" icon={<Network size={15} />} title="What moves together"
                   caption="Correlation web of the numeric fields." ask={`Which numeric fields in ${collection} are most related?`}>
            {(visible) => <CorrelationWeb data={data.correlations!} visible={visible} />}
          </LabTile>
        )}
        {data.ridges && (
          <LabTile id="ridges" wide icon={<Waves size={15} />}
                   title={data.ridges.by === "all records" ? `Distribution of ${data.ridges.measure}` : `${data.ridges.measure} by ${data.ridges.by}`}
                   caption="Distribution ridgelines: where the records sit in each group."
                   ask={`Compare ${data.ridges.measure.toLowerCase()} across ${data.ridges.by.toLowerCase()} in ${collection}`}>
            {(visible) => <Ridgelines data={data.ridges!} visible={visible} />}
          </LabTile>
        )}
        {data.spiral && (
          <LabTile id="spiral" icon={<CalendarClock size={15} />} title={data.spiral.title}
                   caption="Time spiral: months wound around the clock, one turn per year." ask={`Show the monthly trend in ${collection}`}>
            {(visible) => <TimeSpiral data={data.spiral!} visible={visible} />}
          </LabTile>
        )}
        {data.swarm && (
          <LabTile id="swarm" wide icon={<Sparkles size={15} />} title={`Every record by ${data.swarm.by}`}
                   caption="Record swarm: each dot is one record, flying into its group's lane.">
            {(visible) => <RecordSwarm data={data.swarm!} visible={visible} />}
          </LabTile>
        )}
      </div>
    </>
  );
}
