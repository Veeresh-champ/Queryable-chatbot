"use client";

import { useEffect, useRef, useState } from "react";

import { formatValue, type ValueFormat } from "@/lib/geo";

/**
 * Shared model for the Analytics lab: payload types, the cross-view focus
 * (click a country, industry, tool, category or deployment once and every
 * view follows it), the single-hue green scale and the reveal/count-up
 * animation hooks.
 */

export type Dim = "country" | "industry" | "deployment" | "technology" | "category" | "segment";
export type Focus = { dim: Dim; name: string } | null;

export type Point = {
  name: string;
  industry: string;
  country: string;
  technology: string;
  category: string;
  deployment: string;
  segment: string;
  employees: number;
  spend: number;
};

export type Kpi = { id: string; label: string; value: number; format: ValueFormat; hint: string; spark?: number[] };
export type LabInsight = { kind: string; title: string; detail: string; view: string };
export type FlowData = {
  stages: string[];
  nodes: { id: string; name: string; stage: number }[];
  links: { source: string; target: string; value: number; companies: number }[];
};
export type NetworkData = {
  nodes: { id: string; name: string; group: "industry" | "technology"; companies: number; spend: number }[];
  links: { source: string; target: string; companies: number; spend: number }[];
};
export type ChordData = { names: string[]; groups: ("country" | "category")[]; matrix: number[][] };
export type HeatmapData = { rows: string[]; cols: string[] };
export type Fit = { slope: number; intercept: number; r: number; r2: number };
export type ParetoData = {
  curve: { x: number; y: number }[];
  companies_for_80: number;
  share_for_80: number;
  top10_share: number;
  gini: number;
};
export type Spender = { name: string; industry: string; country: string; employees: number; spend: number; expected: number; ratio: number };
export type OutlierData = { median_per_employee: number; over: Spender[]; under: Spender[] };
export type RevenuePoint = { label: string; value: number; orders: number; moving_avg: number };
export type Segment = {
  id: number;
  name: string;
  companies: number;
  spend: number;
  avg_spend: number;
  avg_employees: number;
  per_employee: number;
  top_industry: string;
  size_z: number;
  intensity_z: number;
};
export type Driver = { factor: string; score: number };
export type StreamData = { categories: string[]; months: ({ label: string } & Record<string, number | string>)[] };
export type RevenueData = {
  series: RevenuePoint[];
  forecast: { label: string; value: number; low: number; high: number }[];
  slope_per_month: number;
  volatility: number;
};

export type LabData = {
  kpis: Kpi[];
  insights: LabInsight[];
  flow: FlowData;
  network: NetworkData;
  chord: ChordData;
  heatmap: HeatmapData;
  scatter: { points: Point[]; fit: Fit };
  pareto: ParetoData;
  outliers: OutlierData;
  revenue: RevenueData | null;
  segments: Segment[];
  drivers: { spend: Driver[]; intensity: Driver[] };
  streams: StreamData | null;
  briefing: string;
};

export const DIM_LABEL: Record<Dim, string> = {
  country: "Country",
  industry: "Industry",
  deployment: "Deployment",
  technology: "HR tool",
  category: "Tech category",
  segment: "Segment",
};

export function matches(point: Point, focus: Focus) {
  return !focus || point[focus.dim] === focus.name;
}

export function isFocus(focus: Focus, dim: Dim, name: string) {
  return focus?.dim === dim && focus.name === name;
}

/** Sequential three-stop ramp (--lab-lo → --lab-mid → --lab-hi): t = 0 is the quiet end, 1 the hottest. */
export function shade(t: number) {
  const v = Math.max(0, Math.min(1, t));
  if (v <= 0.5) return `color-mix(in oklab, var(--lab-mid) ${Math.round(v * 200)}%, var(--lab-lo))`;
  return `color-mix(in oklab, var(--lab-hi) ${Math.round((v - 0.5) * 200)}%, var(--lab-mid))`;
}

/** Categorical colour i from the eight-hue series palette (globals.css). */
export function series(i: number) {
  return `var(--qc-series-${(((i % 8) + 8) % 8) + 1})`;
}

export const money = (value: number) => formatValue(value, "currency");
export const count = (value: number) => formatValue(value, "number");

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** true once the element has scrolled into view (animations start then, once). */
export function useReveal<T extends Element>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      const id = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(id);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);
  return { ref, visible };
}

/** Formats a value; "multiple" renders ratios such as 4.9×. */
export type AnyFormat = ValueFormat | "multiple";
export function fmt(value: number, format: AnyFormat = "number", compact = true) {
  if (format === "multiple") return `${value.toFixed(value >= 10 ? 0 : 1)}×`;
  if (format === "number" && Math.abs(value) < 10 && !Number.isInteger(value)) return value.toFixed(2);
  return formatValue(value, format, compact);
}

/** Animated number that eases up to `value` once `start` is true. */
export function CountUp({ value, format, start, duration = 1400 }: { value: number; format: AnyFormat; start: boolean; duration?: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!start) return;
    if (reducedMotion()) {
      const id = requestAnimationFrame(() => setShown(value));
      return () => cancelAnimationFrame(id);
    }
    let frame = 0;
    const begin = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - begin) / duration);
      setShown(value * (1 - Math.pow(1 - t, 4)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, start, duration]);
  return <>{fmt(Number.isInteger(value) ? Math.round(shown) : shown, format)}</>;
}

/** Floating tooltip positioned in percent of its (relative) chart wrapper. */
export function Tip({ x, y, children }: { x: number; y: number; children: React.ReactNode }) {
  return (
    <div className="lab-tip" style={{ left: `${x}%`, top: `${y}%` }} role="status">
      {children}
    </div>
  );
}
