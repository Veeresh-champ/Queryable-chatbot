"use client";

import { useMemo, useState } from "react";
import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { hierarchy, partition, type HierarchyRectangularNode } from "d3-hierarchy";
import { arc, area, curveBasis } from "d3-shape";

import { Tip, series } from "@/components/lab/shared";
import { formatValue, type ValueFormat } from "@/lib/geo";

/**
 * Deep-dive views for one dataset (backend/project_lab.py dataset_lab). They
 * work for any data: companies, employees, orders or sales. Each starts its
 * animation when the tile scrolls into view (`visible`).
 */

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/* ---------------------------------------------------------------- sunburst */

export type SunburstData = { name: string; outer: string; inner: string | null; children: { name: string; children: { name: string; value: number }[] }[] };
type SunNode = { name: string; value?: number; children?: SunNode[] };

export function Sunburst({ data, visible }: { data: SunburstData; visible: boolean }) {
  const [hover, setHover] = useState<HierarchyRectangularNode<SunNode> | null>(null);
  const R = 220;
  const nodes = useMemo(() => {
    const root = hierarchy<SunNode>(data).sum((d) => d.value ?? 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return partition<SunNode>().size([2 * Math.PI, R])(root).descendants().filter((d) => d.depth > 0);
  }, [data]);
  const total = nodes.filter((n) => n.depth === 1).reduce((s, n) => s + (n.value ?? 0), 0) || 1;
  const shape = arc<HierarchyRectangularNode<SunNode>>()
    .startAngle((d) => d.x0).endAngle((d) => d.x1).padAngle(0.006)
    .innerRadius((d) => (d.depth === 1 ? 70 : d.y0 + 8)).outerRadius((d) => (d.depth === 1 ? d.y1 - 4 : d.y1)).cornerRadius(3);
  const topIndex = (d: HierarchyRectangularNode<SunNode>) => {
    const top = d.depth === 1 ? d : d.parent!;
    return (top.parent?.children ?? []).indexOf(top);
  };
  return (
    <div className="lab-chart">
      <svg viewBox={`${-R - 10} ${-R - 10} ${2 * R + 20} ${2 * R + 20}`} role="img" aria-label={`${data.outer}${data.inner ? ` and ${data.inner}` : ""}`}>
        {nodes.map((d, i) => (
          <path key={`${d.depth}-${d.parent?.data.name}-${d.data.name}-${i}`} d={shape(d) ?? ""}
                fill={series(topIndex(d))} opacity={d.depth === 1 ? 0.92 : d.data.name === "Other" || d.data.name === "Not recorded" ? 0.3 : 0.6}
                className={`dlab-sun ${visible ? "is-on" : ""} ${hover && hover !== d && hover.parent !== d && d.parent !== hover ? "is-dim" : ""}`}
                style={{ animationDelay: `${d.depth * 250 + (d.x0 / (2 * Math.PI)) * 600}ms` }}
                onPointerEnter={() => setHover(d)} onPointerLeave={() => setHover(null)}>
            <title>{`${d.depth === 2 ? `${d.parent?.data.name} · ` : ""}${d.data.name}: ${(d.value ?? 0).toLocaleString()} (${pct((d.value ?? 0) / total)})`}</title>
          </path>
        ))}
        {nodes.filter((d) => d.depth === 1 && d.x1 - d.x0 > 0.28).map((d) => {
          const a = (d.x0 + d.x1) / 2 - Math.PI / 2;
          const r = (70 + d.y1) / 2;
          return (
            <text key={`l-${d.data.name}`} x={Math.cos(a) * r} y={Math.sin(a) * r} textAnchor="middle" dy="0.32em" className="dlab-sun__label">
              {short(d.data.name, 12)}
            </text>
          );
        })}
        <text textAnchor="middle" y={-4} className="plab-core__value" style={{ fontSize: 24 }}>
          {hover ? pct((hover.value ?? 0) / total) : total.toLocaleString()}
        </text>
        <text textAnchor="middle" y={16} className="plab-core__label">{hover ? short(hover.data.name, 18) : "records"}</text>
      </svg>
      <p className="plab-note">Inner ring: {data.outer}{data.inner ? ` · outer ring: ${data.inner}` : ""}. Hover a slice for its share.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- outcome rose */

export type OutcomeData = { field: string; positive: string; by: string; overall: number; rows: { label: string; n: number; rate: number }[] };

/** Nightingale rose: one petal per group, length = rate of the outcome; the ring is the overall rate. */
export function OutcomeRose({ data, visible }: { data: OutcomeData; visible: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const R = 200;
  const inner = 36;
  const max = Math.max(data.overall, ...data.rows.map((r) => r.rate)) || 1;
  const radius = (rate: number) => inner + Math.sqrt(rate / max) * (R - inner);
  const step = (2 * Math.PI) / data.rows.length;
  const petal = arc<{ i: number; rate: number }>()
    .innerRadius(inner).outerRadius((d) => radius(d.rate))
    .startAngle((d) => d.i * step).endAngle((d) => (d.i + 1) * step).padAngle(0.04).cornerRadius(6);
  const focus = hover != null ? data.rows[hover] : null;
  return (
    <div className="lab-chart">
      <svg viewBox={`${-R - 60} ${-R - 30} ${2 * R + 120} ${2 * R + 60}`} role="img" aria-label={`${data.field} rate by ${data.by}`}>
        <circle r={radius(data.overall)} className="dlab-rose__avg" />
        {data.rows.map((r, i) => {
          const above = r.rate >= data.overall;
          const mid = (i + 0.5) * step - Math.PI / 2;
          return (
            <g key={`${r.label}-${i}`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <path d={petal({ i, rate: r.rate }) ?? ""} fill={above ? "var(--viz-series-2)" : "var(--viz-series-1)"}
                    className={`dlab-petal ${visible ? "is-on" : ""} ${hover != null && hover !== i ? "is-dim" : ""}`}
                    style={{ animationDelay: `${i * 90}ms` }}>
                <title>{`${r.label}: ${pct(r.rate)} ${data.positive.toLowerCase()} (${r.n.toLocaleString()} records)`}</title>
              </path>
              <text x={Math.cos(mid) * (radius(r.rate) + 14)} y={Math.sin(mid) * (radius(r.rate) + 14)} dy="0.32em"
                    textAnchor={Math.cos(mid) > 0.2 ? "start" : Math.cos(mid) < -0.2 ? "end" : "middle"} className="dlab-rose__label">
                {short(r.label, 16)} {pct(r.rate)}
              </text>
            </g>
          );
        })}
        <text textAnchor="middle" y={-2} className="plab-core__value" style={{ fontSize: 20 }}>{pct(focus ? focus.rate : data.overall)}</text>
        <text textAnchor="middle" y={14} className="plab-core__label">{focus ? short(focus.label, 14) : "overall"}</text>
      </svg>
      <p className="plab-note">
        Share of records where <b>{data.field}</b> is <b>{data.positive}</b>, by {data.by}. The dashed ring is the overall rate ({pct(data.overall)});
        orange petals are above it, blue below.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- correlation web */

export type CorrelationData = { fields: string[]; links: { a: string; b: string; r: number; n: number }[] };

export function CorrelationWeb({ data, visible }: { data: CorrelationData; visible: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const R = 170;
  const pos = new Map(data.fields.map((f, i) => {
    const a = (i / data.fields.length) * Math.PI * 2 - Math.PI / 2;
    return [f, { x: Math.cos(a) * R, y: Math.sin(a) * R, a }];
  }));
  return (
    <div className="lab-chart">
      <svg viewBox={`${-R - 120} ${-R - 40} ${2 * R + 240} ${2 * R + 80}`} role="img" aria-label="How numeric fields move together">
        {data.links.map((l, i) => {
          const a = pos.get(l.a)!;
          const b = pos.get(l.b)!;
          const active = !hover || hover === l.a || hover === l.b;
          return (
            <path key={`${l.a}-${l.b}`} d={`M${a.x},${a.y} Q0,0 ${b.x},${b.y}`} className={`dlab-link ${visible ? "is-on" : ""}`}
                  stroke={l.r >= 0 ? "var(--viz-series-1)" : "var(--viz-series-2)"} strokeWidth={1 + Math.abs(l.r) * 7}
                  opacity={active ? 0.25 + Math.abs(l.r) * 0.7 : 0.05} style={{ animationDelay: `${i * 60}ms` }}>
              <title>{`${l.a} and ${l.b}: r = ${l.r.toFixed(2)} (${l.r >= 0 ? "rise together" : "move opposite"}; ${l.n} records)`}</title>
            </path>
          );
        })}
        {data.fields.map((f) => {
          const p = pos.get(f)!;
          const right = Math.cos(p.a) >= 0;
          return (
            <g key={f} onPointerEnter={() => setHover(f)} onPointerLeave={() => setHover(null)} className={`dlab-node ${visible ? "is-on" : ""}`}>
              <circle cx={p.x} cy={p.y} r={7} />
              <text x={p.x + (right ? 12 : -12)} y={p.y} dy="0.32em" textAnchor={right ? "start" : "end"} className="dlab-node__label">{short(f, 22)}</text>
            </g>
          );
        })}
      </svg>
      <p className="plab-note">Blue links rise together, orange move in opposite directions; thicker = stronger. Hover a field to isolate it.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- ridgelines */

export type RidgeData = { measure: string; by: string; log: boolean; ticks: number[]; groups: { label: string; n: number; median: number; position: number; density: number[] }[] };

export function Ridgelines({ data, visible, format = "number" }: { data: RidgeData; visible: boolean; format?: ValueFormat }) {
  const W = 680;
  const left = 140;
  const rowH = 46;
  const H = data.groups.length * rowH + 70;
  const x = (t: number) => left + t * (W - left - 20);
  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Distribution of ${data.measure} by ${data.by}`}>
        {data.groups.map((g, i) => {
          const base = 50 + (i + 1) * rowH;
          const bins = g.density.length;
          const shape = area<number>().x((_, k) => x(k / (bins - 1))).y0(base).y1((v) => base - v * rowH * 1.35).curve(curveBasis);
          return (
            <g key={`${g.label}-${i}`} className={`dlab-ridge ${visible ? "is-on" : ""}`} style={{ animationDelay: `${i * 120}ms` }}>
              <title>{`${g.label}: median ${formatValue(g.median, format)} (${g.n} records)`}</title>
              <path d={shape(g.density) ?? ""} fill={series(i)} fillOpacity={0.55} stroke={series(i)} strokeWidth={1.5} />
              <line x1={x(g.position)} x2={x(g.position)} y1={base} y2={base - rowH * 0.9} className="dlab-ridge__median" />
              <text x={left - 10} y={base - 6} textAnchor="end" className="viz-label">{short(g.label, 18)}</text>
            </g>
          );
        })}
        {data.ticks.map((t, i) => (
          <text key={i} x={x(i / (data.ticks.length - 1))} y={H - 6} textAnchor="middle" className="viz-axis">{formatValue(t, format)}</text>
        ))}
      </svg>
      <p className="plab-note">{data.measure}{data.log ? " (log scale)" : ""} by {data.by}: each wave is where the records sit; the line marks the median.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- time spiral */

export type SpiralData = { title: string; format: ValueFormat; rows: { label: string; value: number }[] };

/** Months wound around a spiral (one turn per year); dot size and colour = the month's value. */
export function TimeSpiral({ data, visible }: { data: SpiralData; visible: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const rows = data.rows;
  const max = Math.max(...rows.map((r) => r.value)) || 1;
  const turnR = (i: number) => 60 + (i / Math.max(1, rows.length - 1)) * 150;
  const angle = (i: number) => (i / 12) * Math.PI * 2 - Math.PI / 2;
  const pts = rows.map((r, i) => ({ x: Math.cos(angle(i)) * turnR(i), y: Math.sin(angle(i)) * turnR(i), r }));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
  const focus = hover != null ? rows[hover] : null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const firstMonth = Number(rows[0]?.label.slice(5, 7)) - 1 || 0;
  return (
    <div className="lab-chart">
      <svg viewBox="-250 -250 500 500" role="img" aria-label={data.title}>
        {months.map((m, k) => {
          const a = ((k - firstMonth) / 12) * Math.PI * 2 - Math.PI / 2;
          return <text key={m} x={Math.cos(a) * 232} y={Math.sin(a) * 232} dy="0.32em" textAnchor="middle" className="viz-axis">{m}</text>;
        })}
        <path d={path} className={`dlab-spiral ${visible ? "is-on" : ""}`} />
        {pts.map((p, i) => (
          <circle key={p.r.label} cx={p.x} cy={p.y} r={3 + (p.r.value / max) * 12} fill={series(Math.floor(i / 12))}
                  className={`dlab-spiral__dot ${visible ? "is-on" : ""}`} style={{ animationDelay: `${300 + i * 40}ms` }}
                  onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <title>{`${p.r.label}: ${formatValue(p.r.value, data.format)}`}</title>
          </circle>
        ))}
        <text textAnchor="middle" y={-4} className="plab-core__value" style={{ fontSize: 20 }}>
          {focus ? formatValue(focus.value, data.format) : rows.length}
        </text>
        <text textAnchor="middle" y={14} className="plab-core__label">{focus ? focus.label : "months"}</text>
      </svg>
      <p className="plab-note">{data.title}: one turn per year, starting in {rows[0]?.label}. Bigger dots are bigger months; each year has its own colour.</p>
    </div>
  );
}

/* ---------------------------------------------------------------- record swarm */

export type SwarmData = { by: string; measure: string | null; groups: string[]; dots: { id: number; group: string; size: number | null; name: string | null; value: number | null }[]; truncated: boolean };
type SwarmNode = SimulationNodeDatum & { d: SwarmData["dots"][number]; g: number; r: number; tx: number };

/** Every record as a particle, swarming into its group's lane; size = its measure percentile. */
export function RecordSwarm({ data, visible }: { data: SwarmData; visible: boolean }) {
  const [hover, setHover] = useState<SwarmNode | null>(null);
  const W = 720;
  const H = 360;
  const nodes = useMemo(() => {
    const lane = (g: number) => 70 + (g + 0.5) * ((W - 90) / data.groups.length);
    const list: SwarmNode[] = data.dots.map((d, i) => {
      const g = Math.max(0, data.groups.indexOf(d.group));
      return { d, g, r: 2 + (d.size ?? 0.3) * 5, tx: lane(g), x: lane(g) + Math.cos(i * 7.1) * 10, y: H / 2 + Math.sin(i * 3.7) * 10 };
    });
    const sim = forceSimulation(list)
      .force("x", forceX<SwarmNode>((n) => n.tx).strength(0.12))
      .force("y", forceY<SwarmNode>(H / 2).strength(0.035))
      .force("collide", forceCollide<SwarmNode>((n) => n.r + 0.8))
      .stop();
    for (let i = 0; i < 200; i += 1) sim.tick();
    return { list, lane };
  }, [data]);
  return (
    <div className="lab-chart" onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Records by ${data.by}`}>
        {data.groups.map((g, i) => (
          <text key={g} x={nodes.lane(i)} y={22} textAnchor="middle" className="viz-label">
            {short(g, 14)} · {data.dots.filter((d) => d.group === g).length}
          </text>
        ))}
        {nodes.list.map((n, i) => (
          <circle key={n.d.id} r={n.r} fill={n.d.group === "Other" ? "var(--qc-neutral-mark)" : series(n.g)}
                  className={`plab-bubble ${visible ? "is-on" : ""}`}
                  style={{ ["--from" as string]: `translate(${W / 2}px, ${H + 40}px)`, ["--to" as string]: `translate(${n.x}px, ${n.y}px)`,
                           animationDelay: `${(i % 150) * 8}ms` }}
                  onPointerEnter={() => setHover(n)} />
        ))}
      </svg>
      {hover && (
        <Tip x={((hover.x ?? 0) / W) * 100} y={((hover.y ?? 0) / H) * 100}>
          <b>{hover.d.name ?? hover.d.group}</b>
          <span>{data.by}: {hover.d.group}</span>
          {data.measure && <span>{hover.d.value != null ? `${data.measure}: ${formatValue(hover.d.value)}` : `${data.measure}: not recorded`}</span>}
        </Tip>
      )}
      <p className="plab-note">
        Every record as a dot in its {data.by} lane{data.measure ? `; bigger dots have a higher ${data.measure.toLowerCase()}` : ""}.
        {data.truncated ? " The first 900 records are shown." : ""}
      </p>
    </div>
  );
}
