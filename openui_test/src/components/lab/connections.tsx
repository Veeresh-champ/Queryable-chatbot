"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { sankey, sankeyLinkHorizontal, type SankeyLink, type SankeyNode } from "d3-sankey";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { chord as chordLayout, ribbon as ribbonPath, type Chord, type ChordGroup } from "d3-chord";
import { arc as arcPath } from "d3-shape";

import {
  isFocus,
  matches,
  money,
  series,
  shade,
  Tip,
  type ChordData,
  type Dim,
  type FlowData,
  type Focus,
  type NetworkData,
  type Point,
} from "@/components/lab/shared";

type ViewProps = { points: Point[]; focus: Focus; onFocus: (dim: Dim, name: string) => void; visible: boolean };

const STAGE_DIM: Dim[] = ["country", "industry", "deployment"];
/** Each node gets its own hue; stages start at different points of the palette. */
const STAGE_OFFSET = [0, 3, 6];

/* ------------------------------------------------------------------ Sankey */

type FNode = { id: string; name: string; stage: number };
type FLink = { source: string; target: string; value: number; companies: number };

/** Country → Industry → Deployment spend flow with a live current along every link. */
export function FlowSankey({ data, points, focus, onFocus, visible }: ViewProps & { data: FlowData }) {
  const width = 960;
  const height = 470;
  const [hover, setHover] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: React.ReactNode } | null>(null);

  const graph = useMemo(() => {
    const layout = sankey<FNode, FLink>()
      .nodeId((d) => d.id)
      .nodeWidth(12)
      .nodePadding(11)
      .nodeSort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .extent([
        [150, 30],
        [width - 150, height - 8],
      ]);
    return layout({ nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) });
  }, [data]);

  const topCountries = useMemo(() => new Set(data.nodes.filter((n) => n.stage === 0).map((n) => n.name)), [data]);
  const bucket = (country: string) => (topCountries.has(country) ? country : "Other countries");

  // Share of every link that belongs to the focused slice (country, tool, …).
  const focusShare = useMemo(() => {
    if (!focus) return null;
    const share = new Map<string, number>();
    for (const p of points) {
      if (!matches(p, focus)) continue;
      const a = `c:${bucket(p.country)}|i:${p.industry}`;
      const b = `i:${p.industry}|d:${p.deployment}`;
      share.set(a, (share.get(a) ?? 0) + p.spend);
      share.set(b, (share.get(b) ?? 0) + p.spend);
    }
    return share;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, focus, topCountries]);

  const colour = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of [0, 1, 2]) {
      data.nodes.filter((n) => n.stage === stage).forEach((n, i) => map.set(n.id, n.name === "Other countries" ? "var(--qc-ink-3)" : series(i + STAGE_OFFSET[stage])));
    }
    return map;
  }, [data]);

  const path = sankeyLinkHorizontal();
  const nodeOf = (end: string | number | SankeyNode<FNode, FLink>) => end as SankeyNode<FNode, FLink>;
  const linked = (link: SankeyLink<FNode, FLink>) => hover && (nodeOf(link.source).id === hover || nodeOf(link.target).id === hover);

  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-sankey ${visible ? "is-in" : ""}`} role="img" aria-label="Spend flow from country to industry to deployment type">
        <defs>
          {graph.links.map((link, i) => {
            const s = nodeOf(link.source);
            const t = nodeOf(link.target);
            return (
              <linearGradient key={i} id={`lab-flow-${i}`} gradientUnits="userSpaceOnUse" x1={s.x1} x2={t.x0}>
                <stop offset="0%" style={{ stopColor: colour.get(s.id) }} />
                <stop offset="100%" style={{ stopColor: colour.get(t.id) }} />
              </linearGradient>
            );
          })}
        </defs>
        {data.stages.map((stage, i) => (
          <text key={stage} x={[150, width / 2, width - 150][i]} y={14} textAnchor={["start", "middle", "end"][i] as "start"} className="lab-stage">
            {stage}
          </text>
        ))}
        <g>
          {graph.links.map((link, i) => {
            const s = nodeOf(link.source);
            const t = nodeOf(link.target);
            const key = `${s.id}|${t.id}`;
            const d = path(link) ?? "";
            const w = Math.max(1, link.width ?? 1);
            const part = focusShare ? (focusShare.get(key) ?? 0) / link.value : null;
            const dim = (hover && !linked(link)) || (part != null && part === 0);
            return (
              <g key={key} className={`lab-link ${dim ? "is-dim" : ""} ${linked(link) ? "is-hot" : ""}`} style={{ animationDelay: `${(i % 30) * 18}ms` }}>
                <path
                  d={d}
                  className="lab-link__band"
                  style={{ strokeWidth: w, stroke: `url(#lab-flow-${i})` }}
                  onPointerMove={(e) => {
                    const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                    setTip({
                      x: ((e.clientX - box.left) / box.width) * 100,
                      y: ((e.clientY - box.top) / box.height) * 100,
                      text: (
                        <>
                          <b>
                            {s.name} → {t.name}
                          </b>
                          <span>
                            {money(link.value)} · {link.companies} companies
                          </span>
                          {part != null && <span>{(part * 100).toFixed(0)}% from your focus</span>}
                        </>
                      ),
                    });
                  }}
                  onPointerLeave={() => setTip(null)}
                />
                {part != null && part > 0 && <path d={d} className="lab-link__focus" style={{ strokeWidth: Math.max(1.5, w * part) }} />}
                <path d={d} className="lab-link__current" style={{ strokeWidth: Math.max(1, Math.min(w * 0.45, 6)), animationDuration: `${2.4 + (i % 5) * 0.35}s` }} />
              </g>
            );
          })}
        </g>
        <g>
          {graph.nodes.map((node) => {
            const x0 = node.x0 ?? 0;
            const x1 = node.x1 ?? 0;
            const y0 = node.y0 ?? 0;
            const y1 = node.y1 ?? 0;
            const dim = STAGE_DIM[node.stage];
            const active = isFocus(focus, dim, node.name);
            const left = node.stage === 0;
            const right = node.stage === 2;
            const clickable = node.name !== "Other countries";
            return (
              <g
                key={node.id}
                className={`lab-node ${active ? "is-active" : ""} ${clickable ? "is-clickable" : ""}`}
                onPointerEnter={() => setHover(node.id)}
                onPointerLeave={() => setHover(null)}
                onClick={() => clickable && onFocus(dim, node.name)}
              >
                <rect x={x0} y={y0} width={x1 - x0} height={Math.max(1, y1 - y0)} rx={3} style={{ fill: colour.get(node.id) }} />
                <text
                  x={left ? x0 - 8 : right ? x1 + 8 : x1 + 8}
                  y={(y0 + y1) / 2}
                  dy="0.35em"
                  textAnchor={left ? "end" : "start"}
                  className="lab-node__label"
                >
                  {node.name}
                  <tspan className="lab-node__value"> {money(node.value ?? 0)}</tspan>
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {tip && <Tip x={tip.x} y={tip.y}>{tip.text}</Tip>}
    </div>
  );
}

/* ------------------------------------------------------------------ Network */

type NNode = SimulationNodeDatum & NetworkData["nodes"][number] & { r: number };
type NLink = SimulationLinkDatum<NNode> & { companies: number; spend: number };

/** Force-directed industry ↔ HR tool adoption graph. Drag nodes; hover lights a neighbourhood. */
export function AdoptionNetwork({ data, points, focus, onFocus, visible }: ViewProps & { data: NetworkData }) {
  const width = 960;
  const height = 540;
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<Simulation<NNode, NLink> | null>(null);
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [model, setModel] = useState<{ nodes: NNode[]; links: NLink[] } | null>(null);
  const maxLink = useMemo(() => Math.max(1, ...data.links.map((l) => l.companies)), [data]);
  const hue = useMemo(() => {
    const map = new Map<string, string>();
    data.nodes.filter((n) => n.group === "industry").sort((a, b) => a.name.localeCompare(b.name)).forEach((n, i) => map.set(n.id, series(i)));
    return map;
  }, [data]);

  useEffect(() => {
    if (!visible) return;
    const maxCompanies = Math.max(1, ...data.nodes.map((n) => n.companies));
    const nodes: NNode[] = data.nodes.map((n, i) => ({
      ...n,
      r: 7 + Math.sqrt(n.companies / maxCompanies) * (n.group === "industry" ? 22 : 15),
      x: width / 2 + Math.cos(i) * 40,
      y: height / 2 + Math.sin(i) * 40,
    }));
    const links: NLink[] = data.links.map((l) => ({ ...l }));
    const sim = forceSimulation<NNode>(nodes)
      .force("link", forceLink<NNode, NLink>(links).id((d) => d.id).distance(130).strength((l) => 0.05 + (l.companies / maxLink) * 0.35))
      .force("charge", forceManyBody<NNode>().strength(-260))
      .force("collide", forceCollide<NNode>().radius((d) => d.r + 16))
      .force("x", forceX<NNode>((d) => (d.group === "industry" ? width * 0.38 : width * 0.62)).strength(0.06))
      .force("y", forceY<NNode>(height / 2).strength(0.08))
      .force("center", forceCenter(width / 2, height / 2))
      .alphaDecay(0.025)
      .on("tick", () => {
        for (const n of nodes) {
          n.x = Math.max(n.r + 4, Math.min(width - n.r - 4, n.x ?? 0));
          n.y = Math.max(n.r + 14, Math.min(height - n.r - 14, n.y ?? 0));
        }
        setTick((t) => t + 1);
      });
    simRef.current = sim;
    // The simulation owns these objects and mutates them each tick.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModel({ nodes, links });
    return () => {
      sim.stop();
    };
  }, [data, visible, maxLink]);

  // Nodes and links that belong to the focused slice.
  const lit = useMemo(() => {
    if (!focus) return null;
    const set = new Set<string>();
    for (const p of points) {
      if (!matches(p, focus)) continue;
      set.add(`i:${p.industry}`);
      set.add(`t:${p.technology}`);
      set.add(`i:${p.industry}|t:${p.technology}`);
    }
    return set;
  }, [points, focus]);

  const neighbours = useMemo(() => {
    if (!hover || !model) return null;
    const set = new Set([hover]);
    for (const l of model.links) {
      const s = (l.source as NNode).id;
      const t = (l.target as NNode).id;
      if (s === hover) set.add(t);
      if (t === hover) set.add(s);
    }
    return set;
  }, [hover, model]);

  const drag = (node: NNode) => (event: React.PointerEvent<SVGGElement>) => {
    const svg = svgRef.current;
    const sim = simRef.current;
    if (!svg || !sim) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const toLocal = (e: PointerEvent | React.PointerEvent) => {
      const box = svg.getBoundingClientRect();
      return [((e.clientX - box.left) / box.width) * width, ((e.clientY - box.top) / box.height) * height];
    };
    const start = toLocal(event);
    let moved = false;
    sim.alphaTarget(0.25).restart();
    const target = event.currentTarget;
    const move = (e: PointerEvent) => {
      const [x, y] = toLocal(e);
      if (Math.hypot(x - start[0], y - start[1]) > 3) moved = true;
      node.fx = x;
      node.fy = y;
    };
    const up = () => {
      sim.alphaTarget(0);
      node.fx = null;
      node.fy = null;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (!moved) onFocus(node.group === "industry" ? "industry" : "technology", node.name);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  return (
    <div className="lab-chart">
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-network ${visible ? "is-in" : ""}`} role="img" aria-label="Network of industries and the HR tools they use">
        {model?.links.map((l) => {
          const s = l.source as NNode;
          const t = l.target as NNode;
          const key = `${s.id}|${t.id}`;
          const on = neighbours ? neighbours.has(s.id) && neighbours.has(t.id) && (s.id === hover || t.id === hover) : lit ? lit.has(key) : true;
          const strength = l.companies / maxLink;
          return (
            <line
              key={key}
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
              className={`lab-edge ${on ? "" : "is-dim"} ${(neighbours || lit) && on ? "is-hot" : ""}`}
              style={{ strokeWidth: 0.6 + strength * 4, stroke: hue.get(s.id) ?? shade(strength) }}
            />
          );
        })}
        {model?.nodes.map((n, i) => {
          const on = neighbours ? neighbours.has(n.id) : lit ? lit.has(n.id) : true;
          const active = isFocus(focus, n.group === "industry" ? "industry" : "technology", n.name);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
              className={`lab-gnode lab-gnode--${n.group} ${on ? "" : "is-dim"} ${active ? "is-active" : ""}`}
              style={{ animationDelay: `${i * 35}ms` }}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover(null)}
              onPointerDown={drag(n)}
            >
              <circle r={n.r * 2.1} className="lab-gnode__glow" style={{ fill: hue.get(n.id) ?? "var(--qc-accent-2)" }} />
              <circle r={n.r} className="lab-gnode__dot" style={n.group === "industry" ? { fill: hue.get(n.id), stroke: hue.get(n.id) } : undefined} />
              <text y={n.r + 13} textAnchor="middle" className="lab-gnode__label">
                {n.name}
              </text>
              <title>{`${n.name}: ${n.companies} companies · ${money(n.spend)}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="lab-legend">
        <span>
          <i className="lab-legend__dot is-solid" /> Industry
        </span>
        <span>
          <i className="lab-legend__dot" /> HR tool
        </span>
        <span>Line colour = industry · weight = companies using the tool · drag any node</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Chord */

/** Country ↔ technology-category spend connections. */
export function ChordView({ data, focus, onFocus, visible }: Omit<ViewProps, "points"> & { data: ChordData }) {
  const size = 520;
  const outer = size / 2 - 78;
  const inner = outer - 14;
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: React.ReactNode } | null>(null);

  const chords = useMemo(() => chordLayout().padAngle(0.035).sortSubgroups((a, b) => b - a)(data.matrix), [data]);
  const arcGen = arcPath<ChordGroup>().innerRadius(inner).outerRadius(outer);
  const ribbonGen = ribbonPath<Chord, Chord["source"]>().radius(inner - 2);
  const countries = data.groups.filter((g) => g === "country").length;
  const focusIndex = focus && (focus.dim === "country" || focus.dim === "category") ? data.names.indexOf(focus.name) : -1;
  const active = hover ?? (focusIndex >= 0 ? focusIndex : null);
  const total = data.matrix.reduce((sum, row, i) => (i < countries ? sum + row.reduce((a, b) => a + b, 0) : sum), 0);

  return (
    <div className="lab-chart">
      <svg viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`} className={`lab-svg lab-chord ${visible ? "is-in" : ""}`} role="img" aria-label="Spend connections between countries and technology categories">
        <g className="lab-chord__spin">
          {chords.map((c, i) => {
            const on = active == null || c.source.index === active || c.target.index === active;
            const country = c.source.index < countries ? c.source.index : c.target.index;
            return (
              <path
                key={`${c.source.index}-${c.target.index}`}
                d={(ribbonGen(c) as unknown as string) ?? ""}
                className={`lab-ribbon ${on ? "" : "is-dim"}`}
                style={{ fill: series(country), animationDelay: `${i * 14}ms` }}
                onPointerMove={(e) => {
                  const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setTip({
                    x: ((e.clientX - box.left) / box.width) * 100,
                    y: ((e.clientY - box.top) / box.height) * 100,
                    text: (
                      <>
                        <b>
                          {data.names[c.source.index]} ↔ {data.names[c.target.index]}
                        </b>
                        <span>{money(c.source.value)}</span>
                      </>
                    ),
                  });
                }}
                onPointerLeave={() => setTip(null)}
              />
            );
          })}
          {chords.groups.map((g) => {
            const name = data.names[g.index];
            const isCountry = data.groups[g.index] === "country";
            const mid = (g.startAngle + g.endAngle) / 2;
            const flip = mid > Math.PI;
            return (
              <g
                key={name}
                className={`lab-arc ${active === g.index ? "is-active" : ""}`}
                onPointerEnter={() => setHover(g.index)}
                onPointerLeave={() => setHover(null)}
                onClick={() => onFocus(isCountry ? "country" : "category", name)}
              >
                <path d={arcGen(g) ?? ""} style={{ fill: isCountry ? series(g.index) : "var(--qc-ink-2)" }} />
                <text
                  transform={`rotate(${(mid * 180) / Math.PI - 90}) translate(${outer + 8}) ${flip ? "rotate(180)" : ""}`}
                  dy="0.35em"
                  textAnchor={flip ? "end" : "start"}
                  className={`lab-arc__label ${isCountry ? "" : "is-cat"}`}
                >
                  {name}
                </text>
                <title>{`${name}: ${money(g.value)} (${((g.value / total) * 100).toFixed(1)}%)`}</title>
              </g>
            );
          })}
        </g>
        <text y={-4} textAnchor="middle" className="lab-chord__center">
          {active != null ? money(chords.groups[active]?.value ?? 0) : money(total)}
        </text>
        <text y={14} textAnchor="middle" className="lab-chord__sub">
          {active != null ? data.names[active] : "connected spend"}
        </text>
      </svg>
      {tip && <Tip x={tip.x} y={tip.y}>{tip.text}</Tip>}
    </div>
  );
}
