/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// Readers for other apps' exports. Each turns a file into one neutral bundle
// (projects with board columns, tasks with subtasks and labels), which the
// backend writes in a single transaction.
//
//   Todoist  – a project's CSV export (TYPE, CONTENT, PRIORITY, INDENT, DATE…)
//   Trello   – a board's JSON export (lists, cards, labels, checklists)
//   Linear   – the workspace CSV export (Title, Status, Priority, Project…)
//   Notion / any CSV – a table with a title column and optional status, due
//              date, priority, tags and project columns

import type { ImportBundle, ImportProject, ImportTask, TaskStatus } from "@/lib/types";

export type ImportSource = "todoist" | "trello" | "linear" | "csv";

export const SOURCE_LABEL: Record<ImportSource, string> = { todoist: "Todoist", trello: "Trello", linear: "Linear", csv: "CSV / Notion" };

// ------------------------------------------------------------ CSV

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

function records(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const all = parseCsv(text);
  const headers = (all[0] ?? []).map((h) => h.trim());
  const rows = all.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  return { headers, rows };
}

// ------------------------------------------------------------ dates

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function ymd(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/**
 * A date (and time) from the many ways exports write them: ISO
 * (2026-10-20, 2026-10-20T09:30:00Z), slashes (2026/10/20, 10/20/2026 or
 * 20/10/2026 when the day can't be a month), and month names (October 20,
 * 2026; 20 Oct 2026; Oct 20 2026 9:30 AM). Ranges keep their start. UTC
 * timestamps become local time.
 */
export function parseLooseDate(raw: string | null | undefined): { date: string; time: string | null } | null {
  if (!raw) return null;
  let s = raw.trim().split(/\s+(?:→|->|–|to)\s+/)[0].trim();
  if (!s) return null;
  // ISO with a zone: convert to local.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  let time: string | null = null;
  const tm = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\s*$/i.exec(s);
  if (tm) {
    let h = Number(tm[1]);
    const ap = tm[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h < 24) time = `${pad(h)}:${tm[2]}`;
    s = s.slice(0, tm.index).replace(/[T,@\s]+$/, "").trim();
  }
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    const d = ymd(+m[1], +m[2], +m[3]);
    return d ? { date: d, time } : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    // Month first unless the first number can't be a month.
    const d = a > 12 ? ymd(+m[3], b, a) : ymd(+m[3], a, b);
    return d ? { date: d, time } : null;
  }
  const words = s.toLowerCase().replace(/,/g, " ").replace(/(\d)(st|nd|rd|th)\b/g, "$1").split(/\s+/).filter(Boolean);
  const mi = words.findIndex((w) => MONTHS.includes(w.slice(0, 3)) && /^[a-z]+$/.test(w));
  if (mi >= 0) {
    const nums = words.filter((w) => /^\d+$/.test(w)).map(Number);
    const year = nums.find((n) => n > 31);
    const day = nums.find((n) => n >= 1 && n <= 31);
    if (year && day) {
      const d = ymd(year, MONTHS.indexOf(words[mi].slice(0, 3)) + 1, day);
      return d ? { date: d, time } : null;
    }
  }
  return null;
}

const ms = (s: string | undefined) => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

// ------------------------------------------------------------ helpers

function statusFromWords(s: string | undefined): TaskStatus | null {
  const v = (s ?? "").trim().toLowerCase();
  if (!v) return null;
  if (/^(done|complete|completed|closed|finished|shipped|resolved|yes|true|✓|x)$/.test(v)) return "completed";
  if (/(progress|doing|started|review|active|wip)/.test(v)) return "in_progress";
  if (/(block|waiting|on hold|stuck)/.test(v)) return "blocked";
  if (/^(no|false)$/.test(v)) return "todo";
  return "todo";
}

function priorityFromWords(s: string | undefined): number {
  const v = (s ?? "").trim().toLowerCase();
  if (!v) return 0;
  if (/^(urgent|critical|highest|p0|p1)$/.test(v) || v.includes("urgent")) return 4;
  if (/^(high|p2)$/.test(v)) return 3;
  if (/^(medium|normal|p3)$/.test(v)) return 2;
  if (/^(low|lowest|p4)$/.test(v)) return 1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(4, n)) : 0;
}

const splitList = (s: string | undefined) =>
  (s ?? "")
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** "Tasks 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.csv" → "Tasks". */
export function nameFromFile(file: string): string {
  return (
    file
      .replace(/^.*[\\/]/, "")
      .replace(/\.(csv|json)$/i, "")
      .replace(/\s+[0-9a-f]{32}$/i, "")
      .replace(/[_-]+/g, " ")
      .trim() || "Imported"
  );
}

// ------------------------------------------------------------ Todoist

export function fromTodoist(text: string, fileName: string): ImportBundle {
  const { rows } = records(text);
  const key = "todoist";
  const columns: string[] = [];
  const top: ImportTask[] = [];
  const stack: { level: number; task: ImportTask }[] = [];
  let section: string | null = null;
  for (const r of rows) {
    const type = (r.TYPE ?? "").toLowerCase();
    const content = r.CONTENT ?? "";
    if (type === "section") {
      section = content.trim() || null;
      if (section && !columns.includes(section)) columns.push(section);
      stack.length = 0;
      continue;
    }
    if (type === "note") {
      const last = stack[stack.length - 1]?.task;
      if (last && content.trim()) last.description = [last.description, content.trim()].filter(Boolean).join("\n\n");
      continue;
    }
    if (type !== "task" || !content.trim()) continue;
    const level = Math.max(1, Number(r.INDENT) || 1);
    const due = parseLooseDate(r.DATE);
    const p = Number(r.PRIORITY);
    const duration = Number(r.DURATION);
    const t: ImportTask = {
      title: content.trim(),
      description: [r.DESCRIPTION, !due && r.DATE ? `Due: ${r.DATE}` : ""].filter(Boolean).join("\n\n"),
      // Todoist CSV: 1 is the highest priority (p1), 4 the lowest.
      priority: p === 1 ? 4 : p === 2 ? 3 : p === 3 ? 2 : 0,
      dueDate: due?.date ?? null,
      dueTime: due?.time ?? null,
      estimateMinutes: duration > 0 ? ((r.DURATION_UNIT ?? "").toLowerCase().startsWith("day") ? duration * 480 : duration) : null,
      labels: (content.match(/(?:^|\s)@([\w-]+)/g) ?? []).map((l) => l.trim().slice(1)),
      subtasks: [],
    };
    t.title = t.title.replace(/(?:^|\s)@[\w-]+/g, "").trim() || t.title;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1]?.task;
    if (parent) parent.subtasks!.push(t);
    else {
      t.projectKey = key;
      t.column = section;
      top.push(t);
    }
    stack.push({ level, task: t });
  }
  const project: ImportProject = { key, name: nameFromFile(fileName), columns: columns.length ? [{ name: "Backlog", status: null }, ...columns.map((c) => ({ name: c, status: null })), { name: "Done", status: "completed" }] : null };
  // Without sections, tasks use the default board.
  if (columns.length) for (const t of top) if (!t.column) t.column = "Backlog";
  return { source: "Todoist", projects: [project], tasks: top };
}

// ------------------------------------------------------------ Trello

interface TrelloBoard {
  name?: string;
  desc?: string;
  lists?: { id: string; name: string; closed?: boolean; pos?: number }[];
  cards?: { id: string; name: string; desc?: string; idList: string; closed?: boolean; due?: string | null; dueComplete?: boolean; idLabels?: string[]; pos?: number; dateLastActivity?: string }[];
  labels?: { id: string; name?: string; color?: string | null }[];
  checklists?: { id: string; idCard: string; name?: string; pos?: number; checkItems?: { name: string; state: string; pos?: number }[] }[];
}

function columnStatus(name: string): TaskStatus | null {
  const n = name.toLowerCase();
  if (/(done|complete|finished|shipped|closed)/.test(n)) return "completed";
  if (/(doing|progress|working|review|testing)/.test(n)) return "in_progress";
  if (/(block|waiting|on hold)/.test(n)) return "blocked";
  if (/^(to ?do|next|todo|ready)$/.test(n)) return "todo";
  return null;
}

export function fromTrello(json: unknown): ImportBundle {
  const b = json as TrelloBoard;
  if (!b || !Array.isArray(b.cards) || !Array.isArray(b.lists)) throw new Error("That isn't a Trello board export.");
  const key = "trello";
  const lists = b.lists.filter((l) => !l.closed).sort((x, y) => (x.pos ?? 0) - (y.pos ?? 0));
  const listName = new Map(lists.map((l) => [l.id, l.name]));
  const labelName = new Map((b.labels ?? []).map((l) => [l.id, l.name?.trim() || l.color || ""]));
  const tasks: ImportTask[] = b.cards
    .filter((c) => !c.closed && listName.has(c.idList))
    .sort((x, y) => (x.pos ?? 0) - (y.pos ?? 0))
    .map((c) => {
      const due = parseLooseDate(c.due ?? null);
      const column = listName.get(c.idList)!;
      const done = c.dueComplete || columnStatus(column) === "completed";
      const subtasks = (b.checklists ?? [])
        .filter((cl) => cl.idCard === c.id)
        .sort((x, y) => (x.pos ?? 0) - (y.pos ?? 0))
        .flatMap((cl) =>
          (cl.checkItems ?? [])
            .sort((x, y) => (x.pos ?? 0) - (y.pos ?? 0))
            .map((i) => ({ title: i.name, status: (i.state === "complete" ? "completed" : "todo") as TaskStatus, completedAt: i.state === "complete" ? Date.now() : null })),
        );
      return {
        projectKey: key,
        column,
        title: c.name,
        description: c.desc ?? "",
        status: done ? ("completed" as TaskStatus) : null,
        completedAt: done ? (ms(c.dateLastActivity) ?? Date.now()) : null,
        dueDate: due?.date ?? null,
        dueTime: due?.time ?? null,
        labels: (c.idLabels ?? []).map((id) => labelName.get(id) ?? "").filter(Boolean),
        subtasks,
      };
    });
  const project: ImportProject = { key, name: b.name?.trim() || "Trello board", description: b.desc ?? "", columns: lists.map((l) => ({ name: l.name, status: columnStatus(l.name) })) };
  return { source: "Trello", projects: [project], tasks };
}

// ------------------------------------------------------------ Linear

export function fromLinear(text: string): ImportBundle {
  const { rows } = records(text);
  const projects = new Map<string, ImportProject>();
  const byId = new Map<string, ImportTask>();
  const parentOf = new Map<string, string>();
  const order: string[] = [];
  for (const r of rows) {
    const status = (r.Status ?? "").toLowerCase();
    if (/(cancel|duplicate)/.test(status) || r.Canceled) continue;
    const projectName = r.Project?.trim() || r.Team?.trim() || "Linear";
    const pkey = `linear:${projectName}`;
    if (!projects.has(pkey))
      projects.set(pkey, {
        key: pkey,
        name: projectName,
        columns: [
          { name: "Backlog", status: null },
          { name: "Todo", status: "todo" },
          { name: "In Progress", status: "in_progress" },
          { name: "In Review", status: "in_progress" },
          { name: "Done", status: "completed" },
        ],
      });
    const due = parseLooseDate(r["Due Date"]);
    const est = Number(r.Estimate);
    const done = /(done|complete)/.test(status) || !!r.Completed;
    const column = done ? "Done" : /review/.test(status) ? "In Review" : /progress|started/.test(status) ? "In Progress" : /todo|to do|unstarted/.test(status) ? "Todo" : "Backlog";
    const t: ImportTask = {
      projectKey: pkey,
      column,
      title: r.Title || r.ID,
      description: [r.Description, r.ID ? `Linear ${r.ID}` : ""].filter(Boolean).join("\n\n"),
      status: done ? "completed" : null,
      priority: priorityFromWords(r.Priority),
      dueDate: due?.date ?? null,
      labels: splitList(r.Labels),
      completedAt: done ? (ms(r.Completed) ?? Date.now()) : null,
      createdAt: ms(r.Created),
      // Linear estimates are points; keep them out of minutes.
      estimateMinutes: null,
      subtasks: [],
    };
    if (Number.isFinite(est) && est > 0) t.description = `${t.description}\n\nEstimate: ${est} point${est === 1 ? "" : "s"}`.trim();
    const id = r.ID || `row${order.length}`;
    byId.set(id, t);
    order.push(id);
    const parent = r["Parent issue"]?.trim();
    if (parent) parentOf.set(id, parent);
  }
  const tasks: ImportTask[] = [];
  for (const id of order) {
    const t = byId.get(id)!;
    const parent = parentOf.get(id);
    const p = parent ? byId.get(parent) : undefined;
    if (p && p !== t) {
      t.projectKey = undefined;
      t.column = undefined;
      p.subtasks!.push(t);
    } else tasks.push(t);
  }
  return { source: "Linear", projects: [...projects.values()], tasks };
}

// ------------------------------------------------------------ Notion / CSV

const pick = (headers: string[], ...names: RegExp[]) => names.map((re) => headers.find((h) => re.test(h))).find(Boolean);

export function fromCsv(text: string, fileName: string): ImportBundle {
  const { headers, rows } = records(text);
  if (!headers.length) throw new Error("The file is empty.");
  const titleCol = pick(headers, /^(name|title|task|task name|summary|content|subject)$/i) ?? headers[0];
  const descCol = pick(headers, /^(description|notes?|details|body)$/i);
  const statusCol = pick(headers, /^(status|state|stage)$/i);
  const doneCol = pick(headers, /^(done|completed|complete|checked)$/i);
  const dueCol = pick(headers, /^(due|due date|deadline|date|due on)$/i);
  const prioCol = pick(headers, /^(priority|importance)$/i);
  const tagsCol = pick(headers, /^(tags|labels|label|category|categories|type)$/i);
  const projectCol = pick(headers, /^(project|list|area|folder)$/i);
  const estimateCol = pick(headers, /^(estimate|estimate \(min(utes)?\)|duration|minutes)$/i);
  const fallbackProject = nameFromFile(fileName);
  const projects = new Map<string, ImportProject>();
  const tasks: ImportTask[] = [];
  for (const r of rows) {
    const title = r[titleCol]?.trim();
    if (!title) continue;
    const projectName = (projectCol && r[projectCol]?.trim()) || fallbackProject;
    const key = `csv:${projectName}`;
    if (!projects.has(key)) projects.set(key, { key, name: projectName });
    const due = parseLooseDate(dueCol ? r[dueCol] : undefined);
    const doneVal = doneCol ? statusFromWords(r[doneCol]) : null;
    const status = doneVal === "completed" ? "completed" : statusCol ? statusFromWords(r[statusCol]) : null;
    const used = new Set([titleCol, descCol, statusCol, doneCol, dueCol, prioCol, tagsCol, projectCol, estimateCol]);
    // Columns nothing maps to are kept in the description.
    const extra = headers.filter((h) => !used.has(h) && r[h]).map((h) => `**${h}:** ${r[h]}`);
    const est = estimateCol ? Number(r[estimateCol]) : NaN;
    tasks.push({
      projectKey: key,
      title,
      description: [descCol ? r[descCol] : "", extra.join("\n")].filter(Boolean).join("\n\n"),
      status,
      completedAt: status === "completed" ? Date.now() : null,
      priority: priorityFromWords(prioCol ? r[prioCol] : undefined),
      dueDate: due?.date ?? null,
      dueTime: due?.time ?? null,
      labels: splitList(tagsCol ? r[tagsCol] : undefined),
      estimateMinutes: Number.isFinite(est) && est > 0 ? Math.round(est) : null,
    });
  }
  return { source: "CSV", projects: [...projects.values()], tasks };
}

// ------------------------------------------------------------ detection

export function detect(_fileName: string, text: string): ImportSource {
  const t = text.trimStart();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j?.cards) && Array.isArray(j?.lists)) return "trello";
    } catch {
      /* not JSON after all */
    }
    throw new Error("That JSON file isn't an export Kern can read (Trello board exports are supported).");
  }
  const header = (parseCsv(t.split(/\r?\n/, 1)[0] ?? "")[0] ?? []).map((h) => h.trim().toUpperCase());
  if (header.includes("TYPE") && header.includes("CONTENT")) return "todoist";
  if (header.includes("TITLE") && header.includes("STATUS") && header.includes("TEAM")) return "linear";
  return "csv";
}

export function parseExport(fileName: string, text: string, source: ImportSource = detect(fileName, text)): ImportBundle {
  switch (source) {
    case "todoist":
      return fromTodoist(text, fileName);
    case "trello":
      return fromTrello(JSON.parse(text));
    case "linear":
      return fromLinear(text);
    default:
      return { ...fromCsv(text, fileName), source: /[0-9a-f]{32}\.csv$/i.test(fileName) ? "Notion" : "CSV" };
  }
}

export const countTasks = (ts: ImportTask[]): number => ts.reduce((n, t) => n + 1 + countTasks(t.subtasks ?? []), 0);
