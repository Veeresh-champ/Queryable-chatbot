"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hierarchy, pack } from "d3-hierarchy";
import { sankey, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from "d3-sankey";
import { scaleLinear, scaleLog } from "d3-scale";
import { curveMonotoneX, line } from "d3-shape";
import { Download, MessageSquarePlus, Table2 } from "lucide-react";

import { ConcentrationRing, DotMatrix, GlobeView, Honeycomb, PackTree, ProgressRings, RadialTop, RangeCapsules, Wave } from "@/components/viz/studio";
import { formatValue, type GeoPayload, type ValueFormat } from "@/lib/geo";
import { csvCell } from "@/lib/csv";

/**
 * Charts for the auto-built dashboards (backend/dashboard.py) and the
 * Opportunities page. One spec in, one form out; the form is picked by the
 * backend from the data's job:
 *
 *   magnitude ranking   bar, lollipop        distribution   histogram, box
 *   part-to-whole       stacked, treemap     relationship   scatter
 *   geography           map                  concentration  pareto (one % axis)
 *   two-way counts      heatmap              change         trend (+ moving average)
 *   flow                sankey               comparison     dumbbell
 *   data quality        coverage             narrowing      funnel
 *
 * Rules (dataviz skill): categorical hues in fixed slot order and never
 * cycled (> 3 groups fold into "Other" on scatter); one hue light→dark for
 * magnitude; one y-axis only; thin marks with 2px surface gaps; text in ink
 * tokens, never series colours; every chart has hover, a table view and CSV.
 */

export type ChartSpec = {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  /** One-line takeaway computed from the chart's data (backend/dashboard.py headline). */
  headline?: string | null;
  wide?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
};

const W = 640;
const SERIES = Array.from({ length: 8 }, (_, i) => `var(--viz-series-${i + 1})`);
const NEUTRAL = "var(--qc-neutral-mark)";

const fmt = (value: number, format: ValueFormat = "number") => formatValue(value, format);
const pct = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
const short = (text: string, n = 22) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

type Tip = { x: number; y: number; title: string; lines: string[] } | null;

type TipApi = { show: (event: React.PointerEvent | React.FocusEvent, title: string, lines: string[]) => void; hide: () => void };

/** Tooltip state for one chart. The ref is only read in event handlers, never during render. */
function useTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip>(null);
  const api: TipApi = {
    show: (event, title, lines) => {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      const target = (event.target as Element).getBoundingClientRect();
      const x = "clientX" in event && event.clientX ? event.clientX - box.left : target.left + target.width / 2 - box.left;
      const y = "clientY" in event && event.clientY ? event.clientY - box.top : target.top - box.top;
      setTip({ x, y, title, lines });
    },
    hide: () => setTip(null),
  };
  return [ref, tip, api] as const;
}

function TipLayer({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <strong>{tip.title}</strong>
      {tip.lines.map((l) => (
        <span key={l}>{l}</span>
      ))}
    </div>
  );
}

/** Props spread on every mark: hover and keyboard focus show the same tooltip. */
function hover(t: TipApi, title: string, lines: string[]) {
  return {
    tabIndex: 0,
    onPointerMove: (e: React.PointerEvent) => t.show(e, title, lines),
    onPointerLeave: t.hide,
    onFocus: (e: React.FocusEvent) => t.show(e, title, lines),
    onBlur: t.hide,
    "aria-label": `${title}: ${lines.join(", ")}`,
  };
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="viz-legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className="viz-swatch" style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- forms


type TreeDatum = { name: string; value?: number; children?: TreeDatum[] };


type SNode = { name: string };
type SLink = { source: string; target: string; value: number };

function Sankey({ data }: { data: { nodes: SNode[]; links: SLink[] } }) {
  const [tipRef, tip, t] = useTip();
  const H = 360;
  const layout = useMemo(() => {
    const index = new Map(data.nodes.map((n, i) => [n.name, i]));
    const generator = sankey<SNode, { value: number }>().nodeWidth(10).nodePadding(12).extent([[150, 8], [W - 190, H - 8]]);
    return generator({
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ source: index.get(l.source)!, target: index.get(l.target)!, value: l.value })),
    });
  }, [data]);
  const targets = layout.nodes.filter((n) => (n.targetLinks?.length ?? 0) > 0);
  const colorOf = (n: SankeyNode<SNode, { value: number }>) => {
    const i = targets.indexOf(n);
    return i >= 0 && i < 8 ? SERIES[i] : NEUTRAL;
  };
  return (
    <div className="viz-wrap" ref={tipRef}>
      <svg viewBox={`0 0 ${W} ${H}`} className="viz-svg" role="img" aria-label="Flow diagram">
        {layout.links.map((link, i) => {
          const l = link as SankeyLink<SNode, { value: number }> & { width: number };
          const src = l.source as SankeyNode<SNode, { value: number }>;
          const dst = l.target as SankeyNode<SNode, { value: number }>;
          return (
            <path key={i} d={sankeyLinkHorizontal()(l) ?? ""} stroke={colorOf(dst)} strokeWidth={Math.max(1, l.width)}
                  className="viz-link" {...hover(t, `${src.name} → ${dst.name}`, [`${l.value} accounts`])} />
          );
        })}
        {layout.nodes.map((node) => {
          const n = node as SankeyNode<SNode, { value: number }> & { x0: number; x1: number; y0: number; y1: number; value: number };
          const isTarget = targets.includes(node);
          return (
            <g key={n.name}>
              <rect x={n.x0} y={n.y0} width={n.x1 - n.x0} height={Math.max(2, n.y1 - n.y0)} rx={2}
                    fill={isTarget ? colorOf(node) : NEUTRAL} {...hover(t, n.name, [`${n.value} accounts`])} />
              <text x={isTarget ? n.x1 + 6 : n.x0 - 6} y={(n.y0 + n.y1) / 2 + 4} textAnchor={isTarget ? "start" : "end"}
                    className="viz-label">{short(n.name, 26)} <tspan className="viz-muted">{n.value}</tspan></text>
            </g>
          );
        })}
      </svg>
      <TipLayer tip={tip} />
    </div>
  );
}

type StackRow = { label: string; yes: number; no: number; unknown: number };


function Dumbbell({ data }: { data: { rows: { label: string; a: number; b: number }[]; a_label: string; b_label: string } }) {
  const [tipRef, tip, t] = useTip();
  const left = 170;
  const rowH = 30;
  const x = scaleLinear().domain([0, 1]).range([left, W - 20]);
  return (
    <div className="viz-wrap" ref={tipRef}>
      <Legend items={[{ label: data.a_label, color: SERIES[0] }, { label: data.b_label, color: SERIES[1] }]} />
      <svg viewBox={`0 0 ${W} ${data.rows.length * rowH + 26}`} className="viz-svg" role="img" aria-label="Comparison">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={0} y2={data.rows.length * rowH} className="viz-grid" />
            <text x={x(v)} y={data.rows.length * rowH + 16} textAnchor="middle" className="viz-axis">{pct(v)}</text>
          </g>
        ))}
        {data.rows.map((row, i) => {
          const y = i * rowH + 15;
          return (
            <g key={row.label}>
              <text x={left - 10} y={y + 4} textAnchor="end" className="viz-label">{short(row.label, 24)}</text>
              <line x1={x(Math.min(row.a, row.b))} x2={x(Math.max(row.a, row.b))} y1={y} y2={y} className="viz-stem" />
              <circle cx={x(row.b)} cy={y} r={6} fill={SERIES[1]} className="viz-dot" {...hover(t, row.label, [`${data.b_label}: ${pct(row.b)}`])} />
              <circle cx={x(row.a)} cy={y} r={6} fill={SERIES[0]} className="viz-dot" {...hover(t, row.label, [`${data.a_label}: ${pct(row.a)}`])} />
            </g>
          );
        })}
      </svg>
      <TipLayer tip={tip} />
    </div>
  );
}



type BoxGroup = { label: string; min: number; q1: number; median: number; q3: number; max: number; n: number };


type Pt = { label: string; x: number; y: number; group: string };

function Scatter({ data }: { data: { points: Pt[]; x_label: string; y_label: string; log: boolean; x_format: ValueFormat; y_format: ValueFormat; groups: string[] } }) {
  const [tipRef, tip, t] = useTip();
  const H = 320;
  const pad = { l: 58, r: 12, t: 12, b: 38 };
  const xs = data.points.map((p) => p.x);
  const ys = data.points.map((p) => p.y);
  const mk = (vals: number[], range: [number, number]) =>
    data.log ? scaleLog().domain([Math.min(...vals), Math.max(...vals)]).range(range).nice()
      : scaleLinear().domain([0, Math.max(...vals)]).range(range).nice();
  const x = mk(xs, [pad.l, W - pad.r]);
  const y = mk(ys, [H - pad.b, pad.t]);
  const color = (g: string) => {
    const i = data.groups.indexOf(g);
    return g === "Other" || i < 0 ? NEUTRAL : SERIES[i];
  };
  const ticks = (s: typeof x) => s.ticks(5).filter((_, i, a) => a.length <= 6 || i % Math.ceil(a.length / 6) === 0);
  // The two largest by y get a direct label; everything else via hover.
  const labelled = new Set([...data.points].sort((a, b) => b.y - a.y).slice(0, 2).map((p) => p.label));
  return (
    <div className="viz-wrap" ref={tipRef}>
      <Legend items={data.groups.map((g) => ({ label: g, color: color(g) }))} />
      <svg viewBox={`0 0 ${W} ${H}`} className="viz-svg" role="img" aria-label="Scatter plot">
        {ticks(y).map((v) => (
          <g key={`y${v}`}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="viz-grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="viz-axis">{fmt(v, data.y_format)}</text>
          </g>
        ))}
        {ticks(x).map((v) => (
          <text key={`x${v}`} x={x(v)} y={H - pad.b + 16} textAnchor="middle" className="viz-axis">{fmt(v, data.x_format)}</text>
        ))}
        <text x={(pad.l + W) / 2} y={H - 4} textAnchor="middle" className="viz-axis-title">{data.x_label}{data.log ? " (log)" : ""} →</text>
        <text x={12} y={pad.t + 4} className="viz-axis-title">↑ {data.y_label}</text>
        {data.points.map((p, i) => (
          <g key={`${p.label}-${i}`}>
            <circle cx={x(p.x)} cy={y(p.y)} r={5} fill={color(p.group)} className="viz-dot" />
            <circle cx={x(p.x)} cy={y(p.y)} r={12} className="viz-hit"
                    {...hover(t, p.label || "Account", [`${data.x_label}: ${fmt(p.x, data.x_format)}`, `${data.y_label}: ${fmt(p.y, data.y_format)}`, p.group])} />
            {labelled.has(p.label) && <text x={x(p.x) + 8} y={y(p.y) - 8} className="viz-label">{short(p.label, 22)}</text>}
          </g>
        ))}
      </svg>
      <TipLayer tip={tip} />
    </div>
  );
}



function Trend({ data }: { data: { rows: { label: string; value: number; avg: number }[]; format: ValueFormat } }) {
  const ref = useRef<SVGSVGElement>(null);
  const [index, setIndex] = useState<number | null>(null);
  const H = 240;
  const pad = { l: 58, r: 12, t: 12, b: 28 };
  const x = scaleLinear().domain([0, Math.max(1, data.rows.length - 1)]).range([pad.l, W - pad.r]);
  const y = scaleLinear().domain([0, Math.max(...data.rows.map((r) => Math.max(r.value, r.avg))) * 1.08]).nice(4).range([H - pad.b, pad.t]);
  const mk = (key: "value" | "avg") => line<{ value: number; avg: number }>().x((_, i) => x(i)).y((d) => y(d[key])).curve(curveMonotoneX)(data.rows) ?? "";
  const every = Math.ceil(data.rows.length / 8);
  const point = index != null ? data.rows[index] : null;
  return (
    <div className="viz-wrap">
      <Legend items={[{ label: "Monthly value", color: SERIES[0] }, { label: "3-month average", color: SERIES[1] }]} />
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="viz-svg" role="img" aria-label="Trend"
           onPointerMove={(e) => {
             const box = ref.current?.getBoundingClientRect();
             if (!box) return;
             setIndex(Math.max(0, Math.min(data.rows.length - 1, Math.round(x.invert(((e.clientX - box.left) / box.width) * W)))));
           }}
           onPointerLeave={() => setIndex(null)}>
        {y.ticks(4).map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="viz-grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="viz-axis">{fmt(v, data.format)}</text>
          </g>
        ))}
        {data.rows.map((r, i) => (i % every === 0 || i === data.rows.length - 1 ? (
          <text key={r.label} x={x(i)} y={H - 8} textAnchor="middle" className="viz-axis">{r.label}</text>
        ) : null))}
        <path d={mk("value")} className="viz-line" stroke={SERIES[0]} />
        <path d={mk("avg")} className="viz-line viz-line--thin" stroke={SERIES[1]} />
        {point && index != null && (
          <g>
            <line x1={x(index)} x2={x(index)} y1={pad.t} y2={H - pad.b} className="viz-cross" />
            <circle cx={x(index)} cy={y(point.value)} r={5} fill={SERIES[0]} className="viz-dot" />
          </g>
        )}
      </svg>
      {point && index != null && (
        <div className="viz-tip" style={{ left: `${(x(index) / W) * 100}%`, top: 24 }}>
          <strong>{point.label}</strong>
          <span>{fmt(point.value, data.format)}</span>
          <span>avg {fmt(point.avg, data.format)}</span>
        </div>
      )}
    </div>
  );
}


export function Funnel({ steps }: { steps: { step: string; count: number }[] }) {
  const [tipRef, tip, t] = useTip();
  const start = Math.max(1, steps[0]?.count ?? 1);
  const ramp = ["var(--qc-seq-5)", "var(--qc-seq-4)", "var(--qc-seq-4)", "var(--qc-seq-3)", "var(--qc-seq-3)", "var(--qc-seq-2)", "var(--qc-seq-2)"];
  return (
    <div className="viz-wrap" ref={tipRef}>
      <ol className="viz-funnel">
        {steps.map((s, i) => (
          <li key={s.step} {...hover(t, s.step, [`${s.count.toLocaleString()} accounts`, `${pct(s.count / start)} of start`])}>
            <span className="viz-funnel__label">{s.step}</span>
            <span className="viz-funnel__track">
              <span style={{ width: `${Math.max(0.6, (s.count / start) * 100)}%`, background: ramp[Math.min(i, ramp.length - 1)] }} />
            </span>
            <span className="viz-funnel__value">{s.count.toLocaleString()} <em>{pct(s.count / start)}</em></span>
          </li>
        ))}
      </ol>
      <TipLayer tip={tip} />
    </div>
  );
}

/** Animated packed bubbles for a ranking: area = value, every bubble labelled when it fits. */
function BubblePack({ data }: { data: { rows: { label: string; value: number }[]; format: ValueFormat } }) {
  const [tipRef, tip, t] = useTip();
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const S = 360;
  const leaves = useMemo(() => {
    const rows = data.rows.filter((r) => r.value > 0);
    const root = hierarchy<{ label?: string; value?: number; children?: { label: string; value: number }[] }>({ children: rows })
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return pack<{ label?: string; value?: number }>().size([S, S]).padding(3)(root).leaves();
  }, [data]);
  const total = data.rows.reduce((sum, r) => sum + r.value, 0) || 1;
  // Colour follows the label (its position in the source order), "Other" stays neutral.
  const color = (label: string) => {
    const i = data.rows.findIndex((r) => r.label === label);
    return label === "Other" || i < 0 || i >= 8 ? NEUTRAL : SERIES[i];
  };
  return (
    <div className="viz-wrap viz-pack" ref={tipRef}>
      <svg viewBox={`0 0 ${S} ${S}`} className="viz-svg" style={{ maxHeight: 380 }} role="img" aria-label="Packed bubbles">
        {leaves.map((leaf, i) => {
          const label = leaf.data.label ?? "";
          const value = leaf.data.value ?? 0;
          const fits = leaf.r > 26;
          return (
            <g key={label} transform={`translate(${leaf.x},${leaf.y})`}>
              <circle r={leaf.r} fill={color(label)} className={`viz-pack__bubble viz-mark ${on ? "is-on" : ""}`}
                      style={{ animationDelay: `${i * 70}ms` }}
                      {...hover(t, label, [`${fmt(value, data.format)}`, `${pct(value / total)} of total`])} />
              {fits && (
                <>
                  <text textAnchor="middle" y={-2} className="viz-pack__name">{short(label, Math.max(6, Math.floor(leaf.r / 3.6)))}</text>
                  <text textAnchor="middle" y={13} className="viz-pack__value">{fmt(value, data.format)}</text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="viz-legend">
        {data.rows.slice(0, 8).map((r) => (
          <li key={r.label}><span className="viz-swatch" style={{ background: color(r.label) }} />{short(r.label, 26)} · {fmt(r.value, data.format)}</li>
        ))}
      </ul>
      <TipLayer tip={tip} />
    </div>
  );
}

export function ChartBody({ chart }: { chart: ChartSpec }) {
  const d = chart.data;
  switch (chart.kind) {
    case "map":
      return <GlobeView data={d as GeoPayload} />;
    case "bar":
      return <BubblePack data={d} />;
    case "heatmap":
      return <DotMatrix data={d} />;
    case "treemap":
      return <PackTree data={d} />;
    case "sankey":
      return <Sankey data={d} />;
    case "stacked":
      return <ProgressRings data={d} />;
    case "dumbbell":
      return <Dumbbell data={d} />;
    case "histogram":
      return <Wave data={d} />;
    case "box":
      return <RangeCapsules data={d} />;
    case "scatter":
      return <Scatter data={d} />;
    case "pareto":
      return <ConcentrationRing data={d} />;
    case "lollipop":
      return <RadialTop data={d} />;
    case "trend":
      return <Trend data={d} />;
    case "coverage":
      return <Honeycomb data={d} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- table view & CSV

export function chartTable(chart: ChartSpec): { columns: string[]; rows: (string | number)[][] } {
  const d = chart.data;
  switch (chart.kind) {
    case "map":
      return { columns: ["Country", d.metric ?? "Value"], rows: (d as GeoPayload).places.map((p) => [p.name, p.value ?? ""]) };
    case "bar":
    case "coverage":
      return { columns: ["Label", "Value"], rows: d.rows.map((r: { label: string; value: number }) => [r.label, chart.kind === "coverage" ? pct(r.value) : r.value]) };
    case "heatmap":
      return { columns: ["", ...d.cols], rows: d.rows.map((r: string, i: number) => [r, ...d.cells[i]]) };
    case "treemap":
      return { columns: ["Group", "Item", "Value"], rows: (d.children as TreeDatum[]).flatMap((g) => (g.children ?? []).map((c) => [g.name, c.name, c.value ?? 0])) };
    case "sankey":
      return { columns: ["From", "To", "Accounts"], rows: d.links.map((l: SLink) => [l.source, l.target, l.value]) };
    case "stacked":
      return { columns: ["Capability", "Yes", "No", "Not recorded"], rows: d.rows.map((r: StackRow) => [r.label, r.yes, r.no, r.unknown]) };
    case "dumbbell":
      return { columns: ["Capability", d.a_label, d.b_label], rows: d.rows.map((r: { label: string; a: number; b: number }) => [r.label, pct(r.a), pct(r.b)]) };
    case "histogram":
      return { columns: ["From", "To", "Accounts"], rows: d.bins.map((b: { from: number; to: number; count: number }) => [b.from, b.to, b.count]) };
    case "box":
      return { columns: ["Group", "n", "Min", "Q1", "Median", "Q3", "Max"], rows: d.groups.map((g: BoxGroup) => [g.label, g.n, g.min, g.q1, g.median, g.q3, g.max]) };
    case "scatter":
      return { columns: ["Account", d.x_label, d.y_label, "Group"], rows: d.points.map((p: Pt) => [p.label, p.x, p.y, p.group]) };
    case "pareto":
      return { columns: ["Account", "Value", "Cumulative share"], rows: d.rows.map((r: { label: string; value: number; cum_share: number }) => [r.label, r.value, pct(r.cum_share)]) };
    case "lollipop":
      return { columns: ["Account", "As written", "Value", "Country"], rows: d.rows.map((r: { label: string; value: number; group: string; shown: string | null }) => [r.label, r.shown ?? "", r.value, r.group]) };
    case "trend":
      return { columns: ["Month", "Value", "3-month average"], rows: d.rows.map((r: { label: string; value: number; avg: number }) => [r.label, r.value, r.avg]) };
    default:
      return { columns: [], rows: [] };
  }
}

function download(chart: ChartSpec) {
  const { columns, rows } = chartTable(chart);
  const esc = (v: string | number) => csvCell(v);
  const csv = [columns, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${chart.id}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ChartCard({ chart, onAsk }: { chart: ChartSpec; onAsk?: (prompt: string) => void }) {
  const [table, setTable] = useState(false);
  const view = chartTable(chart);
  return (
    <article className={`qc-tile viz-card ${chart.wide ? "qc-tile--wide" : ""}`} data-kind={chart.kind}>
      <header className="viz-card__head">
        <div>
          <h3 className="qc-tile__title">{chart.title}</h3>
          {chart.headline && <p className="viz-card__headline">{chart.headline}</p>}
          {chart.subtitle && <p className="viz-card__sub">{chart.subtitle}</p>}
        </div>
        <div className="viz-card__actions">
          {view.rows.length > 0 && (
            <>
              <button type="button" className="qc-icon-button" aria-pressed={table} onClick={() => setTable((v) => !v)}
                      title={table ? "Show chart" : "Show table"} aria-label={table ? "Show chart" : "Show table"}>
                <Table2 size={14} />
              </button>
              <button type="button" className="qc-icon-button" onClick={() => download(chart)} title="Download CSV" aria-label="Download CSV">
                <Download size={14} />
              </button>
            </>
          )}
          {onAsk && (
            <button type="button" className="qc-icon-button" title="Ask about this in chat" aria-label="Ask about this in chat"
                    onClick={() => onAsk(`Explain "${chart.title}" (${chart.subtitle ?? ""}) and what I should do about it`)}>
              <MessageSquarePlus size={14} />
            </button>
          )}
        </div>
      </header>
      {table ? (
        <div className="viz-table">
          <table>
            <thead><tr>{view.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {view.rows.slice(0, 200).map((r, i) => (
                <tr key={i}>{r.map((v, j) => <td key={j}>{typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ChartBody chart={chart} />
      )}
    </article>
  );
}
