"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  BadgeDollarSign,
  BrainCircuit,
  Briefcase,
  CalendarClock,
  Building2,
  Crosshair,
  DollarSign,
  Flame,
  GitFork,
  Globe2,
  Grid3x3,
  LineChart,
  Network,
  Orbit,
  Radar,
  RefreshCw,
  ShieldAlert,
  Scale,
  ScatterChart,
  SlidersHorizontal,
  Sparkles,
  Smile,
  Sun,
  Timer,
  TrendingUp,
  UserMinus,
  Users,
  Waves,
  Wrench,
  X,
} from "lucide-react";

import { AdoptionNetwork, ChordView, FlowSankey } from "@/components/lab/connections";
import { Briefing, DriverRings, IndustryRadar, RevenueStream, ScenarioPlanner, SegmentGalaxy, SpendBeeswarm, SpendSunburst } from "@/components/lab/modern";
import { IncomeScatter, PayGap, RateBars, RateHeatmap, RiskProfiles, StayLeaveHistogram, TenureCurve, type HrLabData } from "@/components/lab/hr";
import { EfficiencyBars, ParetoCurve, RevenueForecast, SizeScatter, SpendBubbles, SpendDivergence } from "@/components/lab/patterns";
import { CountUp, DIM_LABEL, series, useReveal, type Dim, type Focus, type Kpi, type LabData, type LabInsight } from "@/components/lab/shared";
import { Sparkline } from "@/components/charts";
import { DatasetSwitch, useDataset } from "@/components/tools/datasets";
import { AskButton, LoadState, ToolPage, useApi } from "@/components/tools/shared";

const INSIGHT_ICON: Record<string, React.ReactNode> = {
  leader: <Flame size={16} />,
  concentration: <Scale size={16} />,
  correlation: <ScatterChart size={16} />,
  hotspot: <Sparkles size={16} />,
  network: <Network size={16} />,
  efficiency: <Users size={16} />,
  outlier: <Crosshair size={16} />,
  forecast: <TrendingUp size={16} />,
};

const KPI_ICON: Record<string, React.ReactNode> = {
  spend: <DollarSign size={16} />,
  per_head: <Users size={16} />,
  markets: <Globe2 size={16} />,
  tools: <Wrench size={16} />,
  gini: <Scale size={16} />,
  revenue: <TrendingUp size={16} />,
  headcount: <Users size={16} />,
  attrition: <UserMinus size={16} />,
  income: <BadgeDollarSign size={16} />,
  tenure: <CalendarClock size={16} />,
  overtime: <Timer size={16} />,
  satisfaction: <Smile size={16} />,
};

/** Card shell: reveals (and starts its chart animation) when scrolled into view. */
function LabTile({
  id,
  icon,
  title,
  caption,
  ask,
  wide,
  flash,
  children,
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  caption: string;
  ask?: string;
  wide?: boolean;
  flash: boolean;
  children: (visible: boolean) => React.ReactNode;
}) {
  const { ref, visible } = useReveal<HTMLElement>();
  return (
    <article ref={ref} id={`lab-${id}`} className={`lab-tile ${wide ? "lab-tile--wide" : ""} ${visible ? "is-visible" : ""} ${flash ? "is-flash" : ""}`}>
      <header className="lab-tile__head">
        <div>
          <h2 className="lab-tile__title">
            {icon} {title}
          </h2>
          <p className="lab-tile__caption">{caption}</p>
        </div>
        {ask && <AskButton prompt={ask} label="Ask" />}
      </header>
      {children(visible)}
    </article>
  );
}

/** KPI with its own hue, a count-up value and a ring (for 0–1 measures) or sparkline. */
function KpiCard({ kpi, index }: { kpi: Kpi; index: number }) {
  const { ref, visible } = useReveal<HTMLElement>();
  const ratio = kpi.id === "gini" || kpi.format === "percent" ? kpi.value : null;
  return (
    <article ref={ref} className={`lab-kpi ${visible ? "is-visible" : ""}`} style={{ animationDelay: `${index * 70}ms`, ["--kpi" as string]: series(index) }}>
      <span className="lab-kpi__icon">{KPI_ICON[kpi.id] ?? <Activity size={16} />}</span>
      <span className="lab-kpi__label">{kpi.label}</span>
      <span className="lab-kpi__value">
        <CountUp value={kpi.value} format={kpi.format} start={visible} />
      </span>
      <span className="lab-kpi__hint">{kpi.hint}</span>
      {kpi.spark && <Sparkline values={kpi.spark} />}
      {ratio != null && (
        <svg viewBox="0 0 40 40" className="lab-kpi__ring" aria-hidden="true">
          <circle cx="20" cy="20" r="16" className="lab-kpi__ring-track" />
          <circle cx="20" cy="20" r="16" className="lab-kpi__ring-arc" pathLength={1} style={{ strokeDasharray: `${visible ? ratio : 0} 1` }} />
        </svg>
      )}
    </article>
  );
}

/** Card that "What the data says" scrolls to and flashes. */
function useJump() {
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 1600);
    return () => window.clearTimeout(id);
  }, [flash]);
  const jump = useCallback((insight: LabInsight) => {
    document.getElementById(`lab-${insight.view}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(insight.view);
  }, []);
  return { flash, jump };
}

function Findings({ insights, onJump }: { insights: LabInsight[]; onJump: (insight: LabInsight) => void }) {
  return (
    <section aria-label="Findings">
      <h2 className="lab-section">
        <Sparkles size={15} /> What the data says
      </h2>
      <div className="lab-insights">
        {insights.map((insight, i) => (
          <button
            key={insight.title}
            type="button"
            className="lab-insight"
            style={{ animationDelay: `${i * 80}ms`, ["--ins" as string]: series(i) }}
            onClick={() => onJump(insight)}
          >
            <span className="lab-insight__icon">{INSIGHT_ICON[insight.kind] ?? <Sparkles size={16} />}</span>
            <span>
              <span className="lab-insight__title">{insight.title}</span>
              <span className="lab-insight__detail">{insight.detail}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function AnalyticsLabPage() {
  const { datasets, dataset, setDataset } = useDataset();
  const switcher = <DatasetSwitch datasets={datasets} dataset={dataset} onChange={setDataset} />;
  return dataset === "ibm_hr" ? <HrLab key="ibm_hr" switcher={switcher} /> : <SpanLab key="span" switcher={switcher} />;
}

function SpanLab({ switcher }: { switcher: React.ReactNode }) {
  const { data, error, loading, reload } = useApi<LabData>("/api/analytics/lab?dataset=span");
  const [focus, setFocus] = useState<Focus>(null);
  const { flash, jump } = useJump();

  const onFocus = useCallback((dim: Dim, name: string) => {
    setFocus((current) => (current?.dim === dim && current.name === name ? null : { dim, name }));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setFocus(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const points = data?.scatter.points ?? [];
  const segmentNames = useMemo(() => (data?.segments ?? []).map((s) => s.name), [data]);
  const inFocus = focus ? points.filter((p) => p[focus.dim] === focus.name) : [];
  const focusSpend = inFocus.reduce((sum, p) => sum + p.spend, 0);
  const allSpend = points.reduce((sum, p) => sum + p.spend, 0) || 1;
  const view = { points, focus, onFocus };

  return (
    <div className="qc-lab">
      <ToolPage
        icon={<Orbit size={13} />}
        eyebrow="Analytics lab"
        title="How everything connects"
        description="Flows, networks, machine-learning segments and forecasts computed live from MongoDB. Click any country, industry, HR tool, deployment or segment and every view follows it."
        actions={
          <>
            {switcher}
            <button type="button" className="qc-ghost-button" onClick={reload}>
              <RefreshCw size={13} /> Refresh
            </button>
          </>
        }
      >
        <LoadState loading={loading && !data} error={error} onRetry={reload} />
        {data && data.kpis.length > 0 && (
          <>
            {data.briefing && <Briefing text={data.briefing} />}

            <section className="lab-kpis" aria-label="Key metrics">
              {data.kpis.map((kpi, i) => (
                <KpiCard key={kpi.id} kpi={kpi} index={i} />
              ))}
            </section>

            <div className={`lab-focusbar ${focus ? "is-on" : ""}`} role="status">
              <Crosshair size={15} />
              {focus ? (
                <>
                  <span>
                    Following <b>{DIM_LABEL[focus.dim]}: {focus.name}</b> · {inFocus.length} companies ·{" "}
                    {((focusSpend / allSpend) * 100).toFixed(1)}% of spend
                  </span>
                  <button type="button" className="lab-chip" onClick={() => setFocus(null)}>
                    <X size={12} /> Clear <kbd>Esc</kbd>
                  </button>
                </>
              ) : (
                <span>Tip: click a node, arc, bubble, segment or bar to follow it through every chart.</span>
              )}
            </div>

            <Findings insights={data.insights} onJump={jump} />

            <h2 className="lab-section">
              <BrainCircuit size={15} /> Segments and drivers
            </h2>
            <div className="lab-grid">
              {data.segments.length > 0 && (
                <LabTile
                  id="segments"
                  wide
                  flash={flash === "segments"}
                  icon={<BrainCircuit size={15} />}
                  title="Company segments (k-means clustering)"
                  caption="Companies grouped automatically by size and spend intensity. Each dot is a company; its size is its spend."
                  ask="Group the companies by employee count and HR tech spend and describe each group"
                >
                  {(visible) => <SegmentGalaxy segments={data.segments} visible={visible} {...view} />}
                </LabTile>
              )}
              <LabTile
                id="drivers"
                flash={flash === "drivers"}
                icon={<Activity size={15} />}
                title="What drives spend"
                caption="How much of the difference between companies each factor explains on its own."
                ask="Which factors explain the differences in HR tech spend between companies?"
              >
                {(visible) => <DriverRings drivers={data.drivers} visible={visible} />}
              </LabTile>
              <LabTile
                id="radar"
                flash={flash === "radar"}
                icon={<Radar size={15} />}
                title="Industry fingerprints"
                caption="Six measures per industry, scaled from lowest to highest. Pick up to four to compare."
                ask="Compare industries by average spend, spend per employee, company size and hybrid adoption"
              >
                {(visible) => <IndustryRadar visible={visible} {...view} />}
              </LabTile>
            </div>

            <h2 className="lab-section">
              <GitFork size={15} /> Connections
            </h2>
            <div className="lab-grid">
              <LabTile
                id="flow"
                wide
                flash={flash === "flow"}
                icon={<GitFork size={15} />}
                title="Where the money flows"
                caption="Every dollar of HR tech spend, traced from country to industry to deployment model. Band width = spend."
                ask="Break down HR tech spend by country, industry and deployment type and explain the biggest flows"
              >
                {(visible) => <FlowSankey data={data.flow} visible={visible} {...view} />}
              </LabTile>
              <LabTile
                id="network"
                wide
                flash={flash === "network"}
                icon={<Network size={15} />}
                title="Adoption network"
                caption="Which industries use which HR tools. Tools in the middle are shared across many industries."
                ask="Which HR technologies are used across the most industries?"
              >
                {(visible) => <AdoptionNetwork data={data.network} visible={visible} {...view} />}
              </LabTile>
              <LabTile
                id="chord"
                flash={flash === "chord"}
                icon={<Orbit size={15} />}
                title="Markets × technology"
                caption="Spend connecting each country to each technology category."
                ask="Compare HR tech spend by technology category for each country"
              >
                {(visible) => <ChordView data={data.chord} visible={visible} focus={focus} onFocus={onFocus} />}
              </LabTile>
              <LabTile
                id="sunburst"
                flash={flash === "sunburst"}
                icon={<Sun size={15} />}
                title="Spend sunburst"
                caption="Category → HR tool → deployment, sized by spend. Click a ring to zoom, the centre to zoom out."
                ask="What is the total HR tech spend for each technology category and HR technology?"
              >
                {(visible) => <SpendSunburst visible={visible} {...view} />}
              </LabTile>
            </div>

            <h2 className="lab-section">
              <Activity size={15} /> Patterns
            </h2>
            <div className="lab-grid">
              <LabTile
                id="heatmap"
                flash={flash === "heatmap"}
                icon={<Building2 size={15} />}
                title="Spend hotspots"
                caption="Average spend for each industry and deployment model; bigger bubbles cover more companies."
                ask="What is the average HR tech spend by industry and deployment type?"
              >
                {(visible) => <SpendBubbles data={data.heatmap} visible={visible} {...view} />}
              </LabTile>
              <LabTile
                id="efficiency"
                flash={flash === "efficiency"}
                icon={<Users size={15} />}
                title="Spend per employee"
                caption="HR tech dollars per employee, by industry. Normalises for company size."
                ask="Which industries spend the most on HR technology per employee?"
              >
                {(visible) => <EfficiencyBars visible={visible} {...view} />}
              </LabTile>
              <LabTile
                id="scatter"
                wide
                flash={flash === "scatter"}
                icon={<ScatterChart size={15} />}
                title="Does size predict spend?"
                caption="Each dot is a company, coloured by its segment. The line is the log-log regression fitted on all companies."
                ask="Is there a relationship between employee count and HR tech spend?"
              >
                {(visible) => <SizeScatter fit={data.scatter.fit} segments={segmentNames} visible={visible} {...view} />}
              </LabTile>
              <LabTile
                id="swarm"
                wide
                flash={flash === "swarm"}
                icon={<Sparkles size={15} />}
                title="Distribution of spend per employee"
                caption="A beeswarm: every company placed by what it spends per employee, one lane per segment or deployment model."
                ask="How is HR tech spend per employee distributed across companies?"
              >
                {(visible) => <SpendBeeswarm points={points} focus={focus} segments={segmentNames} visible={visible} />}
              </LabTile>
              <LabTile
                id="pareto"
                flash={flash === "pareto"}
                icon={<Scale size={15} />}
                title="Concentration of spend"
                caption="How few companies carry most of the spend. The shaded gap is the inequality."
                ask="Which companies have the highest HR tech spend?"
              >
                {(visible) => <ParetoCurve data={data.pareto} points={points} focus={focus} visible={visible} />}
              </LabTile>
              <LabTile
                id="outliers"
                flash={flash === "outliers"}
                icon={<Crosshair size={15} />}
                title="Over- and under-investors"
                caption="Companies furthest from the spend their headcount predicts."
                ask="Which companies spend the most on HR technology relative to their employee count?"
              >
                {(visible) => <SpendDivergence data={data.outliers} focus={focus} visible={visible} />}
              </LabTile>
            </div>

            {(data.revenue || data.streams) && (
              <>
                <h2 className="lab-section">
                  <LineChart size={15} /> Momentum
                </h2>
                <div className="lab-grid">
                  {data.streams && (
                    <LabTile
                      id="stream"
                      wide
                      flash={flash === "stream"}
                      icon={<Waves size={15} />}
                      title="Revenue streams by category"
                      caption="Monthly store revenue for each product category as flowing layers."
                      ask="Show monthly revenue by product category"
                    >
                      {(visible) => <RevenueStream data={data.streams!} visible={visible} />}
                    </LabTile>
                  )}
                  {data.revenue && (
                    <LabTile
                      id="revenue"
                      wide
                      flash={flash === "revenue"}
                      icon={<TrendingUp size={15} />}
                      title="Revenue trend and forecast"
                      caption="Monthly store revenue with a 3-month moving average and a linear projection for the next quarter."
                      ask="Show monthly revenue and explain the trend"
                    >
                      {(visible) => <RevenueForecast data={data.revenue!} visible={visible} />}
                    </LabTile>
                  )}
                </div>
              </>
            )}

            <h2 className="lab-section">
              <SlidersHorizontal size={15} /> Scenario planner
            </h2>
            <div className="lab-grid">
              <LabTile
                id="scenario"
                wide
                flash={flash === "scenario"}
                icon={<SlidersHorizontal size={15} />}
                title="What if headcount grows or prices change?"
                caption="Move the sliders to project next year's HR tech spend, overall and per segment. Respects your current focus."
              >
                {() => <ScenarioPlanner points={points} slope={data.scatter.fit.slope} segments={data.segments} focus={focus} />}
              </LabTile>
            </div>
          </>
        )}
      </ToolPage>
    </div>
  );
}

const HR_DRIVER_TARGETS = { attrition: "Leaving", income: "Monthly income" };
const HR_DRIVER_NOTE = "Share of the variation each factor explains on its own (η² for categories, r² for numbers). Rings are scaled to the strongest factor.";

function HrLab({ switcher }: { switcher: React.ReactNode }) {
  const { data, error, loading, reload } = useApi<HrLabData>("/api/analytics/lab?dataset=ibm_hr");
  const [role, setRole] = useState<string | null>(null);
  const { flash, jump } = useJump();
  const onRole = useCallback((name: string) => setRole((current) => (current === name ? null : name)), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setRole(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const overall = data?.overall_rate ?? 0;
  const inRole = role ? (data?.scatter ?? []).filter((p) => p.role === role) : [];
  const roleLeft = inRole.filter((p) => p.left).length;

  return (
    <div className="qc-lab">
      <ToolPage
        icon={<Orbit size={13} />}
        eyebrow="Analytics lab · IBM HR"
        title="Why employees leave"
        description="Attrition, pay, satisfaction and tenure for 1,470 IBM employees (Kaggle IBM HR Analytics), computed live from MongoDB. Click a job role and the role views follow it."
        actions={
          <>
            {switcher}
            <button type="button" className="qc-ghost-button" onClick={reload}>
              <RefreshCw size={13} /> Refresh
            </button>
          </>
        }
      >
        <LoadState loading={loading && !data} error={error} onRetry={reload} />
        {data && data.kpis.length === 0 && <p className="lab-note">The IBM HR collection is empty. Run scripts/import_ibm_hr.py to load it.</p>}
        {data && data.kpis.length > 0 && (
          <>
            {data.briefing && <Briefing text={data.briefing} />}

            <section className="lab-kpis" aria-label="Key metrics">
              {data.kpis.map((kpi, i) => (
                <KpiCard key={kpi.id} kpi={kpi} index={i} />
              ))}
            </section>

            <div className={`lab-focusbar ${role ? "is-on" : ""}`} role="status">
              <Crosshair size={15} />
              {role ? (
                <>
                  <span>
                    Following <b>Job role: {role}</b> · {inRole.length} employees · {inRole.length ? ((roleLeft / inRole.length) * 100).toFixed(1) : 0}% left
                  </span>
                  <button type="button" className="lab-chip" onClick={() => setRole(null)}>
                    <X size={12} /> Clear <kbd>Esc</kbd>
                  </button>
                </>
              ) : (
                <span>Tip: click a job role in the pay-gap chart (or the job-role breakdown) to follow it.</span>
              )}
            </div>

            <Findings insights={data.insights} onJump={jump} />

            <h2 className="lab-section">
              <UserMinus size={15} /> Who leaves
            </h2>
            <div className="lab-grid">
              <LabTile
                id="breakdown"
                flash={flash === "breakdown"}
                icon={<Users size={15} />}
                title="Attrition rate by group"
                caption="Pick any dimension to see which groups lose the most people."
                ask="What is the attrition rate by department and job role in the IBM HR employee data?"
              >
                {(visible) => <RateBars data={data.breakdowns} overall={overall} visible={visible} role={role} onRole={onRole} />}
              </LabTile>
              <LabTile
                id="drivers"
                flash={flash === "drivers"}
                icon={<Activity size={15} />}
                title="What drives leaving"
                caption="How much of the difference between leavers and stayers (or in pay) each factor explains."
                ask="Compare the attrition rate of IBM HR employees who work overtime with those who don't"
              >
                {(visible) => <DriverRings drivers={data.drivers} visible={visible} targets={HR_DRIVER_TARGETS} note={HR_DRIVER_NOTE} />}
              </LabTile>
              <LabTile
                id="profiles"
                wide
                flash={flash === "profiles"}
                icon={<ShieldAlert size={15} />}
                title="Risk profiles"
                caption="The combinations of overtime, marital status and job level with the highest and lowest attrition."
                ask="Show the attrition rate by overtime, marital status and job level for IBM HR employees"
              >
                {(visible) => <RiskProfiles data={data.profiles} overall={overall} visible={visible} />}
              </LabTile>
            </div>

            <h2 className="lab-section">
              <BadgeDollarSign size={15} /> Pay and experience
            </h2>
            <div className="lab-grid">
              <LabTile
                id="distribution"
                wide
                flash={flash === "distribution"}
                icon={<ScatterChart size={15} />}
                title="Stayers vs leavers"
                caption="Distribution of each measure: stayers above the line, leavers below."
                ask="Compare the average monthly income, age and years at company of IBM HR employees who left and who stayed"
              >
                {(visible) => <StayLeaveHistogram data={data.distributions} visible={visible} />}
              </LabTile>
              {data.pay_gap.length > 0 && (
                <LabTile
                  id="pay"
                  flash={flash === "pay"}
                  icon={<Briefcase size={15} />}
                  title="Pay gap by job role"
                  caption="Median monthly income of leavers and stayers in each role. Click a role to follow it."
                  ask="Show the average monthly income by job role and attrition for IBM HR employees"
                >
                  {(visible) => <PayGap data={data.pay_gap} visible={visible} role={role} onRole={onRole} />}
                </LabTile>
              )}
              <LabTile
                id="tenure"
                flash={flash === "tenure"}
                icon={<CalendarClock size={15} />}
                title="Attrition by tenure"
                caption="Share of employees who left, by years at the company. Bars show headcount."
                ask="What is the attrition rate by years at company for IBM HR employees?"
              >
                {(visible) => <TenureCurve data={data.tenure} overall={overall} visible={visible} />}
              </LabTile>
              <LabTile
                id="scatter"
                wide
                flash={flash === "scatter"}
                icon={<LineChart size={15} />}
                title="Income vs experience"
                caption="Every employee placed by total working years and monthly income; leavers in the warm colour."
                ask="Is there a relationship between total working years and monthly income for IBM HR employees?"
              >
                {(visible) => <IncomeScatter points={data.scatter} visible={visible} role={role} />}
              </LabTile>
            </div>

            {data.heatmaps.length > 0 && (
              <>
                <h2 className="lab-section">
                  <Grid3x3 size={15} /> Hotspots
                </h2>
                <div className="lab-grid">
                  <LabTile
                    id="heatmap"
                    wide
                    flash={flash === "heatmap"}
                    icon={<Flame size={15} />}
                    title="Attrition hotspots"
                    caption="Attrition rate where two factors meet."
                    ask="Show the attrition rate by job satisfaction and environment satisfaction for IBM HR employees"
                  >
                    {(visible) => <RateHeatmap maps={data.heatmaps} visible={visible} />}
                  </LabTile>
                </div>
              </>
            )}
          </>
        )}
      </ToolPage>
    </div>
  );
}
