/**
 * One CSV cell, quoted. Text starting with = + - @ (or a tab / carriage
 * return) is prefixed with ' so spreadsheet apps show it as text instead of
 * running it as a formula (CSV / formula injection). Numbers are left as is.
 */
export function csvCell(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = value === null || value === undefined ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
