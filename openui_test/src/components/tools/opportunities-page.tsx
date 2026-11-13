"use client";

import { useState } from "react";
import { CheckCircle2, CircleDashed, Download, Search, Send, Target, TriangleAlert } from "lucide-react";

import { ProjectScope } from "@/components/tools/project-dashboard";
import { LoadState, ToolPage, useApi, useAsk } from "@/components/tools/shared";
import { Funnel } from "@/components/viz/charts";
import { authFetch, errorMessage } from "@/lib/api";
import { projectQuery, useUsableProject } from "@/lib/project";
import { csvCell } from "@/lib/csv";

/**
 * "What business opportunity is in my data, and what should I do next?"
 * (backend/opportunities.py). Use cases come with the value-added field and
 * value that triggered them; a customer profile (industry, location, size,
 * revenue, growth) narrows the accounts. Missing values show as "unknown",
 * never as a match.
 */

type Evidence = { field: string | null; label: string; value: string | number; why: string };
type Account = {
  name: string;
  country: string | null;
  dataset: string;
  dataset_label: string;
  size_band: string | null;
  revenue_band: string | null;
  growth: boolean | null;
  evidence: Evidence[];
  score?: number;
  fit?: Record<string, "match" | "unknown" | "no" | "any">;
  use_cases?: string[];
};
type UseCase = {
  id: string;
  title: string;
  for: string;
  description: string;
  action: string;
  timing: string;
  needs: string;
  status: "ready" | "needs_data" | "no_matches";
  missing: string | null;
  accounts: number;
  considered: number;
  signals: string[];
  top: Account[];
};
type Overview = {
  datasets: { name: string; label: string; accounts: number }[];
  accounts: number;
  use_cases: UseCase[];
  profile_options: { industries: string[]; countries: { name: string; accounts: number }[]; sizes: string[]; revenues: string[] };
};
type MatchResult = { funnel: { step: string; count: number }[]; accounts: Account[]; total: number; notes: string[]; bands: string };

const STATUS = {
  ready: { label: "Ready", icon: <CheckCircle2 size={12} /> },
  needs_data: { label: "Needs data", icon: <TriangleAlert size={12} /> },
  no_matches: { label: "No matches", icon: <CircleDashed size={12} /> },
};

function toggle(list: string[], value: string) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Chips({ options, value, onChange, label }: { options: string[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div className="qc-chips" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option} type="button" className="qc-tag" aria-pressed={value.includes(option)} onClick={() => onChange(toggle(value, option))}>
          {option}
        </button>
      ))}
    </div>
  );
}

function EvidenceList({ items }: { items: Evidence[] }) {
  return (
    <ul className="qc-evidence">
      {items.map((e, i) => (
        <li key={i}>
          <b>{e.label}:</b> {String(e.value).slice(0, 90)} <span className="qc-muted">— {e.why}</span>
        </li>
      ))}
    </ul>
  );
}

function downloadAccounts(accounts: Account[]) {
  const header = ["Account", "Country", "Dataset", "Score", "Size band", "Revenue band", "Growth", "Use cases", "Evidence"];
  const rows = accounts.map((a) => [
    a.name, a.country ?? "", a.dataset_label, a.score ?? "", a.size_band ?? "unknown", a.revenue_band ?? "unknown",
    a.growth == null ? "unknown" : a.growth ? "yes" : "no", (a.use_cases ?? []).join(" | "),
    a.evidence.map((e) => `${e.label}: ${e.value} (${e.why})`).join(" | "),
  ]);
  const esc = (v: string | number) => csvCell(v);
  const url = URL.createObjectURL(new Blob([[header, ...rows].map((r) => r.map(esc).join(",")).join("\n")], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "matching-accounts.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export function OpportunitiesPage() {
  const { projectId, project } = useUsableProject();
  const ask = useAsk();
  const { data, error, loading, reload } = useApi<Overview>(`/api/opportunities${projectQuery(projectId)}`);
  const [useCase, setUseCase] = useState("");
  const [industries, setIndustries] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [sizes, setSizes] = useState<string[]>([]);
  const [revenues, setRevenues] = useState<string[]>([]);
  const [growth, setGrowth] = useState<"" | "yes" | "no">("");
  const [includeUnknown, setIncludeUnknown] = useState(true);
  const [match, setMatch] = useState<{ project: string; data: MatchResult } | null>(null);
  // Results belong to the project they were computed for.
  const result = match && match.project === projectId ? match.data : null;
  const [busy, setBusy] = useState(false);
  const [matchError, setMatchError] = useState("");

  const options = data?.profile_options;
  const ready = data?.use_cases.filter((c) => c.status === "ready") ?? [];

  const run = async () => {
    setBusy(true);
    setMatchError("");
    try {
      const response = await authFetch("/api/opportunities/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: projectId || null,
          use_case: useCase || null,
          include_unknown: includeUnknown,
          profile: { industries, countries, sizes, revenues, growth: growth === "" ? null : growth === "yes" },
        }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, "Matching failed."));
      setMatch({ project: projectId, data: (await response.json()) as MatchResult });
    } catch (failure) {
      setMatchError(failure instanceof Error ? failure.message : "Matching failed.");
    } finally {
      setBusy(false);
    }
  };

  const describeProfile = () =>
    [
      industries.length ? `industry ${industries.join(" / ")}` : "",
      countries.length ? `in ${countries.join(", ")}` : "",
      sizes.length ? `size ${sizes.join("/")}` : "",
      revenues.length ? `revenue ${revenues.join("/")}` : "",
      growth ? (growth === "yes" ? "growing" : "not growing") : "",
    ].filter(Boolean).join(", ");

  return (
    <ToolPage
      icon={<Target size={13} />}
      eyebrow="Opportunities"
      title="What can we sell, to whom, and when?"
      description="Use cases found in your value-added fields, each with the exact field and value behind it. Describe a customer's ideal buyer to rank matching accounts. Missing data is shown as unknown, never assumed."
      actions={<ProjectScope />}
    >
      <LoadState loading={loading && !data} error={error} onRetry={reload} />
      {data && (
        <div className="qc-opps" style={{ opacity: loading ? 0.55 : 1 }}>
          <section className="qc-kpi-row">
            <article className="qc-kpi"><span className="qc-kpi__label">Accounts scanned</span><span className="qc-kpi__value">{data.accounts.toLocaleString()}</span><span className="qc-kpi__hint">{data.datasets.length} company datasets{project ? ` in ${project.name}` : ""}</span></article>
            <article className="qc-kpi"><span className="qc-kpi__label">Use cases ready</span><span className="qc-kpi__value">{ready.length}</span><span className="qc-kpi__hint">of {data.use_cases.length} checked</span></article>
            <article className="qc-kpi"><span className="qc-kpi__label">Largest opportunity</span><span className="qc-kpi__value">{ready[0]?.accounts.toLocaleString() ?? "—"}</span><span className="qc-kpi__hint">{ready[0]?.title ?? "no evidence yet"}</span></article>
          </section>

          <section className="qc-usecases" aria-label="Use cases">
            {data.use_cases.map((c) => (
              <button key={c.id} type="button" className="qc-usecase" data-status={c.status} aria-pressed={useCase === c.id}
                      disabled={c.status !== "ready"} onClick={() => setUseCase(useCase === c.id ? "" : c.id)}>
                <h3>
                  {c.title}
                  <span className="qc-status" data-status={c.status}>{STATUS[c.status].icon} {STATUS[c.status].label}</span>
                </h3>
                {c.status === "ready" ? (
                  <span className="qc-usecase__count">{c.accounts.toLocaleString()} <small>of {c.considered.toLocaleString()} accounts</small></span>
                ) : (
                  <p>{c.missing}</p>
                )}
                <p className="qc-usecase__for">For: {c.for}</p>
                {c.status === "ready" && (
                  <>
                    <p><b>Next step:</b> {c.action}</p>
                    <p><b>When:</b> {c.timing}</p>
                    {c.signals.length > 0 && (
                      <div className="qc-tags">{c.signals.map((s) => <span key={s} className="qc-tag">{s}</span>)}</div>
                    )}
                    {c.top[0] && <EvidenceList items={[{ ...c.top[0].evidence[0], label: `${c.top[0].name} · ${c.top[0].evidence[0].label}` }]} />}
                  </>
                )}
              </button>
            ))}
          </section>

          {options && (
            <section className="qc-tile qc-profile" aria-label="Customer profile">
              <header className="qc-tile__head">
                <h2 className="qc-tile__title"><Target size={15} /> Customer profile</h2>
                <span className="qc-muted">{useCase ? `Use case: ${data.use_cases.find((c) => c.id === useCase)?.title}` : "All use cases"}</span>
              </header>
              <div className="qc-form-grid">
                <div className="is-wide">
                  <p className="qc-muted">Industry</p>
                  <Chips label="Industry" options={options.industries.slice(0, 14)} value={industries} onChange={setIndustries} />
                </div>
                <div className="is-wide">
                  <p className="qc-muted">Location</p>
                  <Chips label="Location" options={options.countries.slice(0, 16).map((c) => c.name)} value={countries} onChange={setCountries} />
                </div>
                <div>
                  <p className="qc-muted">Size (within each dataset)</p>
                  <Chips label="Size" options={options.sizes} value={sizes} onChange={setSizes} />
                </div>
                <div>
                  <p className="qc-muted">Revenue / financials</p>
                  <Chips label="Revenue" options={options.revenues} value={revenues} onChange={setRevenues} />
                </div>
                <label>
                  Growth
                  <select value={growth} onChange={(e) => setGrowth(e.target.value as typeof growth)}>
                    <option value="">Any</option>
                    <option value="yes">Growing</option>
                    <option value="no">Not growing</option>
                  </select>
                </label>
                <label className="qc-switch" style={{ alignSelf: "end" }}>
                  <input type="checkbox" checked={includeUnknown} onChange={(e) => setIncludeUnknown(e.target.checked)} />
                  Keep accounts with unknown values
                </label>
              </div>
              <div className="qc-upload__actions">
                <button type="button" className="qc-primary-button" onClick={() => void run()} disabled={busy}>
                  <Search size={15} /> {busy ? "Matching…" : "Find matching accounts"}
                </button>
              </div>
              {matchError && <p className="qc-upload__error" role="alert">{matchError}</p>}
            </section>
          )}

          {result && (
            <section className="viz-grid-layout">
              <article className="qc-tile">
                <h3 className="qc-tile__title">Where accounts drop out</h3>
                <Funnel steps={result.funnel} />
                <p className="viz-note">{result.bands}</p>
                {result.notes.length > 0 && <ul className="qc-notes">{result.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
              </article>
              <article className="qc-tile qc-tile--wide">
                <header className="qc-tile__head">
                  <h3 className="qc-tile__title">{result.total.toLocaleString()} matching accounts</h3>
                  <div className="qc-upload__actions">
                    {result.accounts.length > 0 && (
                      <>
                        <button type="button" className="qc-ghost-button" onClick={() => downloadAccounts(result.accounts)}>
                          <Download size={13} /> CSV
                        </button>
                        <button type="button" className="qc-ghost-button" onClick={() => ask(
                          `Draft a short outreach plan for a customer whose ideal buyer is ${describeProfile() || "any company"}` +
                          `${useCase ? `, for the "${data.use_cases.find((c) => c.id === useCase)?.title}" use case` : ""}. ` +
                          `Use only these accounts and their evidence: ${result.accounts.slice(0, 5).map((a) => `${a.name} (${a.country ?? "country unknown"}; ${a.evidence.slice(0, 2).map((e) => `${e.label}: ${e.value}`).join("; ")})`).join(" | ")}`,
                        )}>
                          <Send size={13} /> Draft outreach in chat
                        </button>
                      </>
                    )}
                  </div>
                </header>
                {result.accounts.length === 0 ? (
                  <p className="qc-muted">No account matches this profile. Widen the profile or keep accounts with unknown values.</p>
                ) : (
                  <div className="qc-table-scroll">
                    <table className="qc-accounts">
                      <thead>
                        <tr><th scope="col">Account</th><th scope="col">Fit</th><th scope="col">Evidence (value-added fields)</th><th scope="col">Score</th></tr>
                      </thead>
                      <tbody>
                        {result.accounts.map((a, i) => (
                          <tr key={`${a.dataset}-${a.name}-${i}`}>
                            <td>{a.name}<small>{a.country ?? "Country unknown"} · {a.dataset_label}</small></td>
                            <td>
                              <div className="qc-fit">
                                {Object.entries(a.fit ?? {}).filter(([, v]) => v !== "any").map(([k, v]) => (
                                  <span key={k} data-state={v} title={v === "unknown" ? "Not in the data" : v}>{k}: {v}</span>
                                ))}
                                {Object.values(a.fit ?? {}).every((v) => v === "any") && <span>no filters</span>}
                              </div>
                            </td>
                            <td>{a.evidence.length ? <EvidenceList items={a.evidence} /> : <span className="qc-muted">Profile fit only</span>}</td>
                            <td className="qc-score">{a.score}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </article>
            </section>
          )}
        </div>
      )}
    </ToolPage>
  );
}
