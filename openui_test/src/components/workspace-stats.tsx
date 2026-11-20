"use client";

import StatsBand, { type Stat } from "@/components/ui/stats-band";
import { useApi } from "@/components/tools/shared";

type Summary = { collections: { name: string; label: string; description: string; documents: number }[] };

/**
 * Headline counts of what this workspace holds, read from /api/catalog/summary
 * (Stats Band, 21st.dev kuratlielia 35089). Any signed-in user or public-mode
 * visitor can read it. Nothing here is hardcoded.
 */
export function WorkspaceStats({ enabled }: { enabled: boolean }) {
  const { data } = useApi<Summary>(enabled ? "/api/catalog/summary" : null);
  if (!data) return null;

  const collections = data.collections;
  if (collections.length === 0) {
    return (
      <div className="qc-stats qc-stats--empty" role="status">
        No datasets yet.
      </div>
    );
  }

  const records = collections.reduce((sum, c) => sum + c.documents, 0);
  const largest = collections.reduce((a, b) => (b.documents > a.documents ? b : a));

  const stats: Stat[] = [
    {
      value: collections.length,
      label: collections.length === 1 ? "Dataset" : "Datasets",
      detail: collections.length === 1 ? largest.label : `Largest: ${largest.label}`,
    },
    {
      value: records,
      notation: records >= 10_000 ? "compact" : "standard",
      decimals: records >= 10_000 ? 1 : 0,
      label: "Records",
      detail: "Rows you can ask about",
    },
  ];

  return (
    <div className="qc-stats">
      <StatsBand stats={stats} layout="divided" duration={1.2} />
    </div>
  );
}
