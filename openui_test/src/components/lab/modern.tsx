"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { hierarchy, partition, type HierarchyRectangularNode } from "d3-hierarchy";
import { arc as arcPath, area, curveCatmullRom, lineRadial, curveLinearClosed, stack, stackOffsetWiggle, stackOrderInsideOut } from "d3-shape";
import { scaleLinear } from "d3-scale";

import {
  isFocus,
  matches,
  money,
  series,
  Tip,
  useReveal,
  type Dim,
  type Driver,
  type Focus,
  type Point,
  type Segment,
  type StreamData,
} from "@/components/lab/shared";

/**
 * The segments-and-drivers and modern views of the Analytics lab: an auto-written
 * briefing, k-means segment galaxy, key-driver rings, industry radar,
 * beeswarm distribution, zoomable sunburst, revenue streamgraph and a
 * what-if scenario planner. All numbers come from MongoDB via
 * backend/analytics.py; nothing is model-generated.
 */

type ViewProps = { points: Point[]; focus: Focus; onFocus: (dim: Dim, name: string) => void; visible: boolean };

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Smoothly tweens to each new value (used by the scenario planner). */
function useTween(value: number, duration = 520) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (reducedMotion()) {
      const id = requestAnimationFrame(() => setShown(value));
      from.current = value;
      return () => cancelAnimationFrame(id);
    }
    const start = from.current;
    const begin = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - begin) / duration);
      const v = start + (value - start) * (1 - Math.pow(1 - t, 3));
      from.current = v;
      setShown(v);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return shown;
}

/* ------------------------------------------------------------------ Briefing */

/** Executive summary that writes itself in, word by word. */
export function Briefing({ text }: { text: string }) {
  const { ref, visible } = useReveal<HTMLElement>();
  const words = text.split(" ");
  return (
    <section ref={ref} className={`lab-brief ${visible ? "is-visible" : ""}`} aria-label="Executive briefing">
      <div className="lab-brief__orb" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div>
        <p className="lab-brief__eyebrow">Executive briefing · written from live data</p>
        <p className="lab-brief__text">
          {words.map((word, i) => (
            <span key={i} style={{ animationDelay: `${i * 28}ms` }}>
              {word}{" "}
            </span>
          ))}
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ Segment galaxy */

type Star = SimulationNodeDatum & { i: number; r: number; seg: number; tx: number; ty: number };

/** k-means segments as clusters of companies (dot area = spend). */
export function SegmentGalaxy({ segments, points, focus, onFocus, visible }: ViewProps & { segments: Segment[] }) {
  const width = 960;
  const height = 460;
  const [hover, setHover] = useState<number | null>(null);
  const names = useMemo(() => segments.map((s) => s.name), [segments]);
  const centres = useMemo(
    () =>
      segments.map((_, i) => {
        const angle = (i / segments.length) * Math.PI * 2 - Math.PI / 2 + Math.PI / segments.length;
        return { x: width / 2 + Math.cos(angle) * 270, y: height / 2 + Math.sin(angle) * 120 };
      }),
    [segments],
  );

  const stars = useMemo(() => {
    const max = Math.max(...points.map((p) => p.spend), 1);
    const nodes: Star[] = points.map((p, i) => {
      const seg = Math.max(0, names.indexOf(p.segment));
      return { i, seg, r: 2 + Math.sqrt(p.spend / max) * 13, tx: centres[seg].x, ty: centres[seg].y, x: centres[seg].x + Math.cos(i) * 20, y: centres[seg].y + Math.sin(i) * 20 };
    });
    const sim = forceSimulation(nodes)
      .force("x", forceX<Star>((d) => d.tx).strength(0.12))
      .force("y", forceY<Star>((d) => d.ty).strength(0.12))
      .force("collide", forceCollide<Star>((d) => d.r + 0.8).iterations(2))
      .stop();
    for (let t = 0; t < 220; t++) sim.tick();
    return nodes;
  }, [points, names, centres]);

  const active = hover != null ? stars[hover] : null;
  const total = segments.reduce((s, x) => s + x.spend, 0) || 1;

  return (
    <div className="lab-galaxy">
      <div className="lab-chart">
        <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-galaxy__svg ${visible ? "is-in" : ""}`} role="img" aria-label="Company segments found by clustering">
          {centres.map((c, i) => (
            <circle key={`halo-${i}`} cx={c.x} cy={c.y} r={120} className="lab-galaxy__halo" style={{ fill: series(i) }} />
          ))}
          {stars.map((s) => {
            const p = points[s.i];
            const on = matches(p, focus);
            return (
              <circle
                key={s.i}
                className={`lab-star ${on ? "" : "is-dim"}`}
                r={hover === s.i ? s.r + 3 : s.r}
                style={{
                  fill: series(s.seg),
                  transform: visible ? `translate(${s.x}px, ${s.y}px)` : `translate(${width / 2}px, ${height / 2}px) scale(0)`,
                  transitionDelay: `${(s.i % 100) * 9}ms`,
                }}
                onPointerEnter={() => setHover(s.i)}
                onPointerLeave={() => setHover(null)}
                onClick={() => onFocus("segment", p.segment)}
              />
            );
          })}
          {segments.map((seg, i) => (
            <g key={seg.name} className={`lab-galaxy__label ${isFocus(focus, "segment", seg.name) ? "is-active" : ""}`} transform={`translate(${centres[i].x},${centres[i].y + (centres[i].y < height / 2 ? -110 : 118)})`} onClick={() => onFocus("segment", seg.name)}>
              <text textAnchor="middle" className="lab-galaxy__name" style={{ fill: series(i) }}>
                {seg.name}
              </text>
              <text y={16} textAnchor="middle" className="lab-galaxy__meta">
                {seg.companies} companies · {((seg.spend / total) * 100).toFixed(0)}% of spend
              </text>
            </g>
          ))}
        </svg>
        {active && (
          <Tip x={((active.x ?? 0) / width) * 100} y={((active.y ?? 0) / height) * 100}>
            <b>{points[active.i].name}</b>
            <span>{points[active.i].segment}</span>
            <span>
              {points[active.i].employees.toLocaleString()} employees · {money(points[active.i].spend)}
            </span>
          </Tip>
        )}
      </div>
      <ol className="lab-segments">
        {segments.map((seg, i) => (
          <li key={seg.name}>
            <button type="button" className={`lab-segment ${isFocus(focus, "segment", seg.name) ? "is-active" : ""}`} style={{ ["--seg" as string]: series(i), animationDelay: `${i * 90}ms` }} onClick={() => onFocus("segment", seg.name)}>
              <span className="lab-segment__name">{seg.name}</span>
              <span className="lab-segment__share">
                <i style={{ width: visible ? `${(seg.spend / total) * 100}%` : 0 }} />
              </span>
              <span className="lab-segment__stats">
                <span>
                  <b>{seg.companies}</b> companies
                </span>
                <span>
                  <b>{money(seg.avg_spend)}</b> avg
                </span>
                <span>
                  <b>${seg.per_employee.toFixed(0)}</b>/employee
                </span>
                <span>
                  mostly <b>{seg.top_industry}</b>
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ Key drivers */

/** Concentric rings: how much of the variation each factor explains. */
const SPEND_TARGETS = { spend: "Total spend", intensity: "Spend per employee" };
const SPEND_NOTE = "Share of the variation each factor explains on its own (η² for categories, r² for size). Rings are scaled to the strongest factor.";

export function DriverRings({
  drivers,
  visible,
  targets = SPEND_TARGETS,
  note = SPEND_NOTE,
}: {
  drivers: Record<string, Driver[]>;
  visible: boolean;
  targets?: Record<string, string>;
  note?: string;
}) {
  const [target, setTarget] = useState(Object.keys(targets)[0]);
  const rows = drivers[target] ?? [];
  const max = Math.max(...rows.map((r) => r.score), 1e-6);
  const size = 340;
  const ring = 18;
  const gap = 7;
  const outer = size / 2 - 8;
  return (
    <div className="lab-drivers">
      <div className="qc-segmented" role="tablist">
        {Object.entries(targets).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={target === t} className={target === t ? "is-active" : ""} onClick={() => setTarget(t)}>
            {label}
          </button>
        ))}
      </div>
      <div className="lab-drivers__body">
        <svg viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className={`lab-svg lab-rings ${visible ? "is-in" : ""}`} role="img" aria-label="Variance explained by each factor">
          {rows.map((row, i) => {
            const r = outer - i * (ring + gap) - ring / 2;
            const sweep = (row.score / max) * 1.5 * Math.PI;
            const d = arcPath()({ innerRadius: r - ring / 2, outerRadius: r + ring / 2, startAngle: 0, endAngle: Math.max(0.02, sweep), cornerRadius: ring / 2 } as never) ?? "";
            return (
              <g key={`${target}-${row.factor}`}>
                <circle r={r} className="lab-rings__track" style={{ strokeWidth: ring }} />
                <path d={d} className="lab-rings__arc" style={{ fill: series(i), animationDelay: `${i * 110}ms` }} />
              </g>
            );
          })}
        </svg>
        <ol className="lab-drivers__list">
          {rows.map((row, i) => (
            <li key={row.factor} style={{ animationDelay: `${i * 80}ms` }}>
              <i style={{ background: series(i) }} />
              <span>{row.factor}</span>
              <b>{(row.score * 100).toFixed(row.score < 0.1 ? 1 : 0)}%</b>
            </li>
          ))}
        </ol>
      </div>
      <p className="lab-note">{note}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ Industry radar */

const RADAR_AXES = ["Avg spend", "Per employee", "Company size", "Tool variety", "Hybrid share", "Companies"] as const;

/** Profiles of up to four industries on six normalised measures; shapes morph when the selection changes. */
export function IndustryRadar({ points, focus, onFocus, visible }: ViewProps) {
  const profiles = useMemo(() => {
    const by = new Map<string, Point[]>();
    for (const p of points) by.set(p.industry, [...(by.get(p.industry) ?? []), p]);
    const raw = [...by.entries()].map(([name, ps]) => {
      const spend = ps.reduce((s, p) => s + p.spend, 0);
      const emp = ps.reduce((s, p) => s + p.employees, 0);
      return {
        name,
        values: [spend / ps.length, spend / emp, emp / ps.length, new Set(ps.map((p) => p.technology)).size, ps.filter((p) => p.deployment === "Hybrid").length / ps.length, ps.length],
        spend,
      };
    });
    const max = RADAR_AXES.map((_, k) => Math.max(...raw.map((r) => r.values[k])) || 1);
    const min = RADAR_AXES.map((_, k) => Math.min(...raw.map((r) => r.values[k])));
    return raw
      .map((r) => ({ ...r, norm: r.values.map((v, k) => 0.15 + 0.85 * ((v - min[k]) / (max[k] - min[k] || 1))) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [points]);
  const defaults = useMemo(() => [...profiles].sort((a, b) => b.spend - a.spend).slice(0, 3).map((p) => p.name), [profiles]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const chosen = picked ?? (focus?.dim === "industry" ? [focus.name, ...defaults.filter((d) => d !== focus.name)].slice(0, 3) : defaults);

  const size = 380;
  const R = size / 2 - 58;
  const angle = (k: number) => (k / RADAR_AXES.length) * Math.PI * 2;
  const shape = lineRadial<number>().angle((_, k) => angle(k)).radius((v) => v * R).curve(curveLinearClosed);
  const toggle = (name: string) => {
    const next = chosen.includes(name) ? chosen.filter((n) => n !== name) : [...chosen, name].slice(-4);
    setPicked(next.length ? next : chosen);
  };

  return (
    <div className="lab-radar">
      <svg viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className={`lab-svg lab-radar__svg ${visible ? "is-in" : ""}`} role="img" aria-label="Industry profiles">
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <path key={t} d={shape(RADAR_AXES.map(() => t)) ?? ""} className="lab-radar__grid" />
        ))}
        {RADAR_AXES.map((axis, k) => {
          const x = Math.sin(angle(k)) * (R + 22);
          const y = -Math.cos(angle(k)) * (R + 22);
          return (
            <g key={axis}>
              <line x1={0} y1={0} x2={Math.sin(angle(k)) * R} y2={-Math.cos(angle(k)) * R} className="lab-radar__spoke" />
              <text x={x} y={y} dy="0.35em" textAnchor={Math.abs(x) < 10 ? "middle" : x > 0 ? "start" : "end"} className="lab-axis">
                {axis}
              </text>
            </g>
          );
        })}
        {profiles.map((p, i) =>
          chosen.includes(p.name) ? (
            <path key={p.name} className="lab-radar__shape" style={{ d: `path("${shape(p.norm)}")`, fill: series(i), stroke: series(i) } as React.CSSProperties} />
          ) : null,
        )}
      </svg>
      <div className="lab-radar__chips">
        {profiles.map((p, i) => (
          <button
            key={p.name}
            type="button"
            className={`lab-pill ${chosen.includes(p.name) ? "is-on" : ""}`}
            style={{ ["--pill" as string]: series(i) }}
            onClick={() => toggle(p.name)}
            onDoubleClick={() => onFocus("industry", p.name)}
            title="Click to compare · double-click to focus every chart"
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Beeswarm */

type Bee = SimulationNodeDatum & { i: number; tx: number; ty: number };

/** Every company as a dot on spend-per-employee, one lane per segment or deployment model. */
export function SpendBeeswarm({ points, focus, visible, segments }: Omit<ViewProps, "onFocus"> & { segments: string[] }) {
  const [by, setBy] = useState<"segment" | "deployment">("segment");
  const [hover, setHover] = useState<number | null>(null);
  const lanes = useMemo(() => (by === "segment" ? segments : [...new Set(points.map((p) => p.deployment))].sort()), [by, points, segments]);
  const width = 960;
  const lane = 92;
  const pad = { left: 190, right: 24, top: 18, bottom: 34 };
  const height = pad.top + lane * lanes.length + pad.bottom;
  const x = useMemo(() => {
    const values = points.map((p) => p.spend / p.employees);
    return scaleLinear().domain([Math.min(...values) * 0.95, Math.max(...values) * 1.03]).range([pad.left, width - pad.right]);
  }, [points, pad.left, pad.right]);

  const bees = useMemo(() => {
    const nodes: Bee[] = points.map((p, i) => {
      const ty = pad.top + lane * lanes.indexOf(p[by]) + lane / 2;
      return { i, tx: x(p.spend / p.employees), ty, x: x(p.spend / p.employees), y: ty };
    });
    const sim = forceSimulation(nodes)
      .force("x", forceX<Bee>((d) => d.tx).strength(1))
      .force("y", forceY<Bee>((d) => d.ty).strength(0.06))
      .force("collide", forceCollide<Bee>(3.3))
      .stop();
    for (let t = 0; t < 140; t++) sim.tick();
    return nodes;
  }, [points, lanes, by, x, pad.top]);

  const medians = lanes.map((name) => {
    const vs = points.filter((p) => p[by] === name).map((p) => p.spend / p.employees).sort((a, b) => a - b);
    return vs.length ? vs[Math.floor(vs.length / 2)] : 0;
  });
  const hovered = hover != null ? bees[hover] : null;

  return (
    <div className="lab-chart">
      <div className="qc-segmented lab-chart__toggle" role="tablist">
        {(["segment", "deployment"] as const).map((b) => (
          <button key={b} type="button" role="tab" aria-selected={by === b} className={by === b ? "is-active" : ""} onClick={() => setBy(b)}>
            By {b}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-swarm ${visible ? "is-in" : ""}`} role="img" aria-label="Spend per employee for every company">
        {x.ticks(6).map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={pad.top} y2={height - pad.bottom} className="lab-gridline" />
            <text x={x(t)} y={height - 12} textAnchor="middle" className="lab-axis">
              ${t}
            </text>
          </g>
        ))}
        {lanes.map((name, k) => (
          <g key={name}>
            <text x={pad.left - 16} y={pad.top + lane * k + lane / 2} dy="0.35em" textAnchor="end" className="lab-swarm__lane">
              {name}
            </text>
            <line x1={x(medians[k])} x2={x(medians[k])} y1={pad.top + lane * k + 8} y2={pad.top + lane * (k + 1) - 8} className="lab-swarm__median" />
          </g>
        ))}
        {bees.map((b) => {
          const p = points[b.i];
          return (
            <circle
              key={`${by}-${b.i}`}
              cx={b.x}
              cy={b.y}
              r={hover === b.i ? 5.5 : 3}
              className={`lab-bee ${matches(p, focus) ? "" : "is-dim"}`}
              style={{ fill: series(segments.indexOf(p.segment)), animationDelay: `${((b.x ?? 0) / width) * 900}ms` }}
              onPointerEnter={() => setHover(b.i)}
              onPointerLeave={() => setHover(null)}
            />
          );
        })}
      </svg>
      {hovered && (
        <Tip x={((hovered.x ?? 0) / width) * 100} y={((hovered.y ?? 0) / height) * 100}>
          <b>{points[hovered.i].name}</b>
          <span>${(points[hovered.i].spend / points[hovered.i].employees).toFixed(2)} per employee</span>
          <span>
            {points[hovered.i].industry} · {points[hovered.i].deployment}
          </span>
        </Tip>
      )}
      <div className="lab-legend">
        <span>Each dot is a company · colour = segment · white tick = median</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Sunburst */

type SNode = { name: string; value?: number; children?: SNode[] };
type Rect = { x0: number; x1: number; y0: number; y1: number };

/** Category → HR tool → deployment, sized by spend. Click to zoom in, centre to zoom out. */
export function SpendSunburst({ points, focus, onFocus, visible }: ViewProps) {
  const size = 520;
  const R = size / 2 - 6;
  const root = useMemo(() => {
    const tree = new Map<string, Map<string, Map<string, number>>>();
    for (const p of points) {
      const cat = tree.get(p.category) ?? new Map();
      const tool = cat.get(p.technology) ?? new Map();
      tool.set(p.deployment, (tool.get(p.deployment) ?? 0) + p.spend);
      cat.set(p.technology, tool);
      tree.set(p.category, cat);
    }
    const data: SNode = {
      name: "All spend",
      children: [...tree.entries()].map(([cat, tools]) => ({
        name: cat,
        children: [...tools.entries()].map(([tool, deps]) => ({ name: tool, children: [...deps.entries()].map(([d, v]) => ({ name: d, value: v })) })),
      })),
    };
    const h = hierarchy<SNode>(data)
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return partition<SNode>().size([2 * Math.PI, h.height + 1])(h);
  }, [points]);

  const categories = useMemo(() => (root.children ?? []).map((c) => c.data.name).sort(), [root]);
  const [zoom, setZoom] = useState<HierarchyRectangularNode<SNode>>(root);
  const [arcs, setArcs] = useState(() => new Map<HierarchyRectangularNode<SNode>, Rect>());
  const current = useRef(new Map<HierarchyRectangularNode<SNode>, Rect>());
  const [hover, setHover] = useState<HierarchyRectangularNode<SNode> | null>(null);

  const targetOf = (d: HierarchyRectangularNode<SNode>, p: HierarchyRectangularNode<SNode>): Rect => ({
    x0: Math.max(0, Math.min(1, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
    x1: Math.max(0, Math.min(1, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
    y0: Math.max(0, d.y0 - p.depth),
    y1: Math.max(0, d.y1 - p.depth),
  });

  // Tween every arc from where it is to its place under the new zoom root.
  useEffect(() => {
    const nodes = root.descendants();
    const from = new Map(nodes.map((d) => [d, current.current.get(d) ?? { ...targetOf(d, zoom), x1: targetOf(d, zoom).x0 }]));
    const to = new Map(nodes.map((d) => [d, targetOf(d, zoom)]));
    const begin = performance.now();
    const duration = reducedMotion() ? 1 : 800;
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - begin) / duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      for (const d of nodes) {
        const a = from.get(d)!;
        const b = to.get(d)!;
        current.current.set(d, { x0: a.x0 + (b.x0 - a.x0) * e, x1: a.x1 + (b.x1 - a.x1) * e, y0: a.y0 + (b.y0 - a.y0) * e, y1: a.y1 + (b.y1 - a.y1) * e });
      }
      setArcs(new Map(current.current));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    if (visible) frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [zoom, root, visible]);

  const ringW = R / 4;
  const arcGen = arcPath<Rect>()
    .startAngle((d) => d.x0)
    .endAngle((d) => d.x1)
    .padAngle((d) => Math.min((d.x1 - d.x0) / 2, 0.006))
    .padRadius(R / 2)
    .innerRadius((d) => d.y0 * ringW)
    .outerRadius((d) => Math.max(d.y0 * ringW, d.y1 * ringW - 1.5))
    .cornerRadius(3);
  const colourOf = (d: HierarchyRectangularNode<SNode>) => {
    let top = d;
    while (top.depth > 1 && top.parent) top = top.parent;
    return series(categories.indexOf(top.data.name));
  };
  const dimOf = (d: HierarchyRectangularNode<SNode>) => (d.depth === 1 ? "category" : d.depth === 2 ? "technology" : "deployment") as Dim;
  const inFocus = (d: HierarchyRectangularNode<SNode>) => {
    if (!focus) return true;
    return d.ancestors().some((a) => a.depth > 0 && dimOf(a) === focus.dim && a.data.name === focus.name) || d.leaves().some((l) => l.ancestors().some((a) => a.depth > 0 && dimOf(a) === focus.dim && a.data.name === focus.name));
  };
  const centre = hover ?? zoom;

  return (
    <div className="lab-chart">
      <svg viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className={`lab-svg lab-sunburst ${visible ? "is-in" : ""}`} role="img" aria-label="Spend by technology category, tool and deployment">
        {root.descendants().slice(1).map((d) => {
          const c = arcs.get(d);
          if (!c || c.y1 > 4 || c.y0 < 1 || c.x1 - c.x0 < 0.0005) return null;
          const mid = (c.x0 + c.x1) / 2;
          const rad = ((c.y0 + c.y1) / 2) * ringW;
          const showLabel = (c.x1 - c.x0) * rad > 46;
          const rot = (mid * 180) / Math.PI - 90;
          return (
            <g key={d.ancestors().map((a) => a.data.name).join("/")}>
              <path
                d={arcGen(c) ?? ""}
                className={`lab-sun__arc ${inFocus(d) ? "" : "is-dim"}`}
                style={{ fill: colourOf(d), fillOpacity: d.depth === 1 ? 0.95 : d.depth === 2 ? 0.7 : 0.45 }}
                onPointerEnter={() => setHover(d)}
                onPointerLeave={() => setHover(null)}
                onClick={() => {
                  if (d.children) setZoom(d);
                  if (d.depth >= 2) onFocus(dimOf(d), d.data.name);
                }}
              />
              {showLabel && (
                <text transform={`rotate(${rot}) translate(${rad},0) rotate(${mid > Math.PI ? 180 : 0})`} dy="0.35em" textAnchor="middle" className="lab-sun__label">
                  {d.data.name.length > 14 ? `${d.data.name.slice(0, 13)}…` : d.data.name}
                </text>
              )}
            </g>
          );
        })}
        <circle r={ringW - 4} className="lab-sun__centre" onClick={() => setZoom(zoom.parent ?? root)} />
        <text y={-6} textAnchor="middle" className="lab-chord__center">
          {money(centre.value ?? 0)}
        </text>
        <text y={14} textAnchor="middle" className="lab-chord__sub">
          {centre.data.name.length > 18 ? `${centre.data.name.slice(0, 17)}…` : centre.data.name}
        </text>
        {zoom !== root && (
          <text y={32} textAnchor="middle" className="lab-sun__back">
            ← click to zoom out
          </text>
        )}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ Streamgraph */

/** Monthly revenue by product category as flowing layers. */
export function RevenueStream({ data, visible }: { data: StreamData; visible: boolean }) {
  const width = 960;
  const height = 320;
  const pad = { top: 16, right: 18, bottom: 30, left: 18 };
  const [hover, setHover] = useState<number | null>(null);
  const [solo, setSolo] = useState<string | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const rows = data.months.map((m) => Object.fromEntries(data.categories.map((c) => [c, Number(m[c] ?? 0)]))) as Record<string, number>[];
  const layers = stack<Record<string, number>>().keys(data.categories).offset(stackOffsetWiggle).order(stackOrderInsideOut)(rows);
  const lo = Math.min(...layers.flatMap((l) => l.map((d) => d[0])));
  const hi = Math.max(...layers.flatMap((l) => l.map((d) => d[1])));
  const x = scaleLinear().domain([0, data.months.length - 1]).range([pad.left, width - pad.right]);
  const y = scaleLinear().domain([lo, hi]).range([height - pad.bottom, pad.top]);
  const shape = area<[number, number]>().x((_, i) => x(i)).y0((d) => y(d[0])).y1((d) => y(d[1])).curve(curveCatmullRom);
  const point = hover != null ? data.months[hover] : null;

  return (
    <div className="lab-chart">
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        className={`lab-svg lab-stream ${visible ? "is-in" : ""}`}
        onPointerMove={(e) => {
          const box = ref.current?.getBoundingClientRect();
          if (box) setHover(Math.max(0, Math.min(data.months.length - 1, Math.round(x.invert(((e.clientX - box.left) / box.width) * width)))));
        }}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="Monthly revenue by product category"
      >
        <defs>
          <clipPath id="lab-stream-clip">
            <rect x={0} y={0} height={height} className="lab-stream__wipe" />
          </clipPath>
        </defs>
        <g clipPath="url(#lab-stream-clip)">
          {layers.map((layer) => {
            const k = data.categories.indexOf(layer.key);
            return (
              <path
                key={layer.key}
                d={shape(layer.map((d) => [d[0], d[1]] as [number, number])) ?? ""}
                className={`lab-stream__layer ${solo && solo !== layer.key ? "is-dim" : ""}`}
                style={{ fill: series(k) }}
                onClick={() => setSolo((s) => (s === layer.key ? null : layer.key))}
              />
            );
          })}
        </g>
        {data.months.map((m, i) => (
          <text key={m.label} x={x(i)} y={height - 8} textAnchor="middle" className="lab-axis">
            {String(m.label).slice(5)}
          </text>
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={height - pad.bottom} className="lab-cross" />}
      </svg>
      {point && hover != null && (
        <Tip x={(x(hover) / width) * 100} y={20}>
          <b>{point.label}</b>
          {data.categories.map((c, k) => (
            <span key={c} className="lab-tip__row">
              <i style={{ background: series(k) }} /> {c} <b>{money(Number(point[c] ?? 0))}</b>
            </span>
          ))}
        </Tip>
      )}
      <div className="lab-legend">
        {data.categories.map((c, k) => (
          <button key={c} type="button" className={`lab-legend__item ${solo === c ? "is-active" : ""}`} onClick={() => setSolo((s) => (s === c ? null : c))}>
            <i className="lab-legend__dot is-solid" style={{ background: series(k), borderColor: series(k) }} /> {c}
          </button>
        ))}
        <span>Layer thickness = revenue that month · click a layer to isolate it</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Scenario planner */

/**
 * What-if: grow headcount and change prices, see projected spend. Uses the
 * fitted size elasticity (spend ∝ employees^slope) from the regression.
 */
export function ScenarioPlanner({ points, slope, segments, focus }: { points: Point[]; slope: number; segments: Segment[]; focus: Focus }) {
  const [growth, setGrowth] = useState(10);
  const [price, setPrice] = useState(5);
  const scope = points.filter((p) => matches(p, focus));
  const factor = Math.pow(1 + growth / 100, slope) * (1 + price / 100);
  const today = scope.reduce((s, p) => s + p.spend, 0);
  const projected = today * factor;
  const change = factor - 1;
  const shownProjected = useTween(projected);
  const shownChange = useTween(change);
  const bySegment = segments.map((seg, i) => {
    const now = scope.filter((p) => p.segment === seg.name).reduce((s, p) => s + p.spend, 0);
    return { name: seg.name, now, next: now * factor, colour: series(i) };
  });
  const max = Math.max(1, ...bySegment.map((s) => Math.max(s.now, s.next)));
  // Gauge: −40% … +80% mapped onto a half circle.
  const gaugeT = Math.max(0, Math.min(1, (shownChange + 0.4) / 1.2));
  const needle = Math.PI * (gaugeT - 0.5);

  return (
    <div className="lab-scenario">
      <div className="lab-scenario__controls">
        <label className="lab-slider">
          <span>
            Headcount growth <b>{growth > 0 ? "+" : ""}{growth}%</b>
          </span>
          <input type="range" min={-20} max={50} value={growth} onChange={(e) => setGrowth(Number(e.target.value))} style={{ ["--fill" as string]: `${((growth + 20) / 70) * 100}%` }} />
        </label>
        <label className="lab-slider">
          <span>
            Vendor price change <b>{price > 0 ? "+" : ""}{price}%</b>
          </span>
          <input type="range" min={-15} max={30} value={price} onChange={(e) => setPrice(Number(e.target.value))} style={{ ["--fill" as string]: `${((price + 15) / 45) * 100}%` }} />
        </label>
        <p className="lab-note">
          Spend scales with headcount^{slope.toFixed(2)} (the fitted elasticity), then by the price change.
          {focus ? ` Applied to your focus (${scope.length} companies).` : ` Applied to all ${scope.length} companies.`}
        </p>
      </div>
      <div className="lab-scenario__result">
        <svg viewBox="-110 -100 220 120" className="lab-gauge" role="img" aria-label={`Projected change ${(change * 100).toFixed(1)} percent`}>
          <defs>
            <linearGradient id="lab-gauge-grad" x1="0" x2="1">
              <stop offset="0%" style={{ stopColor: "var(--qc-series-2)" }} />
              <stop offset="50%" style={{ stopColor: "var(--qc-series-1)" }} />
              <stop offset="100%" style={{ stopColor: "var(--qc-series-4)" }} />
            </linearGradient>
          </defs>
          <path d="M -90 0 A 90 90 0 0 1 90 0" className="lab-gauge__track" />
          <path d="M -90 0 A 90 90 0 0 1 90 0" className="lab-gauge__arc" pathLength={1} style={{ strokeDasharray: `${gaugeT} 1` }} />
          <line x1={0} y1={0} x2={Math.sin(needle) * 74} y2={-Math.cos(needle) * 74} className="lab-gauge__needle" />
          <circle r={6} className="lab-gauge__hub" />
          <text y={-28} textAnchor="middle" className="lab-gauge__value">
            {shownChange >= 0 ? "+" : ""}
            {(shownChange * 100).toFixed(1)}%
          </text>
        </svg>
        <div className="lab-scenario__numbers">
          <span>
            Today <b>{money(today)}</b>
          </span>
          <span className="is-big">
            Projected <b>{money(shownProjected)}</b>
          </span>
          <span>
            Difference <b>{projected - today >= 0 ? "+" : ""}{money(projected - today)}</b>
          </span>
        </div>
      </div>
      <ol className="lab-scenario__segments">
        {bySegment.map((s) => (
          <li key={s.name}>
            <span className="lab-scenario__seg-name">
              <i style={{ background: s.colour }} /> {s.name}
            </span>
            <span className="lab-scenario__bars">
              <span className="is-now" style={{ width: `${(s.now / max) * 100}%` }} />
              <span className="is-next" style={{ width: `${(s.next / max) * 100}%`, background: s.colour }} />
            </span>
            <b>{money(s.next)}</b>
          </li>
        ))}
      </ol>
    </div>
  );
}
