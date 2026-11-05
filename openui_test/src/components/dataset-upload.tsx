"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileSpreadsheet, Info, MessageSquarePlus, Save, ShieldCheck, Upload, X } from "lucide-react";

import { authFetch, errorMessage } from "@/lib/api";
import { notifyProjectsChanged, type QualityReport } from "@/lib/project";

/**
 * Excel / CSV -> dataset, in three steps: pick or drop a file, check the
 * detected columns and first rows (POST /api/catalog/preview), then import
 * it (POST /api/catalog/upload). Used by the Data catalog page and by the
 * drag-and-drop overlay on the chat. Admins only (the API enforces it).
 */

type Column = { name: string; original: string; type: string; filled: number; derived_from?: string };
type Preview = {
  filename: string;
  suggested_name: string;
  exists: boolean;
  rows: number;
  columns: Column[];
  sheets: string[];
  sheet: string | null;
  suggested_tags?: string[];
  quality?: QualityReport;
  preview: Record<string, unknown>[];
};
export type UploadResult = {
  name: string;
  label: string;
  rows_imported: number;
  rows_total: number;
  mode: string;
  project?: string | null;
  quality?: QualityReport;
  temporary?: boolean;
  expires_hours?: number | null;
};

/** The data-quality report shown before (and after) an import. Nothing in it changes the data. */
export function QualityPanel({ quality }: { quality: QualityReport }) {
  const level = quality.score >= 80 ? "good" : quality.score >= 60 ? "warning" : "critical";
  return (
    <section className="qc-tile" aria-label="Data quality">
      <header className="qc-tile__head">
        <h3 className="qc-tile__title"><ShieldCheck size={15} /> Data quality</h3>
        <span className="qc-quality" data-level={level}>
          {level === "good" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
          {quality.score}/100 · {Math.round(quality.completeness * 100)}% filled
        </span>
      </header>
      {quality.issues.length === 0 ? (
        <p className="qc-muted">No issues found.</p>
      ) : (
        <ul className="qc-quality-list">
          {quality.issues.map((issue, i) => (
            <li key={i} data-level={issue.level}>
              {issue.level === "warning" ? <AlertTriangle size={14} aria-label="Warning" /> : <Info size={14} aria-label="Note" />}
              <span>{issue.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export const ACCEPT = ".csv,.tsv,.txt,.xlsx,.xlsm,.json,.jsonl,.ndjson";
const TYPE_LABEL: Record<string, string> = { int: "number", float: "decimal", bool: "yes/no", date: "date", str: "text" };

export function isDatasetFile(file: File) {
  return /\.(csv|tsv|txt|xlsx|xlsm|json|jsonl|ndjson)$/i.test(file.name);
}

function form(file: File, fields: Record<string, string | undefined>) {
  const body = new FormData();
  body.append("file", file);
  for (const [key, value] of Object.entries(fields)) if (value) body.append(key, value);
  return body;
}

function cell(value: unknown) {
  if (value == null) return "";
  if (typeof value === "number") return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export function DatasetUpload({
  initialFile,
  onDone,
  onAsk,
  onCancel,
  project: initialProject = "",
  projects = [],
}: {
  initialFile?: File | null;
  onDone?: (result: UploadResult) => void;
  onAsk?: (result: UploadResult) => void;
  onCancel?: () => void;
  /** Project the dataset goes into ("" = unassigned). */
  project?: string;
  projects?: { id: string; name: string }[];
}) {
  const [project, setProject] = useState(initialProject);
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [sheet, setSheet] = useState("");
  const [mode, setMode] = useState<"create" | "replace" | "append">("create");
  const [busy, setBusy] = useState<"" | "preview" | "upload">("");
  const [error, setError] = useState("");
  const [done, setDone] = useState<UploadResult | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const loadPreview = useCallback(async (next: File, nextSheet?: string) => {
    setBusy("preview");
    setError("");
    try {
      const response = await authFetch("/api/catalog/preview", { method: "POST", body: form(next, { sheet: nextSheet }) });
      if (!response.ok) throw new Error(await errorMessage(response, "The file could not be read."));
      const data = (await response.json()) as Preview;
      setPreview(data);
      setSheet(data.sheet ?? "");
      setName(data.suggested_name);
      setTags((data.suggested_tags ?? []).join(", "));
      setMode(data.exists ? "replace" : "create");
    } catch (failure) {
      setPreview(null);
      setError(failure instanceof Error ? failure.message : "The file could not be read.");
    } finally {
      setBusy("");
    }
  }, []);

  useEffect(() => {
    // Start the preview after the effect, so its state updates are not synchronous.
    if (initialFile) queueMicrotask(() => void loadPreview(initialFile));
  }, [initialFile, loadPreview]);

  const choose = (next: File | undefined | null) => {
    if (!next) return;
    if (!isDatasetFile(next)) {
      setError("Upload a CSV, TSV, TXT, Excel (.xlsx) or JSON file.");
      return;
    }
    setFile(next);
    setDone(null);
    void loadPreview(next);
  };

  /** temporary = "Use without saving": queryable now, deleted automatically after 24 hours. */
  const upload = async (temporary: boolean) => {
    if (!file) return;
    setBusy("upload");
    setError("");
    try {
      const response = await authFetch("/api/catalog/upload", {
        method: "POST",
        body: form(file, { name, label, description, sheet, mode, project, tags, temporary: temporary ? "true" : undefined }),
      });
      if (!response.ok) throw new Error(await errorMessage(response, "The import failed."));
      const result = (await response.json()) as UploadResult;
      setDone(result);
      notifyProjectsChanged();
      onDone?.(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The import failed.");
    } finally {
      setBusy("");
    }
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setDone(null);
    setError("");
    setLabel("");
    setDescription("");
  };

  if (done) {
    return (
      <div className="qc-upload qc-upload--done" role="status">
        <CheckCircle2 size={28} className="qc-upload__ok" />
        <div>
          <h3>{done.label} is ready</h3>
          <p>
            {done.rows_imported.toLocaleString()} rows {done.mode === "append" ? "appended to" : "imported into"}{" "}
            <code>{done.name}</code>
            {done.project ? ` in project ${projects.find((p) => p.id === done.project)?.name ?? done.project}` : ""}. The chatbot can
            answer questions about it now.
            {done.temporary && ` Not saved: it is deleted automatically after ${done.expires_hours ?? 24} hours unless you press Keep in the Data catalog.`}
          </p>
        </div>
        <div className="qc-upload__actions">
          {onAsk && (
            <button type="button" className="qc-primary-button" onClick={() => onAsk(done)}>
              <MessageSquarePlus size={15} /> Ask about it
            </button>
          )}
          <button type="button" className="qc-ghost-button" onClick={onCancel ?? reset}>
            {onCancel ? "Close" : "Add another"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="qc-upload">
      {!preview && (
        <div
          className="qc-dropzone"
          data-dragging={dragging}
          role="button"
          tabIndex={0}
          aria-label="Choose an Excel or CSV file"
          onClick={() => input.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              input.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            choose(event.dataTransfer.files?.[0]);
          }}
        >
          <Upload size={22} />
          <strong>{busy === "preview" ? `Reading ${file?.name ?? "file"}…` : "Drop an Excel or CSV file here"}</strong>
          <span>or click to browse · CSV, TSV, TXT, Excel (.xlsx) or JSON · up to 15 MB</span>
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(event) => {
              choose(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      )}

      {error && (
        <p className="qc-upload__error" role="alert">
          {error}
        </p>
      )}

      {preview && file && (
        <>
          <header className="qc-upload__file">
            <FileSpreadsheet size={18} />
            <span>
              <strong>{preview.filename}</strong>
              <span>
                {preview.rows.toLocaleString()} rows · {preview.columns.length} columns
                {preview.sheet ? ` · sheet "${preview.sheet}"` : ""}
              </span>
            </span>
            <button type="button" className="qc-icon-button" onClick={reset} aria-label="Choose another file" title="Choose another file">
              <X size={15} />
            </button>
          </header>

          <div className="qc-upload__grid">
            <label className="qc-upload__field">
              Collection name
              <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} pattern="[a-z][a-z0-9_]{1,47}" required />
            </label>
            <label className="qc-upload__field">
              Display name
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={name.replace(/_/g, " ")} maxLength={80} />
            </label>
            {preview.sheets.length > 1 && (
              <label className="qc-upload__field">
                Sheet
                <select
                  value={sheet}
                  onChange={(e) => {
                    setSheet(e.target.value);
                    void loadPreview(file, e.target.value);
                  }}
                >
                  {preview.sheets.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
            {preview.exists && (
              <label className="qc-upload__field">
                Already exists
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                  <option value="replace">Replace its rows</option>
                  <option value="append">Append rows</option>
                </select>
              </label>
            )}
            {projects.length > 0 && (
              <label className="qc-upload__field">
                Project
                <select value={project} onChange={(e) => setProject(e.target.value)}>
                  <option value="">Unassigned</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="qc-upload__field">
              Tags <span className="qc-muted">(comma separated)</span>
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. insurance, vaf" maxLength={200} />
            </label>
            <label className="qc-upload__field qc-upload__field--wide">
              Description <span className="qc-muted">(helps the chatbot and other admins)</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="What is in this data, and where does it come from?"
              />
            </label>
          </div>

          <div className="qc-upload__columns" aria-label="Detected columns">
            {preview.columns.map((column) => (
              <span key={column.name} className="qc-upload__column" title={column.original ? `From "${column.original}"` : undefined}>
                <code>{column.name}</code>
                <span data-type={column.type}>{column.derived_from ? "derived · " : ""}{TYPE_LABEL[column.type] ?? column.type}</span>
              </span>
            ))}
          </div>

          {preview.quality && <QualityPanel quality={preview.quality} />}

          <div className="qc-upload__table">
            <table>
              <thead>
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c.name} scope="col">{c.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((row, i) => (
                  <tr key={i}>
                    {preview.columns.map((c) => (
                      <td key={c.name}>{cell(row[c.name])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="qc-upload__actions">
            {onCancel && (
              <button type="button" className="qc-ghost-button" onClick={onCancel}>
                Cancel
              </button>
            )}
            <button type="button" className="qc-ghost-button" disabled={busy !== "" || !name || mode === "append"} onClick={() => void upload(true)}
                    title="Ask questions about it now; it is deleted automatically after 24 hours">
              <Clock size={15} /> Use without saving
            </button>
            <button type="button" className="qc-primary-button" disabled={busy !== "" || !name} onClick={() => void upload(false)}>
              <Save size={15} />
              {busy === "upload"
                ? "Importing…"
                : `${mode === "append" ? "Append" : mode === "replace" ? "Save, replacing" : "Save"} ${preview.rows.toLocaleString()} rows`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
