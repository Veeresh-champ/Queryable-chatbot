"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch, errorMessage } from "@/lib/api";

/**
 * The active project: which datasets the chat (and the dashboards) read.
 * "" means "every dataset I'm allowed to use". The backend enforces access and
 * the ON/OFF switch (backend/projects.py); this is only the user's choice,
 * remembered per browser and shared by every component through an event.
 */

export type ProjectDataset = {
  name: string;
  label?: string;
  description?: string;
  rows?: number | null;
  source?: "upload" | "sample";
  tags?: string[];
  category?: string | null;
  quality?: QualityReport | null;
  temporary?: boolean;
  expires_at?: string | null;
};

export type QualityIssue = { level: "info" | "warning"; code: string; message: string; columns?: string[] };
export type QualityReport = { rows: number; completeness: number; score: number; issues: QualityIssue[] };

export type Project = {
  id: string;
  name: string;
  description: string;
  category: string | null;
  tags: string[];
  enabled: boolean;
  dataset_count: number;
  threads: number;
  datasets: ProjectDataset[];
  access?: "everyone" | "members";
  members?: string[];
  created_by?: string;
  updated_at?: string;
};

export type ProjectList = {
  projects: Project[];
  unassigned?: ProjectDataset[];
  tags?: string[];
  categories?: string[];
  users?: string[];
};

const KEY = "qc-project";
const EVENT = "qc-project-change";
const LIST_EVENT = "qc-projects-changed";

function stored(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function setActiveProject(id: string) {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* storage blocked: the choice still applies until reload */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
}

/** Tell every project list to refetch (after create / toggle / delete). */
export function notifyProjectsChanged() {
  window.dispatchEvent(new Event(LIST_EVENT));
}

export function useActiveProject(): [string, (id: string) => void] {
  const [id, setId] = useState("");
  useEffect(() => {
    const sync = () => setId(stored());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return [id, setActiveProject];
}

export function useProjects() {
  const [data, setData] = useState<ProjectList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    window.addEventListener(LIST_EVENT, reload);
    return () => window.removeEventListener(LIST_EVENT, reload);
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await authFetch("/api/projects");
        if (!response.ok) throw new Error(await errorMessage(response, "Projects could not be loaded."));
        const body = (await response.json()) as ProjectList;
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Projects could not be loaded.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { data, error, loading: data === null && error === null, reload };
}

/** The active project, dropped when it no longer exists or was switched off. */
export function useUsableProject() {
  const [active, setActive] = useActiveProject();
  const { data } = useProjects();
  const usable = data?.projects.filter((p) => p.enabled) ?? [];
  const project = usable.find((p) => p.id === active) ?? null;
  return { project, projectId: project ? project.id : "", projects: usable, setActive, loaded: data !== null };
}

export function projectQuery(id: string, prefix: "?" | "&" = "?") {
  return id ? `${prefix}project=${encodeURIComponent(id)}` : "";
}
