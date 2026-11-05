"use client";

import { useEffect, useState } from "react";
import { Globe2, MapPin, Maximize2, Sparkles } from "lucide-react";

import { CountUp } from "@/components/lab/shared";
import { WorldGlobe } from "@/components/world-globe";
import { formatValue, metricFormat, type GeoPayload } from "@/lib/geo";

/**
 * Country spotlight: the chat card for an answer about one country or city
 * ("companies in India"). A gradient hero tinted by continent, the country
 * name, the answer's number counting up, its share as a ring, a globe that
 * flies to the place, and the geographic findings as colour chips.
 */

const CONTINENT_HUE: Record<string, [string, string]> = {
  Asia: ["#f97316", "#e11d48"],
  Europe: ["#3b82f6", "#8b5cf6"],
  "North America": ["#0ea5e9", "#22c55e"],
  "South America": ["#22c55e", "#eab308"],
  Africa: ["#f59e0b", "#dc2626"],
  Oceania: ["#06b6d4", "#6366f1"],
};
const CHIP_HUES = ["#f97316", "#8b5cf6", "#0ea5e9", "#22c55e", "#e11d48", "#eab308"];

export function CountrySpotlight({ data, onOpen }: { data: GeoPayload; onOpen?: () => void }) {
  const place = data.places[0];
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const [a, b] = CONTINENT_HUE[place.continent] ?? ["#6366f1", "#ec4899"];
  const format = metricFormat(data.metric);
  const share = typeof place.share === "number" ? place.share : null;
  return (
    <section className="qc-spotlight" style={{ ["--spot-a" as string]: a, ["--spot-b" as string]: b }} aria-label={`${place.name} spotlight`}>
      <div className="qc-spotlight__glow" aria-hidden="true" />
      <div className="qc-spotlight__body">
        <header className="qc-spotlight__head">
          <span className="qc-spotlight__pin"><MapPin size={16} /></span>
          <div>
            <p className="qc-spotlight__eyebrow">{place.kind === "city" ? `City · ${place.country ?? place.continent}` : `Country · ${place.continent}`}</p>
            <h3 className="qc-spotlight__name">{place.name}</h3>
          </div>
          {onOpen && (
            <button type="button" className="qc-spotlight__open" onClick={onOpen}>
              <Maximize2 size={13} /> Explore
            </button>
          )}
        </header>

        <div className="qc-spotlight__stats">
          {typeof place.value === "number" && (
            <div className="qc-spotlight__stat">
              <span className="qc-spotlight__value"><CountUp value={place.value} format={format} start={on} /></span>
              <span className="qc-spotlight__label">{data.metric ?? "records"}</span>
            </div>
          )}
          {share != null && (
            <div className="qc-spotlight__stat qc-spotlight__stat--ring">
              <svg viewBox="0 0 44 44" aria-hidden="true">
                <circle cx="22" cy="22" r="18" className="qc-spotlight__ring-track" />
                <circle cx="22" cy="22" r="18" pathLength={1} className="qc-spotlight__ring-arc" style={{ strokeDasharray: `${on ? share : 0} 1` }} />
              </svg>
              <span>
                <span className="qc-spotlight__value qc-spotlight__value--small">{formatValue(share, "percent")}</span>
                <span className="qc-spotlight__label">of the total</span>
              </span>
            </div>
          )}
          {data.total != null && typeof place.value === "number" && data.total !== place.value && (
            <div className="qc-spotlight__stat">
              <span className="qc-spotlight__value qc-spotlight__value--small">{formatValue(data.total, format)}</span>
              <span className="qc-spotlight__label">across all places</span>
            </div>
          )}
        </div>

        {data.insights.length > 0 && (
          <ul className="qc-spotlight__chips">
            {data.insights.slice(0, 3).map((insight, i) => (
              <li key={insight.title} style={{ ["--chip" as string]: CHIP_HUES[i % CHIP_HUES.length], animationDelay: `${300 + i * 120}ms` }}>
                <Sparkles size={12} /> <b>{insight.title}</b> <span>{insight.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="qc-spotlight__globe">
        <WorldGlobe places={data.places} regions={data.regions} metric={data.metric} compact initialView="focus" />
        <span className="qc-spotlight__globe-tag"><Globe2 size={12} /> {place.continent}</span>
      </div>
    </section>
  );
}

/** Colour for the i-th place chip in multi-place answers. */
export function chipHue(i: number) {
  return CHIP_HUES[i % CHIP_HUES.length];
}
