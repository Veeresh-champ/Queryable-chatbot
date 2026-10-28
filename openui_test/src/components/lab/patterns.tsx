"use client";

import { useMemo, useRef, useState } from "react";
import { area, curveMonotoneX, line } from "d3-shape";
import { scaleLinear, scaleLog } from "d3-scale";

import {
  isFocus,
  matches,
  money,
  series,
  shade,
  Tip,
  type Dim,
  type Fit,
  type Focus,
  type HeatmapData,
  type OutlierData,
  type ParetoData,
  type Point,
  type RevenueData,
} from "@/components/lab/shared";

type ViewProps = { points: Point[]; focus: Focus; onFocus: (dim: Dim, name: string) => void; visible: boolean };

/* ------------------------------------------------------------------ Bubble matrix */

/**
 * Industry × deployment as a bubble matrix: bubble area = companies, colour =
 * average spend (heat ramp). Recomputed for the focused slice.
 */
export function SpendBubbles({ data, points, focus, onFocus, visible }: ViewProps & { data: HeatmapData }) {
  const [hover, setHover] = useState<{ row: string; col: string } | null>(null);
  // Row/column focus only highlights; any other focus re-slices the averages.
  const slice = focus && focus.dim !== "industry" && focus.dim !== "deployment" ? focus : null;
  const cells = useMemo(() => {
    const sums = new Map<string, [number, number]>();
    for (const p of points) {
      if (!matches(p, slice)) continue;
      const key = `${p.industry}|${p.deployment}`;
      const cell = sums.get(key) ?? [0, 0];
      sums.set(key, [cell[0] + p.spend, cell[1] + 1]);
    }
    return sums;
  }, [points, slice]);
  const avgs = [...cells.values()].map(([s, n]) => s / n);
  const lo = Math.min(...avgs);
  const hi = Math.max(...avgs);
  const most = Math.max(1, ...[...cells.values()].map(([, n]) => n));

  const labelW = 150;
  const colW = 120;
  const rowH = 40;
  const top = 34;
  const width = labelW + colW * data.cols.length;
  const height = top + rowH * data.rows.length + 6;
  const cell = hover ? cells.get(`${hover.row}|${hover.col}`) : null;

  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-bubbles ${visible ? "is-in" : ""}`} role="img" aria-label="Average spend by industry and deployment type">
        {data.cols.map((col, c) => (
          <text
            key={col}
            x={labelW + colW * c + colW / 2}
            y={16}
            textAnchor="middle"
            className={`lab-bubbles__axis is-clickable ${hover?.col === col || isFocus(focus, "deployment", col) ? "is-hot" : ""}`}
            onClick={() => onFocus("deployment", col)}
          >
            {col}
          </text>
        ))}
        {data.rows.map((row, r) => {
          const y = top + rowH * r + rowH / 2;
          return (
            <g key={row}>
              <line x1={labelW - 6} x2={width - 10} y1={y} y2={y} className="lab-bubbles__guide" />
              <text
                x={labelW - 14}
                y={y}
                dy="0.35em"
                textAnchor="end"
                className={`lab-bubbles__axis is-clickable ${hover?.row === row || isFocus(focus, "industry", row) ? "is-hot" : ""}`}
                onClick={() => onFocus("industry", row)}
              >
                {row}
              </text>
              {data.cols.map((col, c) => {
                const value = cells.get(`${row}|${col}`);
                if (!value) return null;
                const avg = value[0] / value[1];
                const t = (avg - lo) / (hi - lo || 1);
                const radius = 5 + Math.sqrt(value[1] / most) * 13;
                const dim = (focus?.dim === "industry" && focus.name !== row) || (focus?.dim === "deployment" && focus.name !== col);
                const cx = labelW + colW * c + colW / 2;
                return (
                  <g
                    key={col}
                    transform={`translate(${cx},${y})`}
                    className={`lab-bubble ${dim ? "is-dim" : ""}`}
                    onPointerEnter={() => setHover({ row, col })}
                    onPointerLeave={() => setHover(null)}
                  >
                    <circle r={radius} className="lab-bubble__dot" style={{ fill: shade(0.05 + t * 0.95), animationDelay: `${(r * data.cols.length + c) * 28}ms` }} />
                    {hover?.row === row && hover.col === col && <circle r={radius + 5} className="lab-bubble__ring" />}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {hover && cell && (
        <Tip x={((labelW + colW * data.cols.indexOf(hover.col) + colW / 2) / width) * 100} y={((top + rowH * data.rows.indexOf(hover.row) + 8) / height) * 100}>
          <b>
            {hover.row} · {hover.col}
          </b>
          <span>{money(cell[0] / cell[1])} average spend</span>
          <span>{cell[1]} companies</span>
        </Tip>
      )}
      <div className="lab-legend">
        <span className="lab-legend__ramp" aria-hidden="true" />
        <span>Colour = average spend · bubble size = number of companies</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Efficiency */

/** Spend per employee by industry, for the focused slice. */
export function EfficiencyBars({ points, focus, onFocus, visible }: ViewProps) {
  const slice = focus && focus.dim !== "industry" ? focus : null;
  const rows = useMemo(() => {
    const groups = new Map<string, [number, number, number]>();
    for (const p of points) {
      if (!matches(p, slice)) continue;
      const g = groups.get(p.industry) ?? [0, 0, 0];
      groups.set(p.industry, [g[0] + p.spend, g[1] + p.employees, g[2] + 1]);
    }
    return [...groups.entries()]
      .map(([label, [s, e, n]]) => ({ label, value: s / e, companies: n }))
      .sort((a, b) => b.value - a.value);
  }, [points, slice]);
  const max = Math.max(1, ...rows.map((r) => r.value));
  const min = Math.min(...rows.map((r) => r.value));

  return (
    <ol className={`lab-bars ${visible ? "is-in" : ""}`}>
      {rows.map((row, i) => {
        const active = isFocus(focus, "industry", row.label);
        return (
          <li
            key={row.label}
            className={`lab-bars__row ${active ? "is-active" : ""} ${focus?.dim === "industry" && !active ? "is-dim" : ""}`}
            onClick={() => onFocus("industry", row.label)}
            title={`${row.companies} companies`}
          >
            <span className="lab-bars__label">{row.label}</span>
            <span className="lab-bars__track">
              <span
                className="lab-bars__bar"
                style={{
                  width: `${(row.value / max) * 100}%`,
                  background: shade(0.3 + ((row.value - min) / (max - min || 1)) * 0.7),
                  animationDelay: `${i * 60}ms`,
                }}
              />
            </span>
            <span className="lab-bars__value">${row.value.toFixed(2)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ Scatter */

/** Company size vs spend on log axes, with the fitted line. Brightness = spend vs what size predicts. */
export function SizeScatter({ points, fit, focus, onFocus, visible, segments }: ViewProps & { fit: Fit; segments: string[] }) {
  const width = 960;
  const height = 420;
  const pad = { top: 18, right: 22, bottom: 40, left: 70 };
  const [hover, setHover] = useState<number | null>(null);

  const { x, y, xTicks, yTicks } = useMemo(() => {
    const xs = points.map((p) => p.employees);
    const ys = points.map((p) => p.spend);
    const x = scaleLog().domain([Math.min(...xs) * 0.85, Math.max(...xs) * 1.15]).range([pad.left, width - pad.right]);
    const y = scaleLog().domain([Math.min(...ys) * 0.8, Math.max(...ys) * 1.2]).range([height - pad.bottom, pad.top]);
    return { x, y, xTicks: x.ticks(5).filter((t) => /^[125]/.test(String(t))), yTicks: y.ticks(5).filter((t) => /^[125]/.test(String(t))) };
  }, [points, pad.left, pad.right, pad.top, pad.bottom]);

  const predict = (employees: number) => 10 ** (fit.slope * Math.log10(employees) + fit.intercept);
  const [x0, x1] = x.domain();
  const p = hover != null ? points[hover] : null;

  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-scatter ${visible ? "is-in" : ""}`} role="img" aria-label={`Company size against spend, correlation ${fit.r.toFixed(2)}`}>
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="lab-gridline" />
            <text x={pad.left - 10} y={y(t) + 4} textAnchor="end" className="lab-axis">
              {money(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={`x${t}`}>
            <line x1={x(t)} x2={x(t)} y1={pad.top} y2={height - pad.bottom} className="lab-gridline" />
            <text x={x(t)} y={height - pad.bottom + 18} textAnchor="middle" className="lab-axis">
              {t.toLocaleString()}
            </text>
          </g>
        ))}
        <text x={width - pad.right} y={height - 6} textAnchor="end" className="lab-axis lab-axis--title">
          Employees (log scale) →
        </text>
        <text x={pad.left} y={pad.top - 6} className="lab-axis lab-axis--title">
          ↑ Annual HR tech spend
        </text>
        {points.map((pt, i) => {
          const on = matches(pt, focus);
          return (
            <circle
              key={pt.name}
              cx={x(pt.employees)}
              cy={y(pt.spend)}
              r={hover === i ? 7 : focus && on ? 5 : 3.6}
              className={`lab-dot ${on ? "" : "is-dim"} ${focus && on ? "is-hot" : ""}`}
              style={{ fill: series(segments.indexOf(pt.segment)), animationDelay: `${(i % 60) * 14}ms` }}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            />
          );
        })}
        <line
          x1={x(x0)}
          y1={y(predict(x0))}
          x2={x(x1)}
          y2={y(predict(x1))}
          pathLength={1}
          className="lab-fit"
        />
      </svg>
      {p && (
        <Tip x={(x(p.employees) / width) * 100} y={(y(p.spend) / height) * 100}>
          <b>{p.name}</b>
          <span>
            {p.industry} · {p.country}
          </span>
          <span>
            {p.employees.toLocaleString()} employees · {money(p.spend)}
          </span>
          <span>{(p.spend / predict(p.employees)).toFixed(2)}× what its size predicts</span>
          <span>Segment: {p.segment}</span>
        </Tip>
      )}
      <div className="lab-legend">
        {segments.map((name, i) => (
          <button key={name} type="button" className={`lab-legend__item ${isFocus(focus, "segment", name) ? "is-active" : ""}`} onClick={() => onFocus("segment", name)}>
            <i className="lab-legend__dot is-solid" style={{ background: series(i), borderColor: series(i) }} /> {name}
          </button>
        ))}
        <span>
          r = <b>{fit.r.toFixed(2)}</b> · R² = <b>{fit.r2.toFixed(2)}</b>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Pareto */

function paretoCurve(values: number[]) {
  const sorted = [...values].sort((a, b) => b - a);
  const total = sorted.reduce((a, b) => a + b, 0) || 1;
  let running = 0;
  return [{ x: 0, y: 0 }, ...sorted.map((v, i) => ({ x: (i + 1) / sorted.length, y: (running += v) / total }))];
}

/** Cumulative spend share: how few companies carry most of the money. */
export function ParetoCurve({ data, points, focus, visible }: Omit<ViewProps, "onFocus"> & { data: ParetoData }) {
  const size = { w: 520, h: 360 };
  const pad = { top: 16, right: 18, bottom: 38, left: 48 };
  const x = scaleLinear().domain([0, 1]).range([pad.left, size.w - pad.right]);
  const y = scaleLinear().domain([0, 1]).range([size.h - pad.bottom, pad.top]);
  const lineGen = line<{ x: number; y: number }>().x((d) => x(d.x)).y((d) => y(d.y)).curve(curveMonotoneX);
  const areaGen = area<{ x: number; y: number }>().x((d) => x(d.x)).y0((d) => y(d.x)).y1((d) => y(d.y)).curve(curveMonotoneX);
  const sub = useMemo(() => {
    if (!focus) return null;
    const values = points.filter((p) => matches(p, focus)).map((p) => p.spend);
    return values.length > 2 ? paretoCurve(values) : null;
  }, [points, focus]);
  const mark = data.share_for_80;

  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${size.w} ${size.h}`} className={`lab-svg lab-pareto ${visible ? "is-in" : ""}`} role="img" aria-label={`${(mark * 100).toFixed(0)} percent of companies account for 80 percent of spend`}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={size.w - pad.right} y1={y(t)} y2={y(t)} className="lab-gridline" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="lab-axis">
              {t * 100}%
            </text>
            <text x={x(t)} y={size.h - pad.bottom + 18} textAnchor="middle" className="lab-axis">
              {t * 100}%
            </text>
          </g>
        ))}
        <path d={areaGen(data.curve) ?? ""} className="lab-pareto__gap" />
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="lab-pareto__equal" />
        <path d={lineGen(data.curve) ?? ""} pathLength={1} className="lab-draw lab-pareto__line" />
        {sub && <path d={lineGen(sub) ?? ""} pathLength={1} className="lab-draw lab-pareto__focus" />}
        <g className="lab-pareto__mark">
          <line x1={x(mark)} x2={x(mark)} y1={y(0)} y2={y(0.8)} />
          <line x1={x(0)} x2={x(mark)} y1={y(0.8)} y2={y(0.8)} />
          <circle cx={x(mark)} cy={y(0.8)} r={5} />
          <text x={x(mark) + 10} y={y(0.8) + 18}>
            {(mark * 100).toFixed(0)}% of companies → 80% of spend
          </text>
        </g>
        <text x={size.w - pad.right} y={size.h - 4} textAnchor="end" className="lab-axis lab-axis--title">
          Share of companies, biggest spenders first →
        </text>
      </svg>
      <div className="lab-legend">
        <span>
          Gini <b>{data.gini.toFixed(2)}</b>
        </span>
        <span>
          Top 10% hold <b>{(data.top10_share * 100).toFixed(0)}%</b>
        </span>
        {sub && <span className="lab-legend__focus">Dashed = your focus</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Over / under spenders */

/** Companies furthest above and below the spend their size predicts, centred on 1×. */
export function SpendDivergence({ data, focus, visible }: { data: OutlierData; focus: Focus; visible: boolean }) {
  const rows = [...data.over, ...[...data.under].reverse()];
  const span = Math.max(...rows.map((r) => Math.abs(Math.log2(r.ratio))), 0.1);
  return (
    <ol className={`lab-diverge ${visible ? "is-in" : ""}`}>
      {rows.map((row, i) => {
        const v = Math.log2(row.ratio) / span;
        const up = v >= 0;
        const on = !focus || (focus.dim === "industry" ? focus.name === row.industry : focus.dim === "country" ? focus.name === row.country : true);
        return (
          <li key={row.name} className={`lab-diverge__row ${on ? "" : "is-dim"}`} title={`${row.industry} · ${row.country}: ${money(row.spend)} vs ${money(row.expected)} expected`}>
            <span className="lab-diverge__name">
              {row.name}
              <small>
                {row.industry} · {row.country}
              </small>
            </span>
            <span className="lab-diverge__axis">
              <span
                className={`lab-diverge__bar ${up ? "is-up" : "is-down"}`}
                style={{ width: `${Math.abs(v) * 50}%`, animationDelay: `${i * 70}ms` }}
              />
            </span>
            <span className="lab-diverge__value">{up ? `${row.ratio.toFixed(2)}×` : `÷${(1 / row.ratio).toFixed(2)}`}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ Revenue forecast */

/** Actual revenue, 3-month moving average and a 3-month projection with an 80% band. */
export function RevenueForecast({ data, visible }: { data: RevenueData; visible: boolean }) {
  const width = 960;
  const height = 340;
  const pad = { top: 20, right: 24, bottom: 34, left: 64 };
  const ref = useRef<SVGSVGElement>(null);
  const [index, setIndex] = useState<number | null>(null);

  const all = [
    ...data.series.map((p) => ({ label: p.label, value: p.value, avg: p.moving_avg, kind: "actual" as const })),
    ...data.forecast.map((p) => ({ label: p.label, value: p.value, low: p.low, high: p.high, kind: "forecast" as const })),
  ];
  const n = all.length;
  const x = scaleLinear().domain([0, n - 1]).range([pad.left, width - pad.right]);
  const top = Math.max(...data.series.map((p) => p.value), ...data.forecast.map((p) => p.high));
  const bottom = Math.min(...data.series.map((p) => p.value), ...data.forecast.map((p) => p.low));
  const y = scaleLinear().domain([bottom * 0.85, top * 1.05]).nice(5).range([height - pad.bottom, pad.top]);
  const last = data.series.length - 1;

  const actual = line<number>().x((_, i) => x(i)).y((v) => y(v)).curve(curveMonotoneX)(data.series.map((p) => p.value)) ?? "";
  const avg = line<number>().x((_, i) => x(i)).y((v) => y(v)).curve(curveMonotoneX)(data.series.map((p) => p.moving_avg)) ?? "";
  const fc = [{ i: last, v: data.series[last].value, low: data.series[last].value, high: data.series[last].value }, ...data.forecast.map((p, k) => ({ i: last + 1 + k, v: p.value, low: p.low, high: p.high }))];
  const fcLine = line<(typeof fc)[number]>().x((d) => x(d.i)).y((d) => y(d.v))(fc) ?? "";
  const band = area<(typeof fc)[number]>().x((d) => x(d.i)).y0((d) => y(d.low)).y1((d) => y(d.high)).curve(curveMonotoneX)(fc) ?? "";
  const fill = area<number>().x((_, i) => x(i)).y0(y(y.domain()[0])).y1((v) => y(v)).curve(curveMonotoneX)(data.series.map((p) => p.value)) ?? "";

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((event.clientX - box.left) / box.width) * width;
    setIndex(Math.max(0, Math.min(n - 1, Math.round(x.invert(px)))));
  };
  const point = index != null ? all[index] : null;

  return (
    <div className="lab-chart">
      <svg ref={ref} viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-revenue ${visible ? "is-in" : ""}`} onPointerMove={onMove} onPointerLeave={() => setIndex(null)} role="img" aria-label="Monthly revenue with forecast">
        <defs>
          <linearGradient id="lab-line-grad" x1="0" x2="1">
            <stop offset="0%" style={{ stopColor: "var(--qc-accent)" }} />
            <stop offset="100%" style={{ stopColor: "var(--qc-accent-2)" }} />
          </linearGradient>
          <linearGradient id="lab-rev-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--lab-hi)", stopOpacity: 0.35 }} />
            <stop offset="100%" style={{ stopColor: "var(--lab-hi)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        {y.ticks(5).map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="lab-gridline" />
            <text x={pad.left - 10} y={y(t) + 4} textAnchor="end" className="lab-axis">
              {money(t)}
            </text>
          </g>
        ))}
        {all.map((p, i) => (
          <text key={p.label} x={x(i)} y={height - 10} textAnchor="middle" className={`lab-axis ${p.kind === "forecast" ? "is-forecast" : ""}`}>
            {p.label.slice(2)}
          </text>
        ))}
        <rect x={x(last)} y={pad.top} width={x(n - 1) - x(last) + 8} height={height - pad.top - pad.bottom} className="lab-revenue__future" />
        <text x={x(last) + 8} y={pad.top + 14} className="lab-axis lab-axis--title">
          Forecast
        </text>
        <path d={fill} fill="url(#lab-rev-fill)" className="lab-fade" />
        <path d={band} className="lab-revenue__band lab-fade" />
        <path d={avg} pathLength={1} className="lab-draw lab-revenue__avg" />
        <path d={actual} pathLength={1} className="lab-draw lab-revenue__line" />
        <path d={fcLine} className="lab-revenue__forecast lab-fade" />
        {all.map((p, i) => (
          <circle key={p.label} cx={x(i)} cy={y(p.value)} r={index === i ? 6 : 3.5} className={`lab-revenue__dot ${p.kind === "forecast" ? "is-forecast" : ""}`} style={{ animationDelay: `${600 + i * 60}ms` }} />
        ))}
        {point && index != null && <line x1={x(index)} x2={x(index)} y1={pad.top} y2={height - pad.bottom} className="lab-cross" />}
      </svg>
      {point && index != null && (
        <Tip x={(x(index) / width) * 100} y={(y(point.value) / height) * 100}>
          <b>
            {point.label} {point.kind === "forecast" && "· forecast"}
          </b>
          <span>{money(point.value)}</span>
          {point.kind === "actual" ? <span>3-mo avg {money(point.avg)}</span> : <span>80% range {money(point.low)} – {money(point.high)}</span>}
        </Tip>
      )}
      <div className="lab-legend">
        <span>
          <i className="lab-legend__line" /> Revenue
        </span>
        <span>
          <i className="lab-legend__line is-dashed" /> 3-month average
        </span>
        <span>
          <i className="lab-legend__band" /> Forecast, 80% range
        </span>
        <span>
          Trend <b>{data.slope_per_month >= 0 ? "+" : ""}{money(data.slope_per_month)}</b>/month · volatility <b>{(data.volatility * 100).toFixed(0)}%</b>
        </span>
      </div>
    </div>
  );
}
