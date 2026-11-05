"use client";

import { defineArtifactRenderer } from "@openuidev/react-ui";
import {
  ArrowDownRight,
  ArrowUpRight,
  Crown,
  Gauge,
  Globe2,
  Layers,
  Lightbulb,
  Maximize2,
  Mountain,
  Scale,
  Sigma,
  Target,
  TrendingUp,
} from "lucide-react";

import { BarList, Sparkline, TrendChart } from "@/components/charts";
import { CountrySpotlight, chipHue } from "@/components/country-spotlight";
import { GeoInsightList, GeoPanel } from "@/components/geo-panel";
import { VisualAnalysisView, type VisualAnalysis } from "@/components/lab/answer-charts";
import { WorldGlobe } from "@/components/world-globe";
import { formatValue, metricFormat, parseJSON, type GeoPayload, type InsightsPayload } from "@/lib/geo";

/**
 * Renderers for the backend's analysis tool calls (backend/chat_service.py
 * analysis_events): `geo_map` draws every place in the answer on a world map,
 * `data_insights` shows the deterministic insight cards. Both are inline
 * cards in the chat with a full view in the side panel.
 */

type GeoProps = { data: GeoPayload | null; question: string };

const SOURCE_LABEL: Record<string, string> = {
  database: "from the query result",
  question: "named in your question",
  answer: "mentioned in the answer",
};

export const geoMapRenderer = defineArtifactRenderer<GeoProps>({
  type: "qc_geo_map",
  toolName: "geo_map",
  parser: ({ args, response }) => {
    const data = parseJSON<GeoPayload>(response);
    const question = parseJSON<{ question?: string }>(args)?.question ?? "";
    if (data && !data.places?.length && !data.regions?.length) return null;
    const regionNames = (data?.regions ?? []).map((r) => r.name);
    const id = `geo-${(data?.places ?? []).map((p) => p.key).join("|")}-${regionNames.join("|")}-${question.length}`;
    return {
      props: { data, question },
      meta: data
        ? {
            id,
            version: 1,
            heading: `Globe · ${
              data.places.length
                ? [...data.places]
                    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
                    .slice(0, 3)
                    .map((p) => p.name)
                    .join(", ")
                : regionNames.join(", ")
            }`,
          }
        : null,
    };
  },
  preview: ({ data }, controls) => {
    if (!data) {
      return (
        <div className="qc-geo-card qc-geo-card--loading">
          <Globe2 size={16} /> Locating places…
        </div>
      );
    }
    if (data.places.length === 1) return <CountrySpotlight data={data} onOpen={controls.open} />;
    const format = metricFormat(data.metric);
    const top = [...data.places].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 4);
    return (
      <section className="qc-geo-card" aria-label="Geographic view">
        <header className="qc-geo-card__head">
          <span className="qc-geo-card__badge">
            <Globe2 size={14} />
          </span>
          <div className="qc-geo-card__title">
            <strong>
              {data.places.length === 0
                ? (data.regions ?? []).map((r) => r.name).join(" · ")
                : data.places.length === 1
                  ? data.places[0].name
                  : `${data.places.length} places on the globe`}
            </strong>
            <span className="qc-muted">
              {data.continents.join(" · ")} — {SOURCE_LABEL[data.source ?? ""] ?? "geographic view"}
            </span>
          </div>
          <button type="button" className="qc-ghost-button" onClick={controls.open}>
            <Maximize2 size={13} /> Full analysis
          </button>
        </header>
        <WorldGlobe places={data.places} regions={data.regions} metric={data.metric} compact />
        <div className="qc-geo-card__chips">
          {top.map((place, i) => (
            <span key={place.key} className="qc-place-chip qc-place-chip--color" style={{ ["--chip" as string]: chipHue(i) }}>
              <span className="qc-place-chip__dot" />
              {place.name}
              {typeof place.value === "number" && <b>{formatValue(place.value, format)}</b>}
            </span>
          ))}
          {data.places.length > top.length && <span className="qc-muted">+{data.places.length - top.length} more</span>}
        </div>
        <GeoInsightList insights={data.insights.slice(0, 2)} />
      </section>
    );
  },
  actual: ({ data }) => (data ? <GeoPanel data={data} /> : null),
  label: "Globe",
  icon: <Globe2 size={16} />,
});

const INSIGHT_ICONS: Record<string, React.ReactNode> = {
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

type InsightProps = { data: InsightsPayload | null };

export function InsightCards({ data }: { data: InsightsPayload }) {
  return (
    <div className="qc-insight-grid">
      {data.insights.map((card, index) => (
        <article key={card.title} className={`qc-insight qc-insight--${card.kind}`} style={{ animationDelay: `${index * 60}ms` }}>
          <span className="qc-insight__icon">{INSIGHT_ICONS[card.kind] ?? <Lightbulb size={15} />}</span>
          <span className="qc-insight__value">{card.value}</span>
          <span className="qc-insight__title">{card.title}</span>
          <span className="qc-insight__detail">{card.detail}</span>
          {index === 0 && data.shape === "time" && <Sparkline values={data.series.map((s) => s.value)} />}
        </article>
      ))}
    </div>
  );
}

export const dataInsightsRenderer = defineArtifactRenderer<InsightProps>({
  type: "qc_data_insights",
  toolName: "data_insights",
  parser: ({ response }) => {
    const data = parseJSON<InsightsPayload>(response);
    if (data && !data.insights?.length) return null;
    return { props: { data }, meta: null };
  },
  preview: ({ data }, controls) =>
    data ? (
      <section className="qc-insight-strip" aria-label="Key insights">
        <header>
          <Lightbulb size={14} /> <strong>Key insights</strong>
          <span className="qc-muted"> · {data.groups} {data.shape === "time" ? "periods" : "groups"} · {data.metric}</span>
          <button type="button" className="qc-ghost-button" onClick={controls.open}>
            <Maximize2 size={13} /> Explore
          </button>
        </header>
        <InsightCards data={data} />
      </section>
    ) : null,
  actual: ({ data }) =>
    data ? (
      <div className="qc-geo-panel">
        <header className="qc-geo-panel__head">
          <div>
            <p className="qc-eyebrow">
              <Lightbulb size={13} /> Data insights
            </p>
            <h2>{data.metric}</h2>
          </div>
        </header>
        <InsightCards data={data} />
        <section className="qc-tile">
          <h3 className="qc-tile__title">{data.shape === "time" ? "Over time" : "Ranking"}</h3>
          {data.shape === "time" ? (
            <TrendChart rows={data.series} format={metricFormat(data.metric)} />
          ) : (
            <BarList rows={data.series} format={metricFormat(data.metric)} max={24} />
          )}
        </section>
      </div>
    ) : null,
  label: "Insights",
  icon: <Lightbulb size={16} />,
});

type VisualProps = { data: VisualAnalysis | null };

/** Every database answer: stats, the best-fitting charts and findings (backend/analytics.py answer_analysis). */
export const visualAnalysisRenderer = defineArtifactRenderer<VisualProps>({
  type: "qc_visual_analysis",
  toolName: "visual_analysis",
  parser: ({ response }) => {
    const data = parseJSON<VisualAnalysis>(response);
    if (data && !data.charts?.length && !data.insights?.length) return null;
    return {
      props: { data },
      meta: data ? { id: `visual-${data.title}-${data.charts.length}-${data.stats.map((s) => s.value).join("|")}`, version: 1, heading: data.title } : null,
    };
  },
  preview: ({ data }, controls) =>
    data ? (
      <VisualAnalysisView
        data={data}
        compact
        actions={
          <button type="button" className="qc-ghost-button" onClick={controls.open}>
            <Maximize2 size={13} /> Explore
          </button>
        }
      />
    ) : (
      <div className="qc-geo-card qc-geo-card--loading">
        <Lightbulb size={16} /> Analysing the result…
      </div>
    ),
  actual: ({ data }) =>
    data ? (
      <div className="qc-geo-panel">
        <VisualAnalysisView data={data} />
      </div>
    ) : null,
  label: "Analysis",
  icon: <Lightbulb size={16} />,
});

// ---------------------------------------------------------------- next best actions

type ActionEvidence = { label: string; value: string | number; why: string };
type ActionAccount = { name: string; country: string | null; dataset_label: string; evidence: ActionEvidence[] };
type ActionCase = {
  id?: string;
  title: string;
  for: string;
  action: string;
  timing: string;
  accounts: number;
  considered: number;
  status?: string;
  missing?: string | null;
  top?: ActionAccount[];
  top_accounts?: { name: string; country: string | null; dataset: string; evidence: string[] }[];
};
type ActionsPayload = { scope: string[]; accounts: number; use_cases: ActionCase[] };

function firstEvidence(c: ActionCase) {
  if (c.top?.[0]) {
    const e = c.top[0].evidence[0];
    return e ? `${c.top[0].name}: ${e.label} ${String(e.value).slice(0, 60)} (${e.why})` : c.top[0].name;
  }
  const a = c.top_accounts?.[0];
  return a ? `${a.name}: ${a.evidence[0] ?? ""}` : "";
}

function ActionsList({ data, full }: { data: ActionsPayload; full?: boolean }) {
  const cases = full ? data.use_cases : data.use_cases.filter((c) => !c.status || c.status === "ready").slice(0, 3);
  return (
    <div className="qc-nba__list">
      {cases.map((c) => {
        const ready = !c.status || c.status === "ready";
        return (
          <div key={c.title} className="qc-nba__item">
            <strong>{c.title}</strong>
            <span>{ready ? `${c.accounts.toLocaleString()} of ${c.considered.toLocaleString()} accounts · for ${c.for}` : c.missing}</span>
            {ready && (
              <>
                <p><b>Next:</b> {c.action}</p>
                {full && <p><b>When:</b> {c.timing}</p>}
                {firstEvidence(c) && <p className="qc-muted">e.g. {firstEvidence(c)}</p>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Use cases the queried data supports (backend/opportunities.py), shown
 * inline under the answer only: ``meta: null`` keeps it out of the
 * Artifacts library and the side panel.
 */
export const opportunitiesRenderer = defineArtifactRenderer<{ data: ActionsPayload | null }>({
  type: "qc_opportunities",
  toolName: "next_best_actions",
  parser: ({ response }) => {
    const data = parseJSON<ActionsPayload>(response);
    if (data && !data.use_cases?.length) return null;
    return { props: { data }, meta: null };
  },
  preview: ({ data }) =>
    data ? (
      <section className="qc-nba" aria-label="Suggested next steps">
        <header>
          <Target size={14} /> <strong>What you could do next</strong>
          <span className="qc-muted"> · {data.accounts.toLocaleString()} accounts in {data.scope.length} dataset(s)</span>
        </header>
        <ActionsList data={data} />
      </section>
    ) : null,
  actual: () => null,
  label: "Next steps",
  icon: <Target size={16} />,
});
