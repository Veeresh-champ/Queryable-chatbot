"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Clock,
  Save,
  Database,
  FileSpreadsheet,
  Folder,
  FolderOpen,
  FolderPlus,
  Hash,
  Lock,
  MessageSquarePlus,
  Pencil,
  Search,
  Table2,
  Trash2,
  Type,
  Users,
  X,
} from "lucide-react";

import { DatasetUpload, QualityPanel } from "@/components/dataset-upload";
import { LoadState, ToolPage, useApi, useAsk } from "@/components/tools/shared";
import { authFetch, errorMessage } from "@/lib/api";
import {
  notifyProjectsChanged,
  useProjects,
  type Project,
  type ProjectDataset,
} from "@/lib/project";

/**
 * Data catalog (admins): datasets organised in projects, like chats inside a
 * Claude project. Admins create projects, move datasets between them, tag
 * them, switch a project ON/OFF and choose who may use it. The backend
 * enforces every rule (backend/projects.py); this page only edits them.
 */

type Field = { name: string; type: string; samples: Record<string, unknown>[] };
type Collection = { name: string; documents: number; source: "upload" | "sample"; fields: Field[]; active: boolean };

const NUMERIC = new Set(["int", "float", "Int64", "Decimal128"]);
const UNASSIGNED = "__unassigned";

function sampleText(field: Field) {
  return field.samples
    .map((sample) => sample[field.name])
    .filter((value) => value != null)
    .map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value)))
    .slice(0, 3)
    .join(" · ");
}

async function send(url: string, method: string, body?: unknown) {
  const response = await authFetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(await errorMessage(response, "The change could not be saved."));
  return response.json();
}

function TagEditor({ value, onChange, suggestions = [] }: { value: string[]; onChange: (tags: string[]) => void; suggestions?: string[] }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  };
  return (
    <div className="qc-tag-input">
      {value.map((tag) => (
        <span key={tag} className="qc-tag">
          {tag}
          <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        list="qc-tag-suggestions"
        placeholder={value.length ? "Add tag" : "Add tags (Enter)"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => draft && add(draft)}
        aria-label="Add tag"
      />
      <datalist id="qc-tag-suggestions">
        {suggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
    </div>
  );
}

function ProjectForm({
  project,
  categories,
  users,
  tags,
  onSaved,
  onCancel,
}: {
  project?: Project;
  categories: string[];
  users: string[];
  tags: string[];
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [category, setCategory] = useState(project?.category ?? "");
  const [projectTags, setProjectTags] = useState<string[]>(project?.tags ?? []);
  const [access, setAccess] = useState<"everyone" | "members">(project?.access ?? "everyone");
  const [members, setMembers] = useState<string[]>(project?.members ?? []);
  const [error, setError] = useState("");
  const save = async () => {
    setError("");
    try {
      const body = { name, description, category: category || null, tags: projectTags, access, members };
      const saved = project ? await send(`/api/projects/${project.id}`, "PATCH", body) : await send("/api/projects", "POST", body);
      notifyProjectsChanged();
      onSaved(saved.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
    }
  };
  return (
    <form className="qc-tile" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h3 className="qc-tile__title"><FolderPlus size={15} /> {project ? "Edit project" : "New project"}</h3>
      <div className="qc-form-grid">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={60} /></label>
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">None</option>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="is-wide">Description<textarea rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <div className="is-wide"><span className="qc-muted">Tags</span><TagEditor value={projectTags} onChange={setProjectTags} suggestions={tags} /></div>
        <label>
          Who can use it
          <select value={access} onChange={(e) => setAccess(e.target.value as typeof access)}>
            <option value="everyone">Everyone signed in</option>
            <option value="members">Only selected members (and admins)</option>
          </select>
        </label>
        {access === "members" && (
          <div className="is-wide">
            <span className="qc-muted">Members</span>
            <div className="qc-chips">
              {users.map((u) => (
                <button key={u} type="button" className="qc-tag" aria-pressed={members.includes(u)}
                        onClick={() => setMembers(members.includes(u) ? members.filter((m) => m !== u) : [...members, u])}>
                  {u}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {error && <p className="qc-upload__error" role="alert">{error}</p>}
      <div className="qc-upload__actions">
        <button type="button" className="qc-ghost-button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="qc-primary-button">{project ? "Save" : "Create project"}</button>
      </div>
    </form>
  );
}

function DatasetCard({
  dataset,
  collection,
  projects,
  currentProject,
  allTags,
  onChanged,
  onError,
}: {
  dataset: ProjectDataset;
  collection?: Collection;
  projects: Project[];
  currentProject: string | null;
  allTags: string[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const ask = useAsk();
  const [open, setOpen] = useState<"" | "fields" | "quality" | "tags">("");
  const [tags, setTags] = useState<string[]>(dataset.tags ?? []);
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      notifyProjectsChanged();
      onChanged();
    } catch (failure) {
      onError(failure instanceof Error ? failure.message : "The change failed.");
    }
  };
  const score = dataset.quality?.score;
  return (
    <article className="qc-dataset-card">
      <header>
        <h3><Table2 size={14} /> {dataset.label ?? dataset.name}</h3>
        <span className="qc-pill">{(dataset.rows ?? 0).toLocaleString()} rows</span>
      </header>
      <div className="qc-tags">
        <code>{dataset.name}</code>
        <span className={`qc-catalog__badge qc-catalog__badge--${dataset.source ?? "sample"}`}>{dataset.source === "upload" ? "Uploaded" : "Built-in"}</span>
        {dataset.temporary && (
          <span className="qc-tag" title="Uploaded with 'Use without saving'">
            <Clock size={11} /> Temporary{dataset.expires_at ? ` · until ${new Date(dataset.expires_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
          </span>
        )}
        {score != null && (
          <button type="button" className="qc-tag" onClick={() => setOpen(open === "quality" ? "" : "quality")} aria-expanded={open === "quality"}>
            <span className="qc-quality" data-level={score >= 80 ? "good" : score >= 60 ? "warning" : "critical"}>Quality {score}</span>
          </button>
        )}
      </div>
      {dataset.description && <p>{dataset.description}</p>}
      <div className="qc-tags">
        {(dataset.tags ?? []).map((t) => <span key={t} className="qc-tag">#{t}</span>)}
        <button type="button" className="qc-tag" onClick={() => setOpen(open === "tags" ? "" : "tags")}>
          <Pencil size={11} /> Tags
        </button>
      </div>
      {open === "tags" && (
        <div style={{ display: "grid", gap: 6 }}>
          <TagEditor value={tags} onChange={setTags} suggestions={allTags} />
          <div className="qc-upload__actions">
            <button type="button" className="qc-primary-button" onClick={() => void run(async () => {
              await send(`/api/catalog-meta/${encodeURIComponent(dataset.name)}`, "PATCH", { tags });
              setOpen("");
            })}>Save tags</button>
          </div>
        </div>
      )}
      {open === "quality" && dataset.quality && <QualityPanel quality={dataset.quality} />}
      {open === "fields" && collection && (
        <ul className="qc-catalog__fields">
          {collection.fields.map((field) => (
            <li key={field.name}>
              <span className="qc-catalog__type" title={field.type}>{NUMERIC.has(field.type) ? <Hash size={12} /> : <Type size={12} />}</span>
              <code>{field.name}</code>
              <span className="qc-catalog__sample">{sampleText(field)}</span>
            </li>
          ))}
        </ul>
      )}
      <footer>
        <select className="qc-select" aria-label="Move to project" value={currentProject ?? ""}
                onChange={(e) => {
                  const target = e.target.value;
                  void run(() => (target
                    ? send(`/api/projects/${target}/datasets/${encodeURIComponent(dataset.name)}`, "POST")
                    : send(`/api/projects/${currentProject}/datasets/${encodeURIComponent(dataset.name)}`, "DELETE")));
                }}>
          {!currentProject && <option value="">Move to project…</option>}
          {currentProject && <option value="">Unassigned</option>}
          {projects.map((p) => <option key={p.id} value={p.id}>{p.id === currentProject ? `In ${p.name}` : p.name}</option>)}
        </select>
        {collection && (
          <button type="button" className="qc-ghost-button" onClick={() => setOpen(open === "fields" ? "" : "fields")}>
            {collection.fields.length} fields
          </button>
        )}
        <button type="button" className="qc-ghost-button" onClick={() => {
          ask(`Give me an overview of the ${dataset.name} collection with key statistics`);
        }}>
          <MessageSquarePlus size={13} /> Overview
        </button>
        {dataset.temporary && (
          <button type="button" className="qc-ghost-button" onClick={() => void run(() => send(`/api/catalog/${encodeURIComponent(dataset.name)}/keep`, "POST"))}>
            <Save size={13} /> Keep
          </button>
        )}
        {dataset.source === "upload" && (
          <button type="button" className="qc-ghost-button qc-ghost-button--danger" onClick={() => {
            if (window.confirm(`Delete the dataset "${dataset.label ?? dataset.name}" and its rows? This cannot be undone.`)) {
              void run(() => send(`/api/catalog/${encodeURIComponent(dataset.name)}`, "DELETE"));
            }
          }}>
            <Trash2 size={13} />
          </button>
        )}
      </footer>
    </article>
  );
}

function FolderCard({ name, detail, enabled, tags, members, onOpen }: {
  name: string;
  detail: string;
  enabled?: boolean;
  tags: string[];
  members?: boolean;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="qc-folder" data-enabled={enabled ?? true} onClick={onOpen}>
      <span className="qc-folder__icon" aria-hidden="true"><Folder size={22} /></span>
      <span className="qc-folder__body">
        <strong>{name}</strong>
        <span>{detail}</span>
        {tags.length > 0 && <span className="qc-tags">{tags.slice(0, 4).map((t) => <span key={t} className="qc-tag">#{t}</span>)}</span>}
      </span>
      {enabled !== undefined && (
        <span className="qc-project-item__state" data-on={enabled}>
          {members && <Lock size={11} aria-label="Members only" />} {enabled ? "On" : "Off"}
        </span>
      )}
    </button>
  );
}

export function CatalogPage() {
  const { data, error, loading, reload } = useProjects();
  const catalog = useApi<{ collections: Collection[] }>("/api/catalog");
  // null = the folder grid; a project id or UNASSIGNED = that folder, opened.
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [mode, setMode] = useState<"" | "new" | "edit" | "upload">("");
  const [actionError, setActionError] = useState("");

  const projects = useMemo(() => data?.projects ?? [], [data]);
  const unassigned = data?.unassigned ?? [];
  const current = open && open !== UNASSIGNED ? projects.find((p) => p.id === open) ?? null : null;
  const collections = new Map((catalog.data?.collections ?? []).map((c) => [c.name, c]));
  const allTags = data?.tags ?? [];
  const refresh = () => {
    reload();
    catalog.reload();
  };

  const needle = filter.trim().toLowerCase();
  const matches = (d: ProjectDataset, p?: Project) => {
    const tags = [...(d.tags ?? []), ...(p?.tags ?? [])];
    if (tagFilter.length && !tagFilter.every((t) => tags.includes(t))) return false;
    if (!needle) return true;
    const fields = collections.get(d.name)?.fields.map((f) => f.name) ?? [];
    return [d.name, d.label ?? "", d.description ?? "", p?.name ?? "", ...tags, ...fields].some((v) => v.toLowerCase().includes(needle));
  };
  const searching = Boolean(needle || tagFilter.length);
  const folderMatches = (p: Project) =>
    !searching ||
    p.datasets.some((d) => matches(d, p)) ||
    (!tagFilter.length && [p.name, p.description, ...p.tags].some((v) => v.toLowerCase().includes(needle)));
  const visibleFolders = projects.filter(folderMatches);
  const showUnassigned = unassigned.length > 0 && (!searching || unassigned.some((d) => matches(d)));

  const toggle = async (project: Project) => {
    setActionError("");
    try {
      await send(`/api/projects/${project.id}`, "PATCH", { enabled: !project.enabled });
      notifyProjectsChanged();
      refresh();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "Could not switch the project.");
    }
  };
  const remove = async (project: Project) => {
    if (!window.confirm(`Delete the project "${project.name}"? Its ${project.dataset_count} dataset(s) are kept and become unassigned.`)) return;
    try {
      await send(`/api/projects/${project.id}`, "DELETE");
      setOpen(null);
      notifyProjectsChanged();
      refresh();
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "Could not delete the project.");
    }
  };

  const cards = (list: { d: ProjectDataset; p?: Project }[]) => {
    const shown = list.filter(({ d, p }) => matches(d, p));
    if (!shown.length) {
      return <p className="qc-muted">{searching ? "No dataset in this folder matches the search." : "No datasets in this folder yet."}</p>;
    }
    return (
      <div className="qc-dataset-grid">
        {shown.map(({ d, p }) => (
          <DatasetCard key={d.name} dataset={d} collection={collections.get(d.name)} projects={projects} currentProject={p?.id ?? null}
                       allTags={allTags} onChanged={refresh} onError={setActionError} />
        ))}
      </div>
    );
  };

  const back = (
    <button type="button" className="qc-ghost-button" onClick={() => { setOpen(null); setMode(""); }}>
      <ArrowLeft size={13} /> All folders
    </button>
  );

  return (
    <ToolPage
      icon={<Database size={13} />}
      eyebrow="Data catalog · Admin"
      title="Projects and datasets"
      description="Each project is a folder of datasets. Open a folder to see, tag and manage its datasets. A project that is off is invisible to the chatbot, dashboards and opportunities; members-only projects are visible only to the people you choose."
      actions={
        <button type="button" className="qc-primary-button" onClick={() => setMode(mode === "new" ? "" : "new")}>
          {mode === "new" ? <X size={15} /> : <FolderPlus size={15} />} {mode === "new" ? "Close" : "New project"}
        </button>
      }
    >
      <div className="qc-kpi-row qc-catalog__stats">
        <div className="qc-kpi"><span className="qc-kpi__label">Projects</span><strong className="qc-kpi__value">{projects.length}</strong></div>
        <div className="qc-kpi"><span className="qc-kpi__label">Active</span><strong className="qc-kpi__value">{projects.filter((p) => p.enabled).length}</strong></div>
        <div className="qc-kpi"><span className="qc-kpi__label">Datasets</span><strong className="qc-kpi__value">{projects.reduce((n, p) => n + p.dataset_count, 0) + unassigned.length}</strong></div>
        <div className="qc-kpi"><span className="qc-kpi__label">Unassigned</span><strong className="qc-kpi__value">{unassigned.length}</strong></div>
      </div>

      {mode === "new" && data && (
        <ProjectForm categories={data.categories ?? []} users={data.users ?? []} tags={allTags}
                     onSaved={(id) => { setOpen(id); setMode(""); refresh(); }} onCancel={() => setMode("")} />
      )}

      <label className="qc-search">
        <Search size={15} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)}
               placeholder={open ? "Search this folder's datasets, fields or tags…" : "Search folders, datasets, fields or tags…"} />
      </label>
      {allTags.length > 0 && (
        <div className="qc-chips" aria-label="Filter by tag">
          {allTags.map((t) => (
            <button key={t} type="button" className="qc-tag" aria-pressed={tagFilter.includes(t)}
                    onClick={() => setTagFilter(tagFilter.includes(t) ? tagFilter.filter((x) => x !== t) : [...tagFilter, t])}>#{t}</button>
          ))}
        </div>
      )}
      {actionError && <p className="qc-upload__error" role="alert">{actionError}</p>}
      <LoadState loading={loading} error={error} onRetry={refresh} />

      {data && open === null && (
        <section className="qc-folders" aria-label="Project folders">
          {visibleFolders.map((p) => (
            <FolderCard key={p.id} name={p.name} enabled={p.enabled} tags={p.tags} members={p.access === "members"}
                        detail={`${p.dataset_count} dataset${p.dataset_count === 1 ? "" : "s"}${p.category ? ` · ${p.category}` : ""}${p.threads ? ` · ${p.threads} chat${p.threads === 1 ? "" : "s"}` : ""}`}
                        onOpen={() => { setOpen(p.id); setMode(""); }} />
          ))}
          {showUnassigned && (
            <FolderCard name="Unassigned" tags={[]} detail={`${unassigned.length} dataset(s), readable by everyone`}
                        onOpen={() => { setOpen(UNASSIGNED); setMode(""); }} />
          )}
          {!visibleFolders.length && !showUnassigned && <p className="qc-muted">No folder matches the search.</p>}
        </section>
      )}

      {data && open === UNASSIGNED && (
        <section className="qc-project-detail">
          <div className="qc-project-detail__head">
            <div>
              {back}
              <h2><FolderOpen size={18} /> Unassigned datasets</h2>
              <p>Not in any project. Every signed-in user can query them. Move them into a project to control access.</p>
            </div>
            <button type="button" className="qc-ghost-button" onClick={() => setMode(mode === "upload" ? "" : "upload")}><FileSpreadsheet size={13} /> Add dataset</button>
          </div>
          {mode === "upload" && (
            <section className="qc-tile"><DatasetUpload projects={projects} onDone={refresh} onCancel={() => setMode("")} /></section>
          )}
          {cards(unassigned.map((d) => ({ d })))}
        </section>
      )}

      {data && current && (
        <section className="qc-project-detail">
          <div className="qc-project-detail__head">
            <div>
              {back}
              <h2><FolderOpen size={18} /> {current.name}</h2>
              {current.description && <p>{current.description}</p>}
              <div className="qc-tags" style={{ marginTop: 8 }}>
                {current.category && <span className="qc-tag">{current.category}</span>}
                {current.tags.map((t) => <span key={t} className="qc-tag">#{t}</span>)}
                <span className="qc-tag">
                  {current.access === "members" ? <><Lock size={11} /> {current.members?.length ?? 0} member(s) + admins</> : <><Users size={11} /> Everyone</>}
                </span>
              </div>
            </div>
            <div className="qc-project-detail__actions">
              <label className="qc-switch" title="When off, nobody can query this project's datasets">
                <input type="checkbox" role="switch" checked={current.enabled} onChange={() => void toggle(current)} />
                {current.enabled ? "On" : "Off"}
              </label>
              <button type="button" className="qc-ghost-button" onClick={() => setMode(mode === "edit" ? "" : "edit")}><Pencil size={13} /> Edit</button>
              <button type="button" className="qc-ghost-button" onClick={() => setMode(mode === "upload" ? "" : "upload")}><FileSpreadsheet size={13} /> Add dataset</button>
              <button type="button" className="qc-ghost-button qc-ghost-button--danger" onClick={() => void remove(current)} aria-label="Delete project"><Trash2 size={13} /></button>
            </div>
          </div>

          {mode === "edit" && (
            <ProjectForm key={current.id} project={current} categories={data.categories ?? []} users={data.users ?? []} tags={allTags}
                         onSaved={() => { setMode(""); refresh(); }} onCancel={() => setMode("")} />
          )}
          {mode === "upload" && (
            <section className="qc-tile" aria-label="Add a dataset">
              <h3 className="qc-tile__title"><FileSpreadsheet size={15} /> Add a dataset to {current.name}</h3>
              <p className="qc-muted">For a multi-sheet workbook (one industry per sheet), pick the sheet after the file is read. Check the data-quality report before importing.</p>
              <DatasetUpload key={current.id} project={current.id} projects={projects} onDone={refresh} />
            </section>
          )}
          {!current.enabled && (
            <p className="qc-upload__error" role="status">This project is off: the chatbot, dashboards and opportunities ignore its datasets until it is switched on.</p>
          )}
          {cards(current.datasets.map((d) => ({ d, p: current })))}
        </section>
      )}
    </ToolPage>
  );
}
