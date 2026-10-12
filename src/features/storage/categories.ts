import type { StorageCategory, StorageCategoryId } from "@/lib/types";

export const CATEGORY_LABEL: Record<StorageCategoryId | "logsOther", string> = {
  database: "Database",
  attachments: "Attachments",
  whiteboard: "Whiteboard assets",
  backups: "Backups",
  cache: "Cache",
  logs: "Logs",
  other: "Other",
  logsOther: "Logs & other",
};

export const CATEGORY_HINT: Record<StorageCategoryId, string> = {
  database: "Tasks, projects, notes and whiteboards (SQLite, including its write-ahead log).",
  attachments: "Files attached to tasks and projects, copied into Kern's storage.",
  whiteboard: "Images and files placed on whiteboards.",
  backups: "Automatic and manual backups, plus safety copies made before upgrades and restores.",
  cache: "Website icons, temporary files and the web view's own cache. Safe to clear.",
  logs: "Diagnostic logs.",
  other: "Anything else in Kern's data folder.",
};

export interface DisplayCategory {
  id: StorageCategoryId | "logsOther";
  bytes: number;
  files: number;
  /** Fixed tone slot (0–5): a category keeps its tone between scans. */
  slot: number;
}

const ORDER: StorageCategoryId[] = ["database", "attachments", "whiteboard", "backups", "cache"];

/** At most six rows in a fixed order; logs fold into "Other" when both exist. */
export function displayCategories(cats: StorageCategory[]): DisplayCategory[] {
  const by = new Map(cats.map((c) => [c.id, c]));
  const get = (id: StorageCategoryId) => by.get(id) ?? { id, bytes: 0, files: 0 };
  const rows: DisplayCategory[] = ORDER.map((id, slot) => ({ ...get(id), slot }));
  const logs = get("logs");
  const other = get("other");
  if (logs.bytes > 0 && other.bytes > 0) rows.push({ id: "logsOther", bytes: logs.bytes + other.bytes, files: logs.files + other.files, slot: 5 });
  else if (logs.bytes > 0) rows.push({ ...logs, slot: 5 });
  else rows.push({ ...other, slot: 5 });
  return rows;
}

export function largest(cats: StorageCategory[]): DisplayCategory | null {
  const rows = displayCategories(cats).filter((r) => r.bytes > 0);
  return rows.length ? rows.reduce((a, b) => (b.bytes > a.bytes ? b : a)) : null;
}
