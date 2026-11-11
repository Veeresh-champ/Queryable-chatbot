"use client";

import { useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { hierarchy, pack, treemap, treemapSquarify, type HierarchyCircularNode, type HierarchyRectangularNode } from "d3-hierarchy";

import { count, isFocus, money, series, type Dim, type Focus, type Point } from "@/components/lab/shared";

/**
 * Signature views for the SPAN lab: circle-packed company universe, spend
 * mosaic (Marimekko), country waterfall and tool landscape (treemap). Each
 * is computed in the browser from the same company rows as the other views
 * and carries a one-line insight derived from those numbers only.
 */

type ViewProps = { points: Point[]; focus: Focus; onFocus: (dim: Dim, name: string) => void; visible: boolean };
type Tip = { x: number; y: number; title: string; lines: string[] } | null;

const pct = (v: number, digits = 0) => `${(v * 100).toFixed(digits)}%`;

function sumBy<K extends string>(points: Point[], key: (p: Point) => K) {
  const out = new Map<K, { spend: number; companies: number; employees: number }>();
  for (const p of points) {
    const k = key(p);
    const row = out.get(k) ?? { spend: 0, companies: 0, employees: 0 };
    row.spend += p.spend;
    row.companies += 1;
    row.employees += p.employees;
    out.set(k, row);
  }
  return [...out.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.spend - a.spend);
}

/** Top n groups by spend plus one "Other" bucket, so a view never turns into confetti. */
function topWithOther<T extends { name: string; spend: number; companies: number; employees: number }>(rows: T[], n: number) {
  if (rows.length <= n) return rows.map((r) => ({ ...r }));
  const head = rows.slice(0, n - 1).map((r) => ({ ...r }));
  const rest = rows.slice(n - 1);
  head.push({
    ...rest[0],
    name: "Other",
    spend: rest.reduce((s, r) => s + r.spend, 0),
    companies: rest.reduce((s, r) => s + r.companies, 0),
    employees: rest.reduce((s, r) => s + r.employees, 0),
  });
  return head;
}

function Insight({ children }: { children: React.ReactNode }) {
  return (
    <p className="sig-insight">
      <Sparkles size={13} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function TipBox({ tip, width, height }: { tip: Tip; width: number; height: number }) {
  if (!tip) return null;
  return (
    <div className="lab-tip" style={{ left: `${(tip.x / width) * 100}%`, top: `${(tip.y / height) * 100}%` }}>
      <b>{tip.title}</b>
      {tip.lines.map((l) => <span key={l}>{l}</span>)}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 1. Company universe: circle packing, industry → company             */
/* ------------------------------------------------------------------ */

type PackDatum = { name: string; industry?: string; point?: Point; children?: PackDatum[] };

export function CompanyUniverse({ points, focus, onFocus, visible }: ViewProps) {
  const size = 620;
  const [tip, setTip] = useState<Tip>(null);
  const { nodes, industries, total, biggest, topIndustry } = useMemo(() => {
    const byIndustry = sumBy(points, (p) => p.industry);
    const order = new Map(byIndustry.map((r, i) => [r.name, i]));
    const root: PackDatum = {
      name: "All companies",
      children: byIndustry.map((ind) => ({
        name: ind.name,
        children: points.filter((p) => p.industry === ind.name && p.spend > 0).map((p) => ({ name: p.name, industry: ind.name, point: p })),
      })),
    };
    const h = hierarchy<PackDatum>(root).sum((d) => (d.point ? Math.max(d.point.spend, 0) : 0)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const laid = pack<PackDatum>().size([size, size]).padding((d) => (d.depth === 0 ? 10 : 2.5))(h);
    const total = byIndustry.reduce((s, r) => s + r.spend, 0) || 1;
    const biggest = [...points].sort((a, b) => b.spend - a.spend)[0];
    return { nodes: laid.descendants() as HierarchyCircularNode<PackDatum>[], industries: order, total, biggest, topIndustry: byIndustry[0] };
  }, [points]);

  if (!points.length) return <p className="qc-muted">No companies to show.</p>;
  const active = focus?.dim === "industry" ? focus.name : null;

  return (
    <>
      <div className="sig-stage">
        <svg viewBox={`0 0 ${size} ${size}`} className={`lab-svg sig-universe ${visible ? "is-in" : ""}`} role="img"
             aria-label={`Circle packing of ${points.length} companies grouped by industry, sized by HR tech spend`}
             onPointerLeave={() => setTip(null)}>
          <defs>
            <radialGradient id="sig-orb" cx="35%" cy="30%" r="75%">
              <stop offset="0%" stopColor="#fff" stopOpacity="0.55" />
              <stop offset="60%" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
          </defs>
          {nodes.filter((n) => n.depth > 0).map((n, i) => {
            const industry = n.depth === 1 ? n.data.name : n.data.industry ?? "";
            const hue = series(industries.get(industry) ?? 0);
            const dim = active != null && industry !== active;
            if (n.depth === 1) {
              return (
                <g key={`ind-${n.data.name}-${i}`} className={`sig-universe__group ${dim ? "is-dim" : ""}`} style={{ animationDelay: `${(industries.get(industry) ?? 0) * 90}ms` }}
                   onClick={() => onFocus("industry", industry)}>
                  <circle cx={n.x} cy={n.y} r={n.r} style={{ fill: `color-mix(in oklab, ${hue} 10%, transparent)`, stroke: `color-mix(in oklab, ${hue} 55%, transparent)` }} />
                  {n.r > 46 && (
                    <text x={n.x} y={n.y - n.r + 16} textAnchor="middle" className="sig-universe__label">{n.data.name}</text>
                  )}
                </g>
              );
            }
            const p = n.data.point!;
            return (
              <g key={`co-${p.name}-${i}`} className={`sig-universe__dot ${dim ? "is-dim" : ""} ${isFocus(focus, "industry", industry) ? "is-on" : ""}`}
                 style={{ animationDelay: `${200 + (i % 60) * 12}ms` }}
                 onPointerEnter={() => setTip({ x: n.x, y: n.y - n.r, title: p.name, lines: [
                   `${p.industry} · ${p.country}`,
                   `${money(p.spend)} spend · ${count(p.employees)} employees`,
                   `${p.technology} (${p.deployment})`,
                 ] })}
                 onClick={() => onFocus("industry", industry)}>
                <circle cx={n.x} cy={n.y} r={n.r} style={{ fill: hue }} />
                {n.r > 5 && <circle cx={n.x} cy={n.y} r={n.r} fill="url(#sig-orb)" />}
              </g>
            );
          })}
        </svg>
        <TipBox tip={tip} width={size} height={size} />
      </div>
      <Insight>
        <b>{topIndustry.name}</b> holds {pct(topIndustry.spend / total)} of all spend across {count(topIndustry.companies)} companies;
        the single largest account, <b>{biggest.name}</b>, spends {money(biggest.spend)} ({pct(biggest.spend / total, 1)} of the total).
      </Insight>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Spend mosaic (Marimekko): industry width × deployment share      */
/* ------------------------------------------------------------------ */

export function SpendMosaic({ points, focus, onFocus, visible }: ViewProps) {
  const width = 760;
  const height = 380;
  const pad = { top: 8, right: 8, bottom: 52, left: 8 };
  const [tip, setTip] = useState<Tip>(null);
  const model = useMemo(() => {
    const total = points.reduce((s, p) => s + p.spend, 0) || 1;
    const industries = topWithOther(sumBy(points, (p) => p.industry), 8);
    const deployments = sumBy(points, (p) => p.deployment).map((d) => d.name);
    const inTop = new Set(industries.map((i) => i.name));
    const cols = industries.map((ind) => {
      const members = points.filter((p) => (ind.name === "Other" ? !inTop.has(p.industry) : p.industry === ind.name));
      const split = deployments.map((dep) => ({ dep, spend: members.filter((p) => p.deployment === dep).reduce((s, p) => s + p.spend, 0) }));
      return { ...ind, share: ind.spend / total, split };
    });
    const overall = deployments.map((dep) => ({ dep, share: points.filter((p) => p.deployment === dep).reduce((s, p) => s + p.spend, 0) / total }));
    // Industry where the leading deployment model is strongest, against its overall share.
    const lead = overall[0];
    let strongest = { name: "", share: 0 };
    for (const c of cols) {
      if (c.name === "Other" || !c.spend) continue;
      const s = (c.split.find((x) => x.dep === lead?.dep)?.spend ?? 0) / c.spend;
      if (s > strongest.share) strongest = { name: c.name, share: s };
    }
    return { cols, deployments, overall, lead, strongest };
  }, [points]);

  if (!points.length) return <p className="qc-muted">No companies to show.</p>;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const gap = 3;
  // Column x positions and each cell's y offset, computed up front (render stays pure).
  const lefts = model.cols.map((_, i) => pad.left + model.cols.slice(0, i).reduce((s, c) => s + c.share * innerW, 0));

  return (
    <>
      <div className="sig-stage">
        <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg sig-mosaic ${visible ? "is-in" : ""}`} role="img"
             aria-label="Marimekko chart: industries sized by share of spend, split by deployment type" onPointerLeave={() => setTip(null)}>
          {model.cols.map((col, ci) => {
            const w = Math.max(2, col.share * innerW - gap);
            const x0 = lefts[ci];
            const tops = col.split.map((_, k) => pad.top + col.split.slice(0, k).reduce((s, q) => s + (col.spend ? (q.spend / col.spend) * innerH : 0), 0));
            const dim = focus?.dim === "industry" && focus.name !== col.name;
            return (
              <g key={`${col.name}-${ci}`} className={dim ? "is-dim" : ""} style={{ animationDelay: `${ci * 80}ms` }}>
                {col.split.map((part, pi) => {
                  const h = col.spend ? (part.spend / col.spend) * innerH : 0;
                  const y0 = tops[pi];
                  if (h <= 0) return null;
                  const share = col.spend ? part.spend / col.spend : 0;
                  return (
                    <g key={`${part.dep}-${pi}`}>
                      <rect x={x0} y={y0} width={w} height={Math.max(0, h - gap)} rx={4} className="sig-mosaic__cell"
                            style={{ fill: series(pi + 1), animationDelay: `${ci * 80 + pi * 60}ms` }}
                            onPointerEnter={() => setTip({ x: x0 + w / 2, y: y0, title: `${col.name} · ${part.dep}`, lines: [
                              `${money(part.spend)} (${pct(share)} of ${col.name})`,
                              `${col.name}: ${pct(col.share, 1)} of all spend`,
                            ] })}
                            onClick={() => col.name !== "Other" && onFocus("industry", col.name)} />
                      {w > 44 && h > 22 && (
                        <text x={x0 + 8} y={y0 + 16} className="sig-mosaic__pct">{pct(share)}</text>
                      )}
                    </g>
                  );
                })}
                {w > 34 && (
                  <text x={x0 + w / 2} y={height - pad.bottom + 18} textAnchor="middle" className="lab-axis">
                    {col.name.length > Math.floor(w / 7) ? `${col.name.slice(0, Math.max(3, Math.floor(w / 7) - 1))}…` : col.name}
                  </text>
                )}
                {w > 34 && (
                  <text x={x0 + w / 2} y={height - pad.bottom + 34} textAnchor="middle" className="lab-axis sig-mosaic__share">{pct(col.share)}</text>
                )}
              </g>
            );
          })}
        </svg>
        <TipBox tip={tip} width={width} height={height} />
      </div>
      <div className="lab-legend">
        {model.deployments.map((d, i) => (
          <span key={`${d}-${i}`}><i className="sig-swatch" style={{ background: series(i + 1) }} />{d} <b>{pct(model.overall[i]?.share ?? 0)}</b></span>
        ))}
      </div>
      {model.lead && model.strongest.name && (
        <Insight>
          <b>{model.lead.dep}</b> carries {pct(model.lead.share)} of all spend; it is strongest in <b>{model.strongest.name}</b>,
          where it reaches {pct(model.strongest.share)} of that industry&apos;s spend.
        </Insight>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Spend waterfall: how countries build up to the total             */
/* ------------------------------------------------------------------ */

export function SpendWaterfall({ points, focus, onFocus, visible }: ViewProps) {
  const width = 760;
  const height = 330;
  const pad = { top: 20, right: 12, bottom: 46, left: 12 };
  const [tip, setTip] = useState<Tip>(null);
  const { steps, total, top3 } = useMemo(() => {
    const rows = topWithOther(sumBy(points, (p) => p.country), 9);
    const total = rows.reduce((s, r) => s + r.spend, 0) || 1;
    const steps = rows.map((r, i) => {
      const start = rows.slice(0, i).reduce((s, q) => s + q.spend, 0);
      return { ...r, start, end: start + r.spend };
    });
    const top3 = rows.filter((r) => r.name !== "Other").slice(0, 3).reduce((s, r) => s + r.spend, 0) / total;
    return { steps, total, top3 };
  }, [points]);

  if (!points.length) return <p className="qc-muted">No companies to show.</p>;
  const bars = steps.length + 1;
  const slot = (width - pad.left - pad.right) / bars;
  const bw = slot * 0.62;
  const y = (v: number) => pad.top + (1 - v / total) * (height - pad.top - pad.bottom);

  return (
    <>
      <div className="sig-stage">
        <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg sig-waterfall ${visible ? "is-in" : ""}`} role="img"
             aria-label="Waterfall of HR tech spend by country adding up to the total" onPointerLeave={() => setTip(null)}>
          {steps.map((s, i) => {
            const x0 = pad.left + i * slot + (slot - bw) / 2;
            const dim = focus?.dim === "country" && focus.name !== s.name;
            return (
              <g key={`${s.name}-${i}`} className={dim ? "is-dim" : ""}>
                {i > 0 && <line x1={x0 - (slot - bw)} x2={x0} y1={y(s.start)} y2={y(s.start)} className="sig-waterfall__link" />}
                <rect x={x0} y={y(s.end)} width={bw} height={Math.max(1, y(s.start) - y(s.end))} rx={5}
                      className="sig-waterfall__bar" style={{ fill: s.name === "Other" ? "var(--qc-ink-3)" : series(i), animationDelay: `${i * 90}ms` }}
                      onPointerEnter={() => setTip({ x: x0 + bw / 2, y: y(s.end), title: s.name, lines: [
                        `+${money(s.spend)} (${pct(s.spend / total, 1)})`,
                        `${count(s.companies)} companies · running total ${pct(s.end / total)}`,
                      ] })}
                      onClick={() => s.name !== "Other" && onFocus("country", s.name)} />
                <text x={x0 + bw / 2} y={y(s.end) - 6} textAnchor="middle" className="sig-waterfall__val">{pct(s.spend / total)}</text>
                <text x={x0 + bw / 2} y={height - pad.bottom + 18} textAnchor="middle" className="lab-axis">
                  {s.name.length > 11 ? `${s.name.slice(0, 10)}…` : s.name}
                </text>
              </g>
            );
          })}
          {(() => {
            const x0 = pad.left + steps.length * slot + (slot - bw) / 2;
            return (
              <g>
                <rect x={x0} y={y(total)} width={bw} height={y(0) - y(total)} rx={5} className="sig-waterfall__total"
                      style={{ animationDelay: `${steps.length * 90}ms` }} />
                <text x={x0 + bw / 2} y={y(total) - 6} textAnchor="middle" className="sig-waterfall__val">{money(total)}</text>
                <text x={x0 + bw / 2} y={height - pad.bottom + 18} textAnchor="middle" className="lab-axis lab-axis--title">Total</text>
              </g>
            );
          })()}
        </svg>
        <TipBox tip={tip} width={width} height={height} />
      </div>
      <Insight>
        The top three markets ({steps.filter((s) => s.name !== "Other").slice(0, 3).map((s) => s.name).join(", ")}) already add up to{" "}
        <b>{pct(top3)}</b> of the {money(total)} total.
      </Insight>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Tool landscape: treemap, technology category → HR tool          */
/* ------------------------------------------------------------------ */

type TreeDatum = { name: string; category?: string; spend?: number; companies?: number; children?: TreeDatum[] };

export function ToolLandscape({ points, focus, onFocus, visible }: ViewProps) {
  const width = 760;
  const height = 420;
  const [tip, setTip] = useState<Tip>(null);
  const { leaves, categories, total, leader } = useMemo(() => {
    const cats = sumBy(points, (p) => p.category);
    const root: TreeDatum = {
      name: "All",
      children: cats.map((c) => ({
        name: c.name,
        children: sumBy(points.filter((p) => p.category === c.name), (p) => p.technology)
          .map((t) => ({ name: t.name, category: c.name, spend: t.spend, companies: t.companies })),
      })),
    };
    const h = hierarchy<TreeDatum>(root).sum((d) => (d.children ? 0 : Math.max(d.spend ?? 0, 0))).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const laid = treemap<TreeDatum>().tile(treemapSquarify.ratio(1.3)).size([width, height]).paddingInner(3).paddingTop((d) => (d.depth === 1 ? 20 : 0)).round(true)(h);
    const total = cats.reduce((s, c) => s + c.spend, 0) || 1;
    // The tool that dominates its own category the most.
    let leader = { tool: "", category: "", share: 0 };
    for (const c of root.children ?? []) {
      const catSpend = (c.children ?? []).reduce((s, t) => s + (t.spend ?? 0), 0);
      const top = (c.children ?? [])[0];
      if (top && catSpend && (c.children?.length ?? 0) > 1 && (top.spend ?? 0) / catSpend > leader.share) {
        leader = { tool: top.name, category: c.name, share: (top.spend ?? 0) / catSpend };
      }
    }
    return {
      leaves: laid.leaves() as HierarchyRectangularNode<TreeDatum>[],
      categories: (laid.children ?? []) as HierarchyRectangularNode<TreeDatum>[],
      total,
      leader,
    };
  }, [points]);
  const order = useMemo(() => new Map(categories.map((c, i) => [c.data.name, i])), [categories]);

  if (!points.length) return <p className="qc-muted">No companies to show.</p>;

  return (
    <>
      <div className="sig-stage">
        <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg sig-tree ${visible ? "is-in" : ""}`} role="img"
             aria-label="Treemap of HR tech spend by technology category and tool" onPointerLeave={() => setTip(null)}>
          {categories.map((c, i) => (
            <g key={`cat-${c.data.name}-${i}`}>
              <rect x={c.x0} y={c.y0} width={c.x1 - c.x0} height={c.y1 - c.y0} rx={8} className="sig-tree__cat"
                    style={{ stroke: `color-mix(in oklab, ${series(i)} 50%, transparent)` }} />
              {c.x1 - c.x0 > 70 && (
                <text x={c.x0 + 8} y={c.y0 + 14} className="sig-tree__catlabel">
                  {c.data.name} · {pct((c.value ?? 0) / total)}
                </text>
              )}
            </g>
          ))}
          {leaves.map((l, i) => {
            const w = l.x1 - l.x0;
            const h = l.y1 - l.y0;
            const ci = order.get(l.data.category ?? "") ?? 0;
            const dim = (focus?.dim === "technology" && focus.name !== l.data.name) || (focus?.dim === "category" && focus.name !== l.data.category);
            return (
              <g key={`tool-${l.data.category}-${l.data.name}-${i}`} className={`sig-tree__leaf ${dim ? "is-dim" : ""}`} style={{ animationDelay: `${i * 35}ms` }}
                 onPointerEnter={() => setTip({ x: l.x0 + w / 2, y: l.y0, title: l.data.name, lines: [
                   `${l.data.category}`,
                   `${money(l.data.spend ?? 0)} · ${pct((l.data.spend ?? 0) / total, 1)} of all spend`,
                   `${count(l.data.companies ?? 0)} companies`,
                 ] })}
                 onClick={() => onFocus("technology", l.data.name)}>
                <rect x={l.x0} y={l.y0} width={w} height={h} rx={5}
                      style={{ fill: `color-mix(in oklab, ${series(ci)} ${Math.round(45 + 50 * Math.min(1, (l.value ?? 0) / ((categories[ci]?.value ?? 1) || 1)))}%, var(--lab-surface))` }} />
                {w > 64 && h > 30 && (
                  <>
                    <text x={l.x0 + 8} y={l.y0 + 18} className="sig-tree__label">{l.data.name.length > w / 7 ? `${l.data.name.slice(0, Math.floor(w / 7) - 1)}…` : l.data.name}</text>
                    {h > 46 && <text x={l.x0 + 8} y={l.y0 + 34} className="sig-tree__value">{money(l.data.spend ?? 0)}</text>}
                  </>
                )}
              </g>
            );
          })}
        </svg>
        <TipBox tip={tip} width={width} height={height} />
      </div>
      {leader.tool && (
        <Insight>
          <b>{leader.tool}</b> is the most dominant tool in its category, taking {pct(leader.share)} of <b>{leader.category}</b> spend.
        </Insight>
      )}
    </>
  );
}
