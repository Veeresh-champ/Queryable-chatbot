"use client";

import { useEffect, useMemo, useState } from "react";
import { hierarchy, pack } from "d3-hierarchy";
import { scaleLinear } from "d3-scale";
import { area, curveCatmullRom, line } from "d3-shape";

import { WorldGlobe } from "@/components/world-globe";
import { formatValue, type GeoPayload, type ValueFormat } from "@/lib/geo";

/**
 * Insights studio forms (one per chart kind from backend/dashboard.py).
 * Every form animates in once (`useOn`), keeps a hover title on each mark,
 * and the card around it keeps the table view and CSV export. Colours: the
 * --viz-series slots in fixed order for identity, the --qc-seq ramp for
 * magnitude, never colour alone (labels / values are always drawn).
 */

const SERIES = Array.from({ length: 8 }, (_, i) => `var(--viz-series-${i + 1})`);
const SEQ = Array.from({ length: 6 }, (_, i) => `var(--qc-seq-${i})`);
const fmt = (v: number, f: ValueFormat = "number") => formatValue(v, f);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** true one frame after mount: starts CSS transitions from their initial state. */
export function useOn() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return on;
}

/* ---------------------------------------------------------------- globe */

export function GlobeView({ data }: { data: GeoPayload }) {
  const ranked = [...data.places].filter((p) => p.value).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const total = ranked.reduce((s, p) => s + (p.value ?? 0), 0) || 1;
  const on = useOn();
  return (
    <div className="st-globe">
      <div className="st-globe__canvas">
        <WorldGlobe places={data.places} regions={data.regions} metric={data.metric} initialView="world" />
      </div>
      <ol className="st-globe__rank">
        {ranked.slice(0, 7).map((p, i) => (
          <li key={p.key} style={{ transitionDelay: `${i * 60}ms` }} className={on ? "is-on" : ""}>
            <span className="st-globe__dot" style={{ background: SEQ[Math.max(1, 5 - i)] }} />
            <span className="st-globe__name">{p.name}</span>
            <b>{fmt(p.value ?? 0)}</b>
            <em>{pct((p.value ?? 0) / total)}</em>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------- dot matrix */

export function DotMatrix({ data }: { data: { rows: string[]; cols: string[]; cells: number[][] } }) {
  const on = useOn();
  const max = Math.max(1, ...data.cells.flat());
  const W = 640;
  const left = 150;
  const top = 70;
  const cw = (W - left - 10) / data.cols.length;
  const ch = 34;
  return (
    <svg viewBox={`0 0 ${W} ${top + data.rows.length * ch}`} className="viz-svg" role="img" aria-label="Dot matrix">
      {data.cols.map((c, j) => (
        <text key={c} x={left + j * cw + cw / 2} y={top - 12} textAnchor="start" className="viz-axis"
              transform={`rotate(-38 ${left + j * cw + cw / 2} ${top - 12})`}>{short(c, 14)}</text>
      ))}
      {data.rows.map((r, i) => (
        <g key={r}>
          <text x={left - 10} y={top + i * ch + ch / 2 + 4} textAnchor="end" className="viz-label">{short(r, 22)}</text>
          <line x1={left} x2={W - 10} y1={top + i * ch + ch / 2} y2={top + i * ch + ch / 2} className="viz-grid" />
          {data.cols.map((c, j) => {
            const v = data.cells[i][j];
            const radius = v ? 3 + Math.sqrt(v / max) * (Math.min(cw, ch) / 2 - 3) : 0;
            return (
              <circle key={c} cx={left + j * cw + cw / 2} cy={top + i * ch + ch / 2} r={on ? radius : 0}
                      fill={SEQ[v ? Math.min(5, 1 + Math.floor((v / max) * 4.99)) : 0]} className="st-grow"
                      style={{ transitionDelay: `${(i + j) * 35}ms` }}>
                <title>{`${r} · ${c}: ${v.toLocaleString()}`}</title>
              </circle>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

/* ---------------------------------------------------------------- circle pack hierarchy */

type Tree = { name: string; value?: number; children?: Tree[] };

export function PackTree({ data }: { data: Tree }) {
  const on = useOn();
  const S = 420;
  const root = useMemo(() => {
    const h = hierarchy<Tree>(data).sum((d) => d.value ?? 0).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return pack<Tree>().size([S, S]).padding((d) => (d.depth === 0 ? 8 : 3))(h);
  }, [data]);
  const groups = root.children ?? [];
  const total = root.value ?? 1;
  return (
    <div className="st-pack">
      <svg viewBox={`0 0 ${S} ${S}`} className="viz-svg" style={{ maxHeight: 440 }} role="img" aria-label="Nested circles">
        {groups.map((g, gi) => (
          <g key={g.data.name}>
            <circle cx={g.x} cy={g.y} r={on ? g.r : 0} className="st-grow st-pack__group" stroke={SERIES[gi % 8]}
                    style={{ transitionDelay: `${gi * 90}ms` }}>
              <title>{`${g.data.name}: ${(g.value ?? 0).toLocaleString()} (${pct((g.value ?? 0) / total)})`}</title>
            </circle>
            {(g.children ?? []).map((leaf, li) => (
              <circle key={leaf.data.name} cx={leaf.x} cy={leaf.y} r={on ? leaf.r : 0} fill={SERIES[gi % 8]}
                      opacity={leaf.data.name === "Other" || leaf.data.name === "Unknown" ? 0.35 : 0.8} className="st-grow"
                      style={{ transitionDelay: `${gi * 90 + 200 + li * 40}ms` }}>
                <title>{`${g.data.name} · ${leaf.data.name}: ${(leaf.value ?? 0).toLocaleString()}`}</title>
              </circle>
            ))}
            {(g.children ?? []).filter((leaf) => leaf.r > 22).map((leaf) => (
              <text key={`t-${leaf.data.name}`} x={leaf.x} y={leaf.y + 4} textAnchor="middle" className="st-pack__leaf">
                {short(leaf.data.name, Math.floor(leaf.r / 4))}
              </text>
            ))}
            {g.r > 40 && (
              <text x={g.x} y={g.y - g.r + 16} textAnchor="middle" className="st-pack__label">{short(g.data.name, Math.floor(g.r / 4.5))}</text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ---------------------------------------------------------------- wave (distribution) */

export function Wave({ data }: { data: { bins: { from: number; to: number; count: number }[]; median: number; format: ValueFormat; log: boolean } }) {
  const on = useOn();
  const W = 640;
  const H = 230;
  const pad = { l: 16, r: 16, t: 20, b: 36 };
  const max = Math.max(1, ...data.bins.map((b) => b.count));
  const x = scaleLinear().domain([0, data.bins.length - 1]).range([pad.l, W - pad.r]);
  const y = scaleLinear().domain([0, max]).range([H - pad.b, pad.t]);
  const shape = area<{ count: number }>().x((_, i) => x(i)).y0(H - pad.b).y1((d) => y(d.count)).curve(curveCatmullRom.alpha(0.5));
  const edge = line<{ count: number }>().x((_, i) => x(i)).y((d) => y(d.count)).curve(curveCatmullRom.alpha(0.5));
  const medianBin = data.bins.findIndex((b) => data.median >= b.from && data.median <= b.to);
  const peak = data.bins.reduce((best, b, i) => (b.count > data.bins[best].count ? i : best), 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="viz-svg" role="img" aria-label="Distribution wave">
      <defs>
        <linearGradient id="st-wave" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--viz-series-1)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--viz-series-1)" stopOpacity="0.02" />
        </linearGradient>
        <clipPath id="st-wave-clip">
          <rect x="0" y="0" height={H} width={on ? W : 0} className="st-reveal" />
        </clipPath>
      </defs>
      <g clipPath="url(#st-wave-clip)">
        <path d={shape(data.bins) ?? ""} fill="url(#st-wave)" />
        <path d={edge(data.bins) ?? ""} className="viz-line" stroke="var(--viz-series-1)" />
      </g>
      {data.bins.map((b, i) => (
        <g key={i}>
          <rect x={x(i) - (x(1) - x(0)) / 2} y={pad.t} width={x(1) - x(0)} height={H - pad.t - pad.b} fill="transparent">
            <title>{`${fmt(b.from, data.format)}–${fmt(b.to, data.format)}: ${b.count}`}</title>
          </rect>
          {(i % Math.ceil(data.bins.length / 6) === 0 || i === data.bins.length - 1) && (
            <text x={x(i)} y={H - 12} textAnchor="middle" className="viz-axis">{fmt(b.from, data.format)}</text>
          )}
        </g>
      ))}
      {medianBin >= 0 && (
        <g className={`st-fade ${on ? "is-on" : ""}`}>
          <line x1={x(medianBin)} x2={x(medianBin)} y1={pad.t - 6} y2={H - pad.b} className="viz-ref" />
          <text x={x(medianBin) + 6} y={pad.t + 4} className="viz-label">median {fmt(data.median, data.format)}</text>
        </g>
      )}
      <circle cx={x(peak)} cy={y(data.bins[peak].count)} r={on ? 5 : 0} fill="var(--viz-series-1)" className="st-grow st-glow" />
    </svg>
  );
}

/* ---------------------------------------------------------------- range capsules (box plot) */

type Box = { label: string; min: number; q1: number; median: number; q3: number; max: number; n: number };

export function RangeCapsules({ data }: { data: { groups: Box[]; log: boolean; format: ValueFormat } }) {
  const on = useOn();
  const W = 640;
  const left = 130;
  const rowH = 40;
  const lo = Math.min(...data.groups.map((g) => g.min));
  const hi = Math.max(...data.groups.map((g) => g.max));
  const tx = (v: number) => (data.log ? Math.log10(Math.max(v, 1e-9)) : v);
  const x = scaleLinear().domain([tx(Math.max(lo, data.log ? 1e-9 : lo)), tx(hi)]).range([left, W - 20]);
  const X = (v: number) => x(tx(v));
  return (
    <svg viewBox={`0 0 ${W} ${data.groups.length * rowH + 10}`} className="viz-svg" role="img" aria-label="Ranges by group">
      <defs>
        <linearGradient id="st-capsule" x1="0" x2="1">
          <stop offset="0%" stopColor="var(--viz-series-1)" stopOpacity="0.15" />
          <stop offset="50%" stopColor="var(--viz-series-1)" stopOpacity="0.7" />
          <stop offset="100%" stopColor="var(--viz-series-1)" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      {data.groups.map((g, i) => {
        const y = i * rowH + 20;
        return (
          <g key={g.label}>
            <title>{`${g.label}: median ${fmt(g.median, data.format)}, middle half ${fmt(g.q1, data.format)}–${fmt(g.q3, data.format)}, range ${fmt(g.min, data.format)}–${fmt(g.max, data.format)} (${g.n})`}</title>
            <text x={left - 10} y={y + 4} textAnchor="end" className="viz-label">{short(g.label, 16)}</text>
            <line x1={X(g.min)} x2={on ? X(g.max) : X(g.min)} y1={y} y2={y} className="viz-stem st-sweep" style={{ transitionDelay: `${i * 80}ms` }} />
            <rect x={X(g.q1)} y={y - 9} height={18} rx={9} width={on ? Math.max(4, X(g.q3) - X(g.q1)) : 0} fill="url(#st-capsule)"
                  className="st-sweep" style={{ transitionDelay: `${i * 80 + 150}ms` }} />
            <circle cx={X(g.median)} cy={y} r={on ? 6 : 0} fill="var(--viz-series-1)" className="st-grow st-glow viz-dot"
                    style={{ transitionDelay: `${i * 80 + 400}ms` }} />
            <text x={W - 16} y={y - 12} textAnchor="end" className="viz-axis">{fmt(g.median, data.format)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------------------------------------------------------------- concentration ring (pareto) */

export function ConcentrationRing({ data }: { data: { rows: { label: string; value: number; cum_share: number }[]; format: ValueFormat; accounts: number } }) {
  const on = useOn();
  const [hover, setHover] = useState<number | null>(null);
  const R = 120;
  const shares = data.rows.map((r, i) => r.cum_share - (i ? data.rows[i - 1].cum_share : 0));
  const top = data.rows.length ? data.rows[data.rows.length - 1].cum_share : 0;
  const focus = hover != null ? data.rows[hover] : null;
  return (
    <div className="st-ring">
      <svg viewBox="-160 -160 320 320" className="viz-svg" style={{ maxHeight: 340 }} role="img" aria-label="Concentration ring">
        <circle r={R} className="st-ring__rest" />
        {data.rows.map((r, i) => {
          const start = i ? data.rows[i - 1].cum_share : 0;
          return (
            <circle key={`${r.label}-${i}`} r={R} transform="rotate(-90)" pathLength={1}
                    className={`st-ring__seg ${hover != null && hover !== i ? "is-dim" : ""}`}
                    stroke={SERIES[i % 8]}
                    style={{ strokeDasharray: `${on ? Math.max(0.002, shares[i] - 0.003) : 0} 1`, strokeDashoffset: -start,
                             transitionDelay: `${i * 45}ms` }}
                    onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <title>{`${r.label}: ${fmt(r.value, data.format)} (${pct(shares[i])})`}</title>
            </circle>
          );
        })}
        <text textAnchor="middle" y={-4} className="st-ring__value">{focus ? pct(shares[hover!]) : pct(top)}</text>
        <text textAnchor="middle" y={16} className="st-ring__label">
          {focus ? short(focus.label, 22) : `held by the top ${data.rows.length} of ${data.accounts}`}
        </text>
      </svg>
      <ol className="st-ring__list">
        {data.rows.slice(0, 8).map((r, i) => (
          <li key={`${r.label}-${i}`} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} data-active={hover === i}>
            <span style={{ background: SERIES[i % 8] }} />{short(r.label, 26)}<b>{pct(shares[i])}</b>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------- radial top list (lollipop) */

export function RadialTop({ data }: { data: { rows: { label: string; value: number; group: string; shown: string | null }[]; format: ValueFormat } }) {
  const on = useOn();
  const max = Math.max(...data.rows.map((r) => r.value)) || 1;
  const S = 440;
  const inner = 60;
  return (
    <svg viewBox={`${-S / 2} ${-S / 2} ${S} ${S}`} className="viz-svg" style={{ maxHeight: 460 }} role="img" aria-label="Top accounts">
      {data.rows.map((r, i) => {
        const radius = inner + 14 + i * 14;
        const sweep = (r.value / max) * 0.75;
        return (
          <g key={`${r.label}-${i}`}>
            <circle r={radius} className="st-track" />
            <circle r={radius} pathLength={1} transform="rotate(-90)" className="st-arc" stroke={SERIES[i % 8]}
                    style={{ strokeDasharray: `${on ? sweep : 0} 1`, transitionDelay: `${i * 70}ms` }}>
              <title>{`${i + 1}. ${r.label}: ${r.shown ?? fmt(r.value, data.format)} ${r.group ? `(${r.group})` : ""}`}</title>
            </circle>
            <text x={-6} y={-radius + 4} textAnchor="end" className="st-arc__label">{short(r.label, 22)} · {r.shown ?? fmt(r.value, data.format)}</text>
          </g>
        );
      })}
      <text textAnchor="middle" y={4} className="st-ring__value" style={{ fontSize: 20 }}>Top {data.rows.length}</text>
    </svg>
  );
}

/* ---------------------------------------------------------------- progress rings (capability adoption) */

export function ProgressRings({ data }: { data: { rows: { label: string; yes: number; no: number; unknown: number }[] } }) {
  const on = useOn();
  return (
    <div className="st-rings">
      {data.rows.map((r, i) => {
        const known = r.yes + r.no;
        const share = known ? r.yes / known : 0;
        return (
          <figure key={r.label} className="st-rings__item" title={`${r.label}: ${r.yes} yes, ${r.no} no, ${r.unknown} not recorded`}>
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="40" className="st-track" />
              <circle cx="50" cy="50" r="40" pathLength={1} transform="rotate(-90 50 50)" className="st-arc"
                      stroke={share < 0.5 ? "var(--viz-series-2)" : "var(--viz-series-3)"}
                      style={{ strokeDasharray: `${on ? share : 0} 1`, transitionDelay: `${i * 90}ms` }} />
              <text x="50" y="55" textAnchor="middle" className="st-rings__value">{pct(share)}</text>
            </svg>
            <figcaption>
              <strong>{r.label}</strong>
              <span>{r.no} without it{r.unknown ? ` · ${r.unknown} unknown` : ""}</span>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- honeycomb (field coverage) */

export function Honeycomb({ data }: { data: { rows: { label: string; value: number; filled: number; total: number }[] } }) {
  const on = useOn();
  const cols = 6;
  const r = 34;
  const w = Math.sqrt(3) * r;
  const rows = Math.ceil(data.rows.length / cols);
  const hex = (cx: number, cy: number) =>
    Array.from({ length: 6 }, (_, k) => {
      const a = (Math.PI / 3) * k - Math.PI / 6;
      return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
    }).join(" ");
  const shade = (v: number) => SEQ[Math.min(5, Math.max(1, Math.round(v * 5)))];
  return (
    <svg viewBox={`0 0 ${cols * w + w / 2 + 8} ${rows * r * 1.5 + r + 8}`} className="viz-svg" role="img" aria-label="Field coverage">
      {data.rows.map((row, i) => {
        const c = i % cols;
        const rr = Math.floor(i / cols);
        const cx = 4 + w / 2 + c * w + (rr % 2 ? w / 2 : 0);
        const cy = 4 + r + rr * r * 1.5;
        return (
          <g key={row.label} className={`st-hex ${on ? "is-on" : ""}`} style={{ transitionDelay: `${i * 30}ms`, transformOrigin: `${cx}px ${cy}px` }}>
            <polygon points={hex(cx, cy)} fill={shade(row.value)} className="st-hex__cell">
              <title>{`${row.label}: ${pct(row.value)} filled (${row.filled} of ${row.total})`}</title>
            </polygon>
            <text x={cx} y={cy - 2} textAnchor="middle" className={`st-hex__value ${row.value > 0.6 ? "is-strong" : ""}`}>{pct(row.value)}</text>
            <text x={cx} y={cy + 12} textAnchor="middle" className={`st-hex__label ${row.value > 0.6 ? "is-strong" : ""}`}>{short(row.label.replace(" (derived)", "*"), 11)}</text>
          </g>
        );
      })}
    </svg>
  );
}
