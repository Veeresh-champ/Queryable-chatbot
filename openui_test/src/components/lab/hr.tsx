"use client";

import { useMemo, useState } from "react";
import { curveMonotoneX, line } from "d3-shape";
import { scaleLinear } from "d3-scale";

import { fmt, series, shade, Tip, type Driver, type Kpi, type LabInsight } from "@/components/lab/shared";

/**
 * Analytics lab views for the IBM HR attrition dataset (backend/hr_analytics.py):
 * attrition by any dimension, stayers-vs-leavers distributions, the tenure
 * curve, rate heatmaps, the pay gap per role, risk profiles and an income
 * scatter. Clicking a job role follows it through the role-aware views.
 */

export type HrRateRow = { label: string; employees: number; left: number; rate: number };
export type HrBreakdown = { label: string; ordinal: boolean; rows: HrRateRow[] };
export type HrBin = { from: number; to: number; stayed: number; left: number };
export type HrDistribution = { label: string; format: "currency" | "number"; bins: HrBin[]; median_stayed: number; median_left: number };
export type HrHeatmap = {
  id: string;
  title: string;
  row_label: string;
  col_label: string;
  rows: string[];
  cols: string[];
  cells: { row: string; col: string; employees: number; rate: number }[];
};
export type HrPay = { role: string; stayed: number; left: number; employees: number; rate: number };
export type HrProfile = { profile: string; employees: number; left: number; rate: number; lift: number };
export type HrPoint = { id: number; income: number; years: number; age: number; role: string; overtime: "Yes" | "No"; left: 0 | 1 };

export type HrLabData = {
  dataset: "ibm_hr";
  kpis: Kpi[];
  insights: LabInsight[];
  overall_rate: number;
  breakdowns: Record<string, HrBreakdown>;
  drivers: Record<string, Driver[]>;
  distributions: Record<string, HrDistribution>;
  tenure: { label: string; employees: number; rate: number }[];
  heatmaps: HrHeatmap[];
  pay_gap: HrPay[];
  profiles: { high: HrProfile[]; low: HrProfile[] };
  scatter: HrPoint[];
  briefing: string;
};

const STAYED = series(0);
const LEFT = series(3);
const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

type RoleProps = { role: string | null; onRole: (role: string) => void };

/* ------------------------------------------------------------------ Attrition by dimension */

export function RateBars({ data, overall, visible, role, onRole }: { data: Record<string, HrBreakdown>; overall: number; visible: boolean } & RoleProps) {
  const [dim, setDim] = useState("OverTime");
  const current = data[dim] ?? Object.values(data)[0];
  const max = Math.max(overall, ...current.rows.map((r) => r.rate), 1e-6);
  const clickable = dim === "JobRole";
  return (
    <div className="hr-rates">
      <label className="hr-picker">
        Break down by
        <select className="qc-select" value={dim} onChange={(event) => setDim(event.target.value)}>
          {Object.entries(data).map(([key, b]) => (
            <option key={key} value={key}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <ol key={dim} className={`lab-bars ${visible ? "is-in" : ""}`}>
        {current.rows.map((row, i) => {
          const active = clickable && role === row.label;
          return (
            <li
              key={row.label}
              className={`lab-bars__row hr-rates__row ${active ? "is-active" : ""} ${clickable && role && !active ? "is-dim" : ""}`}
              onClick={clickable ? () => onRole(row.label) : undefined}
              style={clickable ? undefined : { cursor: "default" }}
              title={`${row.left} of ${row.employees} employees left`}
            >
              <span className="lab-bars__label">{row.label}</span>
              <span className="lab-bars__track hr-track">
                <span className="lab-bars__bar" style={{ width: `${(row.rate / max) * 100}%`, background: shade(0.25 + (row.rate / max) * 0.75), animationDelay: `${i * 50}ms` }} />
                <i className="hr-track__mark" style={{ left: `${(overall / max) * 100}%` }} aria-hidden="true" />
              </span>
              <span className="lab-bars__value">{pct(row.rate)}</span>
              <span className="hr-rates__n">{row.employees}</span>
            </li>
          );
        })}
      </ol>
      <p className="lab-note">
        Share of each group that left. The thin mark is the company-wide rate ({pct(overall)}); the right column is headcount.
        {clickable && " Click a role to follow it through the pay-gap and income views."}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ Stayers vs leavers */

export function StayLeaveHistogram({ data, visible }: { data: Record<string, HrDistribution>; visible: boolean }) {
  const [field, setField] = useState("MonthlyIncome");
  const [hover, setHover] = useState<number | null>(null);
  const dist = data[field] ?? Object.values(data)[0];
  const width = 640;
  const height = 280;
  const pad = { left: 16, right: 16, top: 16, bottom: 30 };
  const mid = pad.top + (height - pad.top - pad.bottom) * 0.62;
  const max = Math.max(1, ...dist.bins.map((b) => Math.max(b.stayed, b.left)));
  const band = (width - pad.left - pad.right) / dist.bins.length;
  const up = (mid - pad.top) / max;
  const down = (height - pad.bottom - mid) / max;
  const format = dist.format;
  const active = hover != null ? dist.bins[hover] : null;
  const ticks = [0, Math.floor(dist.bins.length / 2), dist.bins.length - 1];
  return (
    <div className="hr-hist">
      <div className="qc-segmented" role="tablist">
        {Object.entries(data).map(([key, d]) => (
          <button key={key} type="button" role="tab" aria-selected={field === key} className={field === key ? "is-active" : ""} onClick={() => setField(key)}>
            {d.label}
          </button>
        ))}
      </div>
      <div className="lab-chart">
        <svg key={field} viewBox={`0 0 ${width} ${height}`} className={`lab-svg hr-hist__svg ${visible ? "is-in" : ""}`} role="img" aria-label={`${dist.label}: employees who stayed and who left`}>
          {dist.bins.map((b, i) => {
            const x = pad.left + i * band + 2;
            const w = Math.max(1, band - 4);
            return (
              <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)} className={hover === i ? "is-hot" : ""}>
                <rect x={x - 2} y={pad.top} width={band} height={height - pad.top - pad.bottom} className="hr-hist__hit" />
                <rect x={x} y={mid - b.stayed * up} width={w} height={b.stayed * up} rx={3} className="hr-hist__bar" style={{ fill: STAYED, animationDelay: `${i * 30}ms` }} />
                <rect x={x} y={mid} width={w} height={b.left * down} rx={3} className="hr-hist__bar hr-hist__bar--down" style={{ fill: LEFT, animationDelay: `${i * 30}ms` }} />
              </g>
            );
          })}
          <line x1={pad.left} x2={width - pad.right} y1={mid} y2={mid} className="lab-gridline" />
          {ticks.map((i) => (
            <text key={i} x={pad.left + i * band + band / 2} y={height - 8} textAnchor="middle" className="lab-axis">
              {fmt(dist.bins[i].from, format)}
            </text>
          ))}
        </svg>
        {active && (
          <Tip x={((pad.left + (hover! + 0.5) * band) / width) * 100} y={20}>
            <b>
              {fmt(active.from, format)} – {fmt(active.to, format)}
            </b>
            <span className="lab-tip__row">
              <i style={{ background: STAYED }} /> Stayed <b>{active.stayed}</b>
            </span>
            <span className="lab-tip__row">
              <i style={{ background: LEFT }} /> Left <b>{active.left}</b>
            </span>
            <span>{active.stayed + active.left ? pct(active.left / (active.stayed + active.left)) : "—"} left</span>
          </Tip>
        )}
      </div>
      <div className="lab-legend">
        <span>
          <i className="hr-swatch" style={{ background: STAYED }} /> Stayed · median <b>{fmt(dist.median_stayed, format)}</b>
        </span>
        <span>
          <i className="hr-swatch" style={{ background: LEFT }} /> Left · median <b>{fmt(dist.median_left, format)}</b>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Tenure curve */

export function TenureCurve({ data, overall, visible }: { data: HrLabData["tenure"]; overall: number; visible: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 640;
  const height = 260;
  const pad = { left: 44, right: 16, top: 16, bottom: 34 };
  const band = (width - pad.left - pad.right) / Math.max(1, data.length);
  const cx = (i: number) => pad.left + band * (i + 0.5);
  const y = scaleLinear().domain([0, Math.max(overall, ...data.map((d) => d.rate)) * 1.12]).range([height - pad.bottom, pad.top]);
  const maxHeads = Math.max(1, ...data.map((d) => d.employees));
  const path = line<HrLabData["tenure"][number]>().x((_, i) => cx(i)).y((d) => y(d.rate)).curve(curveMonotoneX)(data) ?? "";
  const active = hover != null ? data[hover] : null;
  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg ${visible ? "is-in" : ""}`} role="img" aria-label="Attrition rate by years at the company">
        {y.ticks(4).map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="lab-gridline" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="lab-axis">
              {pct(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => (
          <rect
            key={d.label}
            x={cx(i) - band * 0.32}
            width={band * 0.64}
            y={height - pad.bottom - (d.employees / maxHeads) * (height - pad.top - pad.bottom) * 0.45}
            height={(d.employees / maxHeads) * (height - pad.top - pad.bottom) * 0.45}
            rx={4}
            className="hr-tenure__heads"
          />
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={y(overall)} y2={y(overall)} className="lab-cross" />
        <path d={path} pathLength={1} className="lab-draw hr-tenure__line" />
        {data.map((d, i) => (
          <g key={d.label} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <rect x={cx(i) - band / 2} y={pad.top} width={band} height={height - pad.top - pad.bottom} className="hr-hist__hit" />
            <circle cx={cx(i)} cy={y(d.rate)} r={hover === i ? 6 : 4} className="lab-fade hr-tenure__dot" />
            <text x={cx(i)} y={height - 12} textAnchor="middle" className="lab-axis">
              {d.label}
            </text>
          </g>
        ))}
      </svg>
      {active && (
        <Tip x={(cx(hover!) / width) * 100} y={(y(active.rate) / height) * 100}>
          <b>{active.label === "< 1" ? "First year" : `${active.label} years`}</b>
          <span>
            {pct(active.rate)} left · {active.employees} employees
          </span>
        </Tip>
      )}
      <div className="lab-legend">
        <span>
          <i className="lab-legend__line" /> Attrition rate
        </span>
        <span>
          <i className="hr-swatch hr-swatch--soft" /> Headcount
        </span>
        <span>
          <i className="lab-legend__line is-dashed" /> Company average <b>{pct(overall)}</b>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Heatmaps */

export function RateHeatmap({ maps, visible }: { maps: HrHeatmap[]; visible: boolean }) {
  const [id, setId] = useState(maps[0]?.id);
  const map = maps.find((m) => m.id === id) ?? maps[0];
  const cell = useMemo(() => new Map(map.cells.map((c) => [`${c.row}|${c.col}`, c])), [map]);
  const max = Math.max(1e-6, ...map.cells.filter((c) => c.employees >= 5).map((c) => c.rate));
  return (
    <div className="hr-heat">
      <div className="qc-segmented" role="tablist">
        {maps.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={m.id === map.id} className={m.id === map.id ? "is-active" : ""} onClick={() => setId(m.id)}>
            {m.title}
          </button>
        ))}
      </div>
      <div key={map.id} className={`hr-heat__grid ${visible ? "is-in" : ""}`} style={{ gridTemplateColumns: `minmax(96px, auto) repeat(${map.cols.length}, minmax(0, 1fr))` }}>
        <span className="hr-heat__corner">
          {map.row_label} ↓ · {map.col_label} →
        </span>
        {map.cols.map((c) => (
          <span key={c} className="hr-heat__col">
            {c}
          </span>
        ))}
        {map.rows.map((r, ri) => (
          <div key={r} className="hr-heat__line">
            <span className="hr-heat__row">{r}</span>
            {map.cols.map((c, ci) => {
              const v = cell.get(`${r}|${c}`);
              const thin = !v || v.employees < 5;
              return (
                <span
                  key={c}
                  className={`hr-heat__cell ${thin ? "is-thin" : ""}`}
                  style={{ background: thin ? undefined : shade(v.rate / max), animationDelay: `${(ri + ci) * 35}ms` }}
                  title={v ? `${r} · ${c}: ${pct(v.rate)} of ${v.employees} left` : "No employees"}
                >
                  <b>{v ? pct(v.rate) : "—"}</b>
                  <small>{v ? v.employees : 0}</small>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <p className="lab-note">Attrition rate per cell, brighter = more leavers; the small number is headcount. Cells under 5 people are greyed out.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ Pay gap */

export function PayGap({ data, visible, role, onRole }: { data: HrPay[]; visible: boolean } & RoleProps) {
  const width = 480;
  const rowH = 30;
  const pad = { left: 168, right: 48, top: 10, bottom: 28 };
  const height = pad.top + rowH * data.length + pad.bottom;
  const x = scaleLinear()
    .domain([0, Math.max(1, ...data.map((d) => Math.max(d.stayed, d.left))) * 1.05])
    .range([pad.left, width - pad.right])
    .nice();
  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg hr-pay ${visible ? "is-in" : ""}`} role="img" aria-label="Median monthly income of stayers and leavers per job role">
        {x.ticks(4).map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={pad.top} y2={height - pad.bottom} className="lab-gridline" />
            <text x={x(t)} y={height - 8} textAnchor="middle" className="lab-axis">
              {fmt(t, "currency")}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cy = pad.top + rowH * (i + 0.5);
          const active = role === d.role;
          return (
            <g key={d.role} className={`hr-pay__row ${active ? "is-active" : ""} ${role && !active ? "is-dim" : ""}`} onClick={() => onRole(d.role)} style={{ animationDelay: `${i * 60}ms` }}>
              <rect x={0} y={cy - rowH / 2} width={width} height={rowH} className="hr-hist__hit" />
              <text x={pad.left - 12} y={cy + 4} textAnchor="end" className="hr-pay__label">
                {d.role}
              </text>
              <line x1={x(d.left)} x2={x(d.stayed)} y1={cy} y2={cy} className="hr-pay__gap" />
              <circle cx={x(d.stayed)} cy={cy} r={6} style={{ fill: STAYED }} />
              <circle cx={x(d.left)} cy={cy} r={6} style={{ fill: LEFT }} />
              <text x={width - pad.right + 8} y={cy + 4} className="lab-axis">
                {d.stayed ? `${Math.round((d.left / d.stayed - 1) * 100)}%` : "—"}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="lab-legend">
        <span>
          <i className="hr-swatch" style={{ background: STAYED }} /> Stayed (median)
        </span>
        <span>
          <i className="hr-swatch" style={{ background: LEFT }} /> Left (median)
        </span>
        <span>Right column: leavers&apos; pay vs stayers&apos;</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Risk profiles */

export function RiskProfiles({ data, overall, visible }: { data: HrLabData["profiles"]; overall: number; visible: boolean }) {
  const max = Math.max(1e-6, ...data.high.map((p) => p.rate));
  const list = (title: string, rows: HrProfile[]) => (
    <div>
      <h3 className="hr-profiles__title">{title}</h3>
      <ol className={`lab-bars ${visible ? "is-in" : ""}`}>
        {rows.map((p, i) => (
          <li key={p.profile} className="lab-bars__row hr-profiles__row" style={{ cursor: "default" }} title={`${p.left} of ${p.employees} left`}>
            <span className="lab-bars__label">{p.profile}</span>
            <span className="lab-bars__track hr-track">
              <span className="lab-bars__bar" style={{ width: `${(p.rate / max) * 100}%`, background: shade(0.25 + (p.rate / max) * 0.75), animationDelay: `${i * 60}ms` }} />
              <i className="hr-track__mark" style={{ left: `${(overall / max) * 100}%` }} aria-hidden="true" />
            </span>
            <span className="lab-bars__value">{pct(p.rate)}</span>
            <span className="hr-rates__n">{p.lift.toFixed(1)}×</span>
          </li>
        ))}
      </ol>
    </div>
  );
  return (
    <div className="hr-profiles">
      {list("Highest risk", data.high)}
      {data.low.length > 0 && list("Most likely to stay", data.low)}
      <p className="lab-note">Overtime × marital status × job level, groups of 25+ employees. The × column compares each group with the {pct(overall)} average.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ Income scatter */

export function IncomeScatter({ points, visible, role }: { points: HrPoint[]; visible: boolean; role: string | null }) {
  const [only, setOnly] = useState<"all" | "Yes" | "No">("all");
  const [hover, setHover] = useState<HrPoint | null>(null);
  const width = 960;
  const height = 360;
  const pad = { left: 56, right: 16, top: 14, bottom: 36 };
  const x = useMemo(() => scaleLinear().domain([0, Math.max(1, ...points.map((p) => p.years))]).range([pad.left, width - pad.right]).nice(), [points, pad.left, pad.right]);
  const y = useMemo(() => scaleLinear().domain([0, Math.max(1, ...points.map((p) => p.income))]).range([height - pad.bottom, pad.top]).nice(), [points, pad.top, pad.bottom]);
  const shown = only === "all" ? points : points.filter((p) => p.overtime === only);
  // Leavers drawn last so they sit on top.
  const ordered = useMemo(() => [...shown].sort((a, b) => a.left - b.left), [shown]);
  return (
    <div className="lab-chart">
      <div className="qc-segmented lab-chart__toggle" role="tablist">
        {(["all", "Yes", "No"] as const).map((o) => (
          <button key={o} type="button" role="tab" aria-selected={only === o} className={only === o ? "is-active" : ""} onClick={() => setOnly(o)}>
            {o === "all" ? "Everyone" : o === "Yes" ? "Overtime" : "No overtime"}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-scatter ${visible ? "is-in" : ""}`} role="img" aria-label="Monthly income against total working years">
        {y.ticks(5).map((t) => (
          <g key={`y${t}`}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="lab-gridline" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="lab-axis">
              {fmt(t, "currency")}
            </text>
          </g>
        ))}
        {x.ticks(8).map((t) => (
          <text key={`x${t}`} x={x(t)} y={height - 14} textAnchor="middle" className="lab-axis">
            {t}
          </text>
        ))}
        <text x={width - pad.right} y={height - 1} textAnchor="end" className="lab-axis lab-axis--title">
          Total working years →
        </text>
        {ordered.map((p, i) => (
          <circle
            key={p.id}
            cx={x(p.years) + ((p.id % 7) - 3) * 0.9}
            cy={y(p.income)}
            r={p.left ? 4 : 3}
            className={`lab-dot ${role && p.role !== role ? "is-dim" : ""} ${hover?.id === p.id ? "is-hot" : ""}`}
            style={{ fill: p.left ? LEFT : STAYED, animationDelay: `${Math.min(i, 600) * 1.2}ms` }}
            onPointerEnter={() => setHover(p)}
            onPointerLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {hover && (
        <Tip x={(x(hover.years) / width) * 100} y={(y(hover.income) / height) * 100}>
          <b>Employee #{hover.id}</b>
          <span>
            {hover.role} · age {hover.age}
          </span>
          <span>
            {fmt(hover.income, "currency", false)}/month · {hover.years} yrs experience
          </span>
          <span>{hover.left ? "Left" : "Stayed"}{hover.overtime === "Yes" ? " · overtime" : ""}</span>
        </Tip>
      )}
      <div className="lab-legend">
        <span>
          <i className="hr-swatch" style={{ background: STAYED }} /> Stayed
        </span>
        <span>
          <i className="hr-swatch" style={{ background: LEFT }} /> Left
        </span>
        {role && <span className="lab-legend__focus">Following {role}</span>}
      </div>
    </div>
  );
}
