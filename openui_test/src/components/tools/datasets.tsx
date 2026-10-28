"use client";

import { useCallback, useEffect, useState } from "react";
import { Database } from "lucide-react";

import { useApi } from "@/components/tools/shared";

/**
 * Which dataset the Insights dashboard and Analytics lab show: the default
 * SPAN companies & sales data, or the separate IBM HR attrition data
 * (GET /api/datasets). The choice is remembered per browser and shared by
 * both pages.
 */

export type DatasetId = "span" | "ibm_hr";
type Dataset = { id: DatasetId; label: string; description: string };

const KEY = "qc-dataset";
const EVENT = "qc-dataset-change";

function stored(): DatasetId {
  try {
    return window.localStorage.getItem(KEY) === "ibm_hr" ? "ibm_hr" : "span";
  } catch {
    return "span";
  }
}

export function useDataset() {
  const { data } = useApi<{ datasets: Dataset[] }>("/api/datasets");
  const [choice, setChoice] = useState<DatasetId>("span");

  useEffect(() => {
    const sync = () => setChoice(stored());
    sync();
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);

  const datasets = data?.datasets ?? [];
  // Fall back to the default when the stored choice is not (or no longer) available.
  const dataset: DatasetId = datasets.some((d) => d.id === choice) ? choice : "span";

  const setDataset = useCallback((id: DatasetId) => {
    try {
      window.localStorage.setItem(KEY, id);
    } catch {
      /* storage blocked: the choice still applies to this page */
    }
    setChoice(id);
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return { datasets, dataset, setDataset };
}

export function DatasetSwitch({ datasets, dataset, onChange }: { datasets: Dataset[]; dataset: DatasetId; onChange: (id: DatasetId) => void }) {
  if (datasets.length < 2) return null;
  return (
    <div className="qc-segmented lab-dataset" role="tablist" aria-label="Dataset">
      {datasets.map((d) => (
        <button
          key={d.id}
          type="button"
          role="tab"
          aria-selected={d.id === dataset}
          className={d.id === dataset ? "is-active" : ""}
          title={d.description}
          onClick={() => onChange(d.id)}
        >
          <Database size={12} /> {d.label}
        </button>
      ))}
    </div>
  );
}
