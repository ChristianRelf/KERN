/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Local-calendar date helpers. Due dates are stored as local "YYYY-MM-DD"
// strings and times as "HH:MM", so they never shift with timezone or DST
// changes. Instants (created/completed) are UTC epoch milliseconds.

import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  format,
  isValid,
  parse,
  startOfMonth,
  startOfWeek,
} from "date-fns";

export type DateFormat = "relative" | "dmy" | "mdy" | "iso";
export type TimeFormat = "24h" | "12h";

/** Formatting preferences, kept in sync with settings by the settings store. */
export const dateConfig = {
  dateFormat: "relative" as DateFormat,
  timeFormat: "24h" as TimeFormat,
  weekStart: 1 as 0 | 1,
};

export function toDateStr(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

export function parseDateStr(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function isDateStr(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && isValid(parse(s, "yyyy-MM-dd", new Date()));
}

export function todayStr(now = new Date()): string {
  return toDateStr(now);
}

export function addDaysStr(s: string, n: number): string {
  return toDateStr(addDays(parseDateStr(s), n));
}

export function addMonthsStr(s: string, n: number): string {
  return toDateStr(addMonths(parseDateStr(s), n));
}

/** Calendar days from `a` to `b` (b - a). */
export function diffDays(a: string, b: string): number {
  return differenceInCalendarDays(parseDateStr(b), parseDateStr(a));
}

/** Local midnight of a date string, as epoch ms (DST-correct). */
export function dayStartMs(s: string): number {
  return parseDateStr(s).getTime();
}

export function weekStartStr(s: string, weekStart = dateConfig.weekStart): string {
  return toDateStr(startOfWeek(parseDateStr(s), { weekStartsOn: weekStart }));
}

export function monthStartStr(s: string): string {
  return toDateStr(startOfMonth(parseDateStr(s)));
}

export function nextWeekdayStr(from: string, isoWeekday: number): string {
  // isoWeekday 1..7 (Mon..Sun); returns the next such day strictly after `from`.
  const d = parseDateStr(from);
  const cur = ((d.getDay() + 6) % 7) + 1;
  let delta = (isoWeekday - cur + 7) % 7;
  if (delta === 0) delta = 7;
  return addDaysStr(from, delta);
}

export function formatTime(hhmm: string | null | undefined, fmt: TimeFormat = dateConfig.timeFormat): string {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  if (fmt === "24h") return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

/** Absolute date in the user's preferred format. */
export function formatDateAbs(s: string, withYear?: boolean, fmt: DateFormat = dateConfig.dateFormat): string {
  const d = parseDateStr(s);
  const showYear = withYear ?? d.getFullYear() !== new Date().getFullYear();
  switch (fmt) {
    case "iso":
      return s;
    case "mdy":
      return format(d, showYear ? "MMM d, yyyy" : "MMM d");
    case "dmy":
    case "relative":
    default:
      return format(d, showYear ? "d MMM yyyy" : "d MMM");
  }
}

/** Compact due label: Today, Tomorrow, Yesterday, weekday within a week, else date. */
export function formatDue(s: string | null | undefined, time?: string | null, today = todayStr()): string {
  if (!s) return "";
  const t = time ? ` ${formatTime(time)}` : "";
  if (dateConfig.dateFormat !== "relative") return formatDateAbs(s) + t;
  const diff = diffDays(today, s);
  if (diff === 0) return `Today${t}`;
  if (diff === 1) return `Tomorrow${t}`;
  if (diff === -1) return `Yesterday${t}`;
  if (diff > 1 && diff < 7) return format(parseDateStr(s), "EEE") + t;
  return formatDateAbs(s) + t;
}

export function formatDayHeading(s: string, today = todayStr()): string {
  const diff = diffDays(today, s);
  const base = format(parseDateStr(s), "EEEE d MMMM");
  if (diff === 0) return `Today · ${format(parseDateStr(s), "EEE d MMM")}`;
  if (diff === 1) return `Tomorrow · ${format(parseDateStr(s), "EEE d MMM")}`;
  if (diff === -1) return `Yesterday · ${format(parseDateStr(s), "EEE d MMM")}`;
  return base;
}

export type DueState = "overdue" | "today" | "soon" | "later" | null;

export function dueState(due: string | null | undefined, completed: boolean, today = todayStr()): DueState {
  if (!due || completed) return null;
  const diff = diffDays(today, due);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= 2) return "soon";
  return "later";
}

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.round((now - ms) / 1000);
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  const days = Math.round(diff / 86400);
  if (days < 7) return `${days}d ago`;
  return formatDateAbs(toDateStr(new Date(ms)));
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return s > 0 ? `${s}s` : "0m";
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Day boundaries used by rundown/statistics queries. */
export function dayBounds(today = todayStr()) {
  return {
    today,
    dayStart: dayStartMs(today),
    tomorrowStart: dayStartMs(addDaysStr(today, 1)),
    yesterdayStart: dayStartMs(addDaysStr(today, -1)),
    weekStart: dayStartMs(weekStartStr(today)),
  };
}

export function isoWeekday(s: string): number {
  return ((parseDateStr(s).getDay() + 6) % 7) + 1;
}

export function monthGrid(monthStart: string, weekStart = dateConfig.weekStart): string[] {
  const first = parseDateStr(monthStart);
  const gridStart = startOfWeek(first, { weekStartsOn: weekStart });
  return Array.from({ length: 42 }, (_, i) => toDateStr(addDays(gridStart, i)));
}

export function weekdayLabels(weekStart = dateConfig.weekStart, style: "narrow" | "short" = "short"): string[] {
  const base = style === "narrow" ? ["S", "M", "T", "W", "T", "F", "S"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return weekStart === 1 ? [...base.slice(1), base[0]] : base;
}
