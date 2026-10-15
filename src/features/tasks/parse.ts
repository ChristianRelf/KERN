/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Lightweight, conservative natural-language parsing for quick task entry:
//   "Call Sam tomorrow 3pm #website @phone p1 every week"
// Only whole, recognised tokens are consumed; everything else stays in the
// title. Fully deterministic and offline.

import { addDaysStr, isDateStr, isoWeekday, nextWeekdayStr, todayStr } from "@/lib/dates";
import type { Recurrence } from "@/lib/types";

export interface ParsedTask {
  title: string;
  dueDate?: string;
  dueTime?: string;
  priority?: number;
  projectId?: string;
  projectName?: string;
  labelNames: string[];
  recurrence?: Recurrence;
  tokens: { text: string; kind: "date" | "time" | "priority" | "project" | "label" | "repeat" }[];
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const SHORT = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const PRIORITY_WORDS: Record<string, number> = {
  p1: 4,
  p2: 3,
  p3: 2,
  p4: 1,
  "!urgent": 4,
  "!high": 3,
  "!medium": 2,
  "!med": 2,
  "!low": 1,
  "!!!": 4,
  "!!": 3,
};

function parseTime(tok: string): string | undefined {
  const m = tok.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (!ap && !m[2]) return undefined; // bare numbers aren't times
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function normalise(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseQuickTask(
  input: string,
  ctx: { projects?: { id: string; name: string }[]; today?: string } = {},
): ParsedTask {
  const today = ctx.today ?? todayStr();
  const out: ParsedTask = { title: "", labelNames: [], tokens: [] };
  const words = input.trim().split(/\s+/).filter(Boolean);
  const keep: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lw = w.toLowerCase();
    const next = words[i + 1]?.toLowerCase();
    const take = (n: number, kind: ParsedTask["tokens"][number]["kind"]) => {
      out.tokens.push({ text: words.slice(i, i + n).join(" "), kind });
      i += n - 1;
    };

    // Recurrence
    if (lw === "every" && next) {
      const n2 = words[i + 2]?.toLowerCase();
      const numeric = /^\d+$/.test(next) ? Number(next) : null;
      const unit = numeric ? n2 : next;
      const span = numeric ? 3 : 2;
      const unitMap: Record<string, Recurrence["freq"]> = {
        day: "daily",
        days: "daily",
        week: "weekly",
        weeks: "weekly",
        month: "monthly",
        months: "monthly",
        year: "yearly",
        years: "yearly",
        weekday: "weekdays",
        weekdays: "weekdays",
      };
      if (unit && unitMap[unit]) {
        out.recurrence = { freq: unitMap[unit], interval: numeric ?? 1 };
        take(span, "repeat");
        continue;
      }
      const wd = unit ? WEEKDAYS.indexOf(unit) : -1;
      const swd = unit ? SHORT.indexOf(unit) : -1;
      if (!numeric && (wd >= 0 || swd >= 0)) {
        const iso = (wd >= 0 ? wd : swd) + 1;
        out.recurrence = { freq: "weekly", interval: 1, weekdays: [iso] };
        if (!out.dueDate) out.dueDate = isoWeekday(today) === iso ? today : nextWeekdayStr(today, iso);
        take(2, "repeat");
        continue;
      }
    }
    if (["daily", "weekly", "monthly", "yearly"].includes(lw)) {
      out.recurrence = { freq: lw as Recurrence["freq"], interval: 1 };
      take(1, "repeat");
      continue;
    }

    // Dates
    if (lw === "today" || lw === "tod") {
      out.dueDate = today;
      take(1, "date");
      continue;
    }
    if (lw === "tomorrow" || lw === "tmr" || lw === "tmrw") {
      out.dueDate = addDaysStr(today, 1);
      take(1, "date");
      continue;
    }
    if (lw === "next" && next === "week") {
      out.dueDate = addDaysStr(today, 7);
      take(2, "date");
      continue;
    }
    if (lw === "in" && next && /^\d+$/.test(next)) {
      const unit = words[i + 2]?.toLowerCase();
      const n = Number(next);
      if (unit === "day" || unit === "days") {
        out.dueDate = addDaysStr(today, n);
        take(3, "date");
        continue;
      }
      if (unit === "week" || unit === "weeks") {
        out.dueDate = addDaysStr(today, n * 7);
        take(3, "date");
        continue;
      }
    }
    const wdIdx = WEEKDAYS.indexOf(lw);
    const prefixedShort = (lw === "on" || lw === "next") && next && SHORT.includes(next);
    if (wdIdx >= 0 || prefixedShort || (SHORT.includes(lw) && i === words.length - 1 && i > 0)) {
      const iso = (wdIdx >= 0 ? wdIdx : SHORT.indexOf(prefixedShort ? next! : lw)) + 1;
      out.dueDate = nextWeekdayStr(today, iso);
      take(prefixedShort ? 2 : 1, "date");
      continue;
    }
    if (isDateStr(w)) {
      out.dueDate = w;
      take(1, "date");
      continue;
    }

    // Times: "at 3pm", "15:30", "9am"
    if (lw === "at" && next) {
      const t = parseTime(next);
      if (t) {
        out.dueTime = t;
        take(2, "time");
        continue;
      }
    }
    const t = parseTime(w);
    if (t) {
      out.dueTime = t;
      take(1, "time");
      continue;
    }

    // Priority
    if (PRIORITY_WORDS[lw] !== undefined) {
      out.priority = PRIORITY_WORDS[lw];
      take(1, "priority");
      continue;
    }

    // Project (#name, prefix match ignoring spaces/case)
    if (w.startsWith("#") && w.length > 1 && ctx.projects?.length) {
      const q = normalise(w.slice(1));
      const exact = ctx.projects.find((p) => normalise(p.name) === q);
      const prefix = exact ?? ctx.projects.find((p) => normalise(p.name).startsWith(q));
      if (prefix) {
        out.projectId = prefix.id;
        out.projectName = prefix.name;
        take(1, "project");
        continue;
      }
    }

    // Labels (@name)
    if (w.startsWith("@") && w.length > 1 && /^@[\p{L}\p{N}_-]+$/u.test(w)) {
      out.labelNames.push(w.slice(1));
      take(1, "label");
      continue;
    }

    keep.push(w);
  }

  if (out.dueTime && !out.dueDate) out.dueDate = today;
  if (out.recurrence && !out.dueDate) out.dueDate = today;
  out.title = keep.join(" ");
  return out;
}
