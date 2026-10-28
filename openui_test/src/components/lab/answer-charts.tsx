"use client";

import { useMemo, useRef, useState } from "react";
import { area, curveMonotoneX, line } from "d3-shape";
import { scaleLinear, scaleLog } from "d3-scale";
import {
  ArrowDownRight,
  Download,
  ArrowUpRight,
  Crown,
  Gauge,
  Layers,
  Lightbulb,
  Mountain,
  Scale,
  Sigma,
  TrendingUp,
} from "lucide-react";

import { CountUp, fmt, series, shade, Tip, useReveal, type AnyFormat } from "@/components/lab/shared";

/**
 * Charts for the `visual_analysis` tool result (backend/analytics.py
 * answer_analysis): one card per chat answer with count-up stats, the best
 * chart(s) for the data's shape and plain-language findings. Same one-hue
 * palette and animations as the Analytics lab.
 */

type Row = { label: string; value: number };
export type AnswerChart =
  | { kind: "bars" | "donut"; title: string; format: AnyFormat; rows: Row[] }
  | { kind: "trend"; title: string; format: AnyFormat; rows: (Row & { avg: number })[]; forecast: { label: string; value: number; low: number; high: number }[] }
  | { kind: "heatmap"; title: string; format: AnyFormat; rows: string[]; cols: string[]; cells: { row: string; col: string; value: number }[] }
  | {
      kind: "scatter";
      title: string;
      x_label: string;
      y_label: string;
      x_format: AnyFormat;
      y_format: AnyFormat;
      log: boolean;
      r: number;
      slope: number;
      intercept: number;
      points: { label: string; x: number; y: number }[];
    }
  | { kind: "compare"; title: string; rows: { label: string; value: number; baseline: number; format: AnyFormat }[] }
  | { kind: "pareto"; title: string; curve: { x: number; y: number }[]; share_for_80: number; top10_share: number; gini: number };

export type AnswerInsight = { kind: string; title: string; value: string; detail: string };
export type VisualAnalysis = {
  title: string;
  operation?: string;
  collection?: string | null;
  stats: { label: string; value: number; format: AnyFormat; hint: string }[];
  charts: AnswerChart[];
  insights: AnswerInsight[];
};

const ICONS: Record<string, React.ReactNode> = {
  leader: <Crown size={15} />,
  spread: <Scale size={15} />,
  concentration: <Layers size={15} />,
  skew: <Gauge size={15} />,
  average: <Sigma size={15} />,
  trend: <TrendingUp size={15} />,
  peak: <Mountain size={15} />,
  jump: <ArrowUpRight size={15} />,
  drop: <ArrowDownRight size={15} />,
};

/* ------------------------------------------------------------------ pieces */

function Bars({ rows, format, visible, limit = 8 }: { rows: Row[]; format: AnyFormat; visible: boolean; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, limit);
  const max = Math.max(...rows.map((r) => r.value), 1);
  const min = Math.min(...rows.map((r) => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <>
      <ol className={`lab-bars ${visible ? "is-in" : ""}`}>
        {shown.map((row, i) => (
          <li key={row.label} className="lab-bars__row" title={`${row.label}: ${fmt(row.value, format, false)} (${((row.value / total) * 100).toFixed(1)}%)`}>
            <span className="lab-bars__label">{row.label}</span>
            <span className="lab-bars__track">
              <span
                className="lab-bars__bar"
                style={{
                  width: `${Math.max(1.5, (row.value / max) * 100)}%`,
                  background: shade(0.3 + ((row.value - min) / (max - min || 1)) * 0.7),
                  animationDelay: `${i * 55}ms`,
                }}
              />
            </span>
            <span className="lab-bars__value">{fmt(row.value, format)}</span>
          </li>
        ))}
      </ol>
      {rows.length > limit && (
        <button type="button" className="lab-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </>
  );
}

function Donut({ rows, format, visible }: { rows: Row[]; format: AnyFormat; visible: boolean }) {
  const [active, setActive] = useState<number | null>(null);
  const parts = rows.slice(0, 6);
  const rest = rows.slice(6).reduce((s, r) => s + r.value, 0);
  if (rest > 0) parts.push({ label: "Other", value: rest });
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const radius = 54;
  const c = 2 * Math.PI * radius;
  const offsets = parts.map((_, i) => parts.slice(0, i).reduce((s, p) => s + (p.value / total) * c, 0));
  const focus = active != null ? parts[active] : null;
  return (
    <div className="lab-donut">
      <svg viewBox="0 0 140 140" className={`lab-donut__svg ${visible ? "is-in" : ""}`} role="img" aria-label={parts.map((p) => `${p.label} ${fmt(p.value, format)}`).join(", ")}>
        <circle cx="70" cy="70" r={radius} className="lab-donut__track" />
        {parts.map((part, i) => {
          const len = (part.value / total) * c;
          const dash = Math.max(0.5, len - (parts.length > 1 ? 2.5 : 0));
          return (
            <circle
              key={part.label}
              cx="70"
              cy="70"
              r={radius}
              className={`lab-donut__seg ${active === i ? "is-active" : ""} ${active != null && active !== i ? "is-dim" : ""}`}
              style={{
                stroke: part.label === "Other" || part.label === "Everything else" ? "var(--qc-ink-3)" : series(i),
                strokeDasharray: `${dash} ${c - dash}`,
                strokeDashoffset: -offsets[i],
                animationDelay: `${i * 110}ms`,
              }}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
            />
          );
        })}
        <text x="70" y="68" textAnchor="middle" className="lab-donut__value">
          {focus ? `${((focus.value / total) * 100).toFixed(0)}%` : fmt(total, format)}
        </text>
        <text x="70" y="85" textAnchor="middle" className="lab-donut__label">
          {focus ? focus.label.slice(0, 18) : "total"}
        </text>
      </svg>
      <ul className="lab-donut__legend">
        {parts.map((part, i) => (
          <li key={part.label} className={active === i ? "is-active" : ""} onPointerEnter={() => setActive(i)} onPointerLeave={() => setActive(null)}>
            <i style={{ background: part.label === "Other" || part.label === "Everything else" ? "var(--qc-ink-3)" : series(i) }} />
            <span>{part.label}</span>
            <b>{fmt(part.value, format)}</b>
            <small>{((part.value / total) * 100).toFixed(0)}%</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Trend({ chart, visible }: { chart: Extract<AnswerChart, { kind: "trend" }>; visible: boolean }) {
  const width = 720;
  const height = 280;
  const pad = { top: 18, right: 18, bottom: 30, left: 62 };
  const ref = useRef<SVGSVGElement>(null);
  const [index, setIndex] = useState<number | null>(null);
  const actual = chart.rows;
  const all = [...actual.map((p) => ({ ...p, low: p.value, high: p.value, forecast: false })), ...chart.forecast.map((p) => ({ ...p, avg: p.value, forecast: true }))];
  const n = all.length;
  const last = actual.length - 1;
  const x = scaleLinear().domain([0, Math.max(1, n - 1)]).range([pad.left, width - pad.right]);
  const lo = Math.min(...all.map((p) => p.low));
  const hi = Math.max(...all.map((p) => p.high));
  const y = scaleLinear().domain([Math.max(0, lo - (hi - lo) * 0.25), hi + (hi - lo) * 0.08 || 1]).nice(4).range([height - pad.bottom, pad.top]);
  const curve = (values: number[], start = 0) => line<number>().x((_, i) => x(i + start)).y((v) => y(v)).curve(curveMonotoneX)(values) ?? "";
  const fill = area<number>().x((_, i) => x(i)).y0(y(y.domain()[0])).y1((v) => y(v)).curve(curveMonotoneX)(actual.map((p) => p.value)) ?? "";
  const tail = [all[last], ...all.slice(last + 1)];
  const band = area<(typeof all)[number]>().x((_, i) => x(i + last)).y0((d) => y(d.low)).y1((d) => y(d.high)).curve(curveMonotoneX)(tail) ?? "";
  const every = Math.ceil(n / 8);
  const point = index != null ? all[index] : null;

  return (
    <div className="lab-chart">
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        className={`lab-svg lab-revenue ${visible ? "is-in" : ""}`}
        onPointerMove={(e) => {
          const box = ref.current?.getBoundingClientRect();
          if (box) setIndex(Math.max(0, Math.min(n - 1, Math.round(x.invert(((e.clientX - box.left) / box.width) * width)))));
        }}
        onPointerLeave={() => setIndex(null)}
        role="img"
        aria-label={chart.title}
      >
        <defs>
          <linearGradient id="lab-line-grad" x1="0" x2="1">
            <stop offset="0%" style={{ stopColor: "var(--qc-accent)" }} />
            <stop offset="100%" style={{ stopColor: "var(--qc-accent-2)" }} />
          </linearGradient>
          <linearGradient id="lab-answer-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--lab-hi)", stopOpacity: 0.32 }} />
            <stop offset="100%" style={{ stopColor: "var(--lab-hi)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        {y.ticks(4).map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="lab-gridline" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="lab-axis">
              {fmt(t, chart.format)}
            </text>
          </g>
        ))}
        {all.map((p, i) =>
          i % every === 0 || i === n - 1 ? (
            <text key={p.label} x={x(i)} y={height - 8} textAnchor="middle" className={`lab-axis ${p.forecast ? "is-forecast" : ""}`}>
              {p.label}
            </text>
          ) : null,
        )}
        {chart.forecast.length > 0 && <rect x={x(last)} y={pad.top} width={x(n - 1) - x(last) + 6} height={height - pad.top - pad.bottom} className="lab-revenue__future" />}
        <path d={fill} fill="url(#lab-answer-fill)" className="lab-fade" />
        {chart.forecast.length > 0 && <path d={band} className="lab-revenue__band lab-fade" />}
        <path d={curve(actual.map((p) => p.avg))} pathLength={1} className="lab-draw lab-revenue__avg" />
        <path d={curve(actual.map((p) => p.value))} pathLength={1} className="lab-draw lab-revenue__line" />
        {chart.forecast.length > 0 && <path d={curve(tail.map((p) => p.value), last)} className="lab-revenue__forecast lab-fade" />}
        {all.map((p, i) => (
          <circle key={p.label} cx={x(i)} cy={y(p.value)} r={index === i ? 6 : 3.2} className={`lab-revenue__dot ${p.forecast ? "is-forecast" : ""}`} style={{ animationDelay: `${500 + i * 50}ms` }} />
        ))}
        {point && index != null && <line x1={x(index)} x2={x(index)} y1={pad.top} y2={height - pad.bottom} className="lab-cross" />}
      </svg>
      {point && index != null && (
        <Tip x={(x(index) / width) * 100} y={(y(point.value) / height) * 100}>
          <b>
            {point.label}
            {point.forecast ? " · forecast" : ""}
          </b>
          <span>{fmt(point.value, chart.format, false)}</span>
          {point.forecast ? <span>80% range {fmt(point.low, chart.format)} – {fmt(point.high, chart.format)}</span> : <span>3-period avg {fmt(point.avg, chart.format)}</span>}
        </Tip>
      )}
      <div className="lab-legend">
        <span>
          <i className="lab-legend__line" /> Actual
        </span>
        <span>
          <i className="lab-legend__line is-dashed" /> Moving average
        </span>
        {chart.forecast.length > 0 && (
          <span>
            <i className="lab-legend__band" /> Forecast (80% range)
          </span>
        )}
      </div>
    </div>
  );
}

/** Two-way grouping as a bubble matrix: bubble size and colour both encode the value. */
function Heat({ chart, visible }: { chart: Extract<AnswerChart, { kind: "heatmap" }>; visible: boolean }) {
  const [hover, setHover] = useState<string | null>(null);
  const values = chart.cells.map((c) => c.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const cell = new Map(chart.cells.map((c) => [`${c.row}|${c.col}`, c.value]));
  const labelW = 150;
  const colW = Math.max(70, Math.min(130, 560 / Math.max(1, chart.cols.length)));
  const rowH = 36;
  const top = 30;
  const width = labelW + colW * chart.cols.length;
  const height = top + rowH * chart.rows.length + 4;
  const hovered = hover ? chart.cells.find((c) => `${c.row}|${c.col}` === hover) : null;
  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-bubbles ${visible ? "is-in" : ""}`} role="img" aria-label={chart.title}>
        {chart.cols.map((col, c) => (
          <text key={col} x={labelW + colW * c + colW / 2} y={14} textAnchor="middle" className="lab-bubbles__axis">
            {col.length > 14 ? `${col.slice(0, 13)}…` : col}
          </text>
        ))}
        {chart.rows.map((row, r) => {
          const y = top + rowH * r + rowH / 2;
          return (
            <g key={row}>
              <line x1={labelW - 6} x2={width - 8} y1={y} y2={y} className="lab-bubbles__guide" />
              <text x={labelW - 12} y={y} dy="0.35em" textAnchor="end" className="lab-bubbles__axis">
                {row.length > 20 ? `${row.slice(0, 19)}…` : row}
              </text>
              {chart.cols.map((col, c) => {
                const v = cell.get(`${row}|${col}`);
                if (v == null) return null;
                const t = (v - lo) / (hi - lo || 1);
                return (
                  <g key={col} transform={`translate(${labelW + colW * c + colW / 2},${y})`} className="lab-bubble" onPointerEnter={() => setHover(`${row}|${col}`)} onPointerLeave={() => setHover(null)}>
                    <circle r={5 + t * 11} className="lab-bubble__dot" style={{ fill: shade(0.05 + t * 0.95), animationDelay: `${(r * chart.cols.length + c) * 25}ms` }} />
                    {hover === `${row}|${col}` && <circle r={21} className="lab-bubble__ring" />}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {hovered && (
        <Tip x={((labelW + colW * chart.cols.indexOf(hovered.col) + colW / 2) / width) * 100} y={((top + rowH * chart.rows.indexOf(hovered.row) + 6) / height) * 100}>
          <b>
            {hovered.row} · {hovered.col}
          </b>
          <span>{fmt(hovered.value, chart.format, false)}</span>
        </Tip>
      )}
      <div className="lab-legend">
        <span className="lab-legend__ramp" aria-hidden="true" />
        <span>Bigger and hotter = higher</span>
      </div>
    </div>
  );
}

function Scatter({ chart, visible }: { chart: Extract<AnswerChart, { kind: "scatter" }>; visible: boolean }) {
  const width = 720;
  const height = 320;
  const pad = { top: 16, right: 18, bottom: 40, left: 66 };
  const [hover, setHover] = useState<number | null>(null);
  const { x, y } = useMemo(() => {
    const xs = chart.points.map((p) => p.x);
    const ys = chart.points.map((p) => p.y);
    const make = (lo: number, hi: number, range: [number, number]) =>
      chart.log ? scaleLog().domain([lo * 0.85, hi * 1.15]).range(range) : scaleLinear().domain([Math.min(0, lo), hi * 1.08]).nice().range(range);
    return { x: make(Math.min(...xs), Math.max(...xs), [pad.left, width - pad.right]), y: make(Math.min(...ys), Math.max(...ys), [height - pad.bottom, pad.top]) };
  }, [chart, pad.left, pad.right, pad.top, pad.bottom]);
  const predict = (v: number) => (chart.log ? 10 ** (chart.slope * Math.log10(v) + chart.intercept) : chart.slope * v + chart.intercept);
  const [x0, x1] = x.domain();
  const p = hover != null ? chart.points[hover] : null;
  const ticks = (scale: typeof x) => (chart.log ? scale.ticks(4).filter((t) => /^[125]/.test(String(t))) : scale.ticks(5));

  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${width} ${height}`} className={`lab-svg lab-scatter ${visible ? "is-in" : ""}`} role="img" aria-label={`${chart.title}, correlation ${chart.r}`}>
        {ticks(y).map((t) => (
          <g key={`y${t}`}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className="lab-gridline" />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="lab-axis">
              {fmt(t, chart.y_format)}
            </text>
          </g>
        ))}
        {ticks(x).map((t) => (
          <text key={`x${t}`} x={x(t)} y={height - pad.bottom + 18} textAnchor="middle" className="lab-axis">
            {fmt(t, chart.x_format)}
          </text>
        ))}
        <text x={width - pad.right} y={height - 4} textAnchor="end" className="lab-axis lab-axis--title">
          {chart.x_label}
          {chart.log ? " (log)" : ""} →
        </text>
        {chart.points.map((pt, i) => {
          const ratio = pt.y / Math.max(predict(pt.x), 1e-9);
          const t = Math.max(0, Math.min(1, (Math.log2(Math.max(ratio, 1e-6)) + 1) / 2));
          return (
            <circle
              key={`${pt.label}-${i}`}
              cx={x(pt.x)}
              cy={y(pt.y)}
              r={hover === i ? 7 : 4}
              className="lab-dot"
              style={{ fill: shade(0.25 + t * 0.75), animationDelay: `${(i % 50) * 16}ms` }}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
            />
          );
        })}
        <line x1={x(x0)} y1={y(Math.max(predict(x0), y.domain()[0]))} x2={x(x1)} y2={y(Math.min(predict(x1), y.domain()[1]))} pathLength={1} className="lab-fit" />
      </svg>
      {p && (
        <Tip x={(x(p.x) / width) * 100} y={(y(p.y) / height) * 100}>
          {p.label && <b>{p.label}</b>}
          <span>
            {chart.x_label}: {fmt(p.x, chart.x_format, false)}
          </span>
          <span>
            {chart.y_label}: {fmt(p.y, chart.y_format, false)}
          </span>
        </Tip>
      )}
      <div className="lab-legend">
        <span className="lab-legend__ramp" aria-hidden="true" />
        <span>Brighter = above the trend line</span>
        <span>
          r = <b>{chart.r.toFixed(2)}</b>
        </span>
      </div>
    </div>
  );
}

function Compare({ chart, visible }: { chart: Extract<AnswerChart, { kind: "compare" }>; visible: boolean }) {
  return (
    <ol className={`lab-compare ${visible ? "is-in" : ""}`}>
      {chart.rows.map((row, i) => {
        const max = Math.max(row.value, row.baseline) || 1;
        const ratio = row.baseline ? row.value / row.baseline : 0;
        return (
          <li key={row.label} className="lab-compare__row">
            <span className="lab-compare__label">
              {row.label}
              <b className={ratio >= 1 ? "is-up" : "is-down"}>{ratio >= 1 ? `${ratio.toFixed(1)}×` : `−${((1 - ratio) * 100).toFixed(0)}%`}</b>
            </span>
            <span className="lab-compare__track">
              <span className="lab-compare__bar" style={{ width: `${(row.value / max) * 100}%`, animationDelay: `${i * 90}ms` }} />
              <span className="lab-compare__base" style={{ left: `${(row.baseline / max) * 100}%` }} title={`Average ${fmt(row.baseline, row.format, false)}`} />
            </span>
            <span className="lab-compare__value">
              {fmt(row.value, row.format)}
              <small>avg {fmt(row.baseline, row.format)}</small>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Pareto({ chart, visible }: { chart: Extract<AnswerChart, { kind: "pareto" }>; visible: boolean }) {
  const w = 420;
  const h = 260;
  const pad = { top: 12, right: 14, bottom: 30, left: 42 };
  const x = scaleLinear().domain([0, 1]).range([pad.left, w - pad.right]);
  const y = scaleLinear().domain([0, 1]).range([h - pad.bottom, pad.top]);
  const lineGen = line<{ x: number; y: number }>().x((d) => x(d.x)).y((d) => y(d.y)).curve(curveMonotoneX);
  const gap = area<{ x: number; y: number }>().x((d) => x(d.x)).y0((d) => y(d.x)).y1((d) => y(d.y)).curve(curveMonotoneX);
  const mark = chart.share_for_80;
  return (
    <div className="lab-chart">
      <svg viewBox={`0 0 ${w} ${h}`} className={`lab-svg lab-pareto ${visible ? "is-in" : ""}`} role="img" aria-label={`${(mark * 100).toFixed(0)}% of groups make 80% of the total`}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={w - pad.right} y1={y(t)} y2={y(t)} className="lab-gridline" />
            <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" className="lab-axis">
              {t * 100}%
            </text>
          </g>
        ))}
        <path d={gap(chart.curve) ?? ""} className="lab-pareto__gap" />
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="lab-pareto__equal" />
        <path d={lineGen(chart.curve) ?? ""} pathLength={1} className="lab-draw lab-pareto__line" />
        <g className="lab-pareto__mark">
          <line x1={x(mark)} x2={x(mark)} y1={y(0)} y2={y(0.8)} />
          <circle cx={x(mark)} cy={y(0.8)} r={4.5} />
          <text x={Math.min(x(mark) + 8, w - 170)} y={y(0.8) + 16}>
            {(mark * 100).toFixed(0)}% of groups → 80%
          </text>
        </g>
        <text x={w - pad.right} y={h - 6} textAnchor="end" className="lab-axis lab-axis--title">
          Groups, largest first →
        </text>
      </svg>
      <div className="lab-legend">
        <span>
          Gini <b>{chart.gini.toFixed(2)}</b>
        </span>
        <span>
          Top 10% hold <b>{(chart.top10_share * 100).toFixed(0)}%</b>
        </span>
      </div>
    </div>
  );
}

function ChartBody({ chart, visible }: { chart: AnswerChart; visible: boolean }) {
  switch (chart.kind) {
    case "bars":
      return <Bars rows={chart.rows} format={chart.format} visible={visible} />;
    case "donut":
      return <Donut rows={chart.rows} format={chart.format} visible={visible} />;
    case "trend":
      return <Trend chart={chart} visible={visible} />;
    case "heatmap":
      return <Heat chart={chart} visible={visible} />;
    case "scatter":
      return <Scatter chart={chart} visible={visible} />;
    case "compare":
      return <Compare chart={chart} visible={visible} />;
    case "pareto":
      return <Pareto chart={chart} visible={visible} />;
  }
}

const WIDE = new Set(["trend", "scatter", "heatmap"]);

/** The numbers behind a chart as CSV rows (header first). */
function chartRows(chart: AnswerChart): (string | number)[][] {
  switch (chart.kind) {
    case "bars":
    case "donut":
      return [["label", "value"], ...chart.rows.map((r) => [r.label, r.value])];
    case "trend":
      return [["period", "value", "moving_average", "forecast_low", "forecast_high"], ...chart.rows.map((r) => [r.label, r.value, r.avg, "", ""]), ...chart.forecast.map((f) => [f.label, f.value, "", f.low, f.high])];
    case "heatmap":
      return [["row", "column", "value"], ...chart.cells.map((c) => [c.row, c.col, c.value])];
    case "scatter":
      return [["label", chart.x_label, chart.y_label], ...chart.points.map((p) => [p.label, p.x, p.y])];
    case "compare":
      return [["measure", "value", "average"], ...chart.rows.map((r) => [r.label, r.value, r.baseline])];
    case "pareto":
      return [["share_of_groups", "share_of_total"], ...chart.curve.map((c) => [c.x, c.y])];
  }
}

function downloadCsv(chart: AnswerChart) {
  const quote = (v: string | number) => (typeof v === "number" ? String(v) : `"${String(v).replace(/"/g, '""')}"`);
  const csv = chartRows(chart).map((row) => row.map(quote).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${chart.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "chart"}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ card */

/** The whole analysis. `compact` (inline in chat) shows the first two charts; the side panel shows all. */
export function VisualAnalysisView({ data, compact = false, actions }: { data: VisualAnalysis; compact?: boolean; actions?: React.ReactNode }) {
  const { ref, visible } = useReveal<HTMLElement>();
  const charts = compact ? data.charts.slice(0, 2) : data.charts;
  const insights = compact ? data.insights.slice(0, 4) : data.insights;
  return (
    <section ref={ref} className={`lab-answer ${compact ? "is-compact" : ""} ${visible ? "is-visible" : ""}`} aria-label="Visual analysis">
      <header className="lab-answer__head">
        <span className="lab-answer__badge">
          <Lightbulb size={14} />
        </span>
        <div>
          <p className="lab-answer__eyebrow">Visual analysis{data.collection ? ` · ${data.collection}` : ""}</p>
          <h3 className="lab-answer__title">{data.title}</h3>
        </div>
        {actions}
      </header>

      {data.stats.length > 0 && (
        <div className="lab-answer__stats">
          {data.stats.map((stat, i) => (
            <div key={stat.label} className="lab-answer__stat" style={{ animationDelay: `${i * 70}ms`, ["--kpi" as string]: series(i) }}>
              <span className="lab-answer__stat-label">{stat.label}</span>
              <strong>
                <CountUp value={stat.value} format={stat.format} start={visible} duration={1100} />
              </strong>
              {stat.hint && <small>{stat.hint}</small>}
            </div>
          ))}
        </div>
      )}

      {charts.length > 0 && (
        <div className="lab-answer__charts">
          {charts.map((chart, i) => (
            <figure key={`${chart.kind}-${chart.title}-${i}`} className={`lab-answer__chart ${WIDE.has(chart.kind) || charts.length === 1 ? "is-wide" : ""}`}>
              <figcaption>
                <span>{chart.title}</span>
                <button type="button" className="lab-icon-button" onClick={() => downloadCsv(chart)} title="Download the data as CSV" aria-label={`Download ${chart.title} as CSV`}>
                  <Download size={13} />
                </button>
              </figcaption>
              <ChartBody chart={chart} visible={visible} />
            </figure>
          ))}
        </div>
      )}

      {insights.length > 0 && (
        <ul className="lab-answer__insights">
          {insights.map((card, i) => (
            <li key={`${card.title}-${i}`} className={`lab-answer__insight is-${card.kind}`} style={{ animationDelay: `${300 + i * 80}ms`, ["--ins" as string]: series(i + 2) }}>
              <span className="lab-answer__insight-icon">{ICONS[card.kind] ?? <Lightbulb size={15} />}</span>
              <span>
                <b>{card.title}</b>
                <small>{card.detail}</small>
              </span>
              {card.value && <em>{card.value}</em>}
            </li>
          ))}
        </ul>
      )}
      {compact && data.charts.length > charts.length && <p className="lab-answer__more">+{data.charts.length - charts.length} more view{data.charts.length - charts.length > 1 ? "s" : ""} in Explore</p>}
    </section>
  );
}
