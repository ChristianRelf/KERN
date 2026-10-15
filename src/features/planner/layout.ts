// Day-planner geometry: minutes of the day, overlapping items side by side,
// free time between busy blocks, and filling free time with tasks.

import type { CalEvent } from "@/lib/types";

export const SNAP = 15;
/** Length used for time blocks of tasks without an estimate. */
export const DEFAULT_MINUTES = 30;

export const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export const fromMin = (m: number) => {
  const c = Math.max(0, Math.min(24 * 60 - 1, Math.round(m)));
  return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
};

export const snap = (m: number, step = SNAP) => Math.round(m / step) * step;

export interface Span {
  id: string;
  start: number;
  end: number;
}

/**
 * Places overlapping spans in columns: each span gets its column and the
 * number of columns in its cluster (spans that overlap, directly or through
 * others), so the cluster shares the width evenly.
 */
export function layoutColumns(spans: Span[]): Map<string, { col: number; cols: number }> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map<string, { col: number; cols: number }>();
  let cluster: { span: Span; col: number }[] = [];
  let clusterEnd = -1;
  const close = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) out.set(c.span.id, { col: c.col, cols });
    cluster = [];
  };
  for (const s of sorted) {
    if (cluster.length && s.start >= clusterEnd) close();
    // The first column whose last span has ended.
    const used = new Map<number, number>();
    for (const c of cluster) used.set(c.col, Math.max(used.get(c.col) ?? -1, c.span.end));
    let col = 0;
    while (used.has(col) && used.get(col)! > s.start) col++;
    cluster.push({ span: s, col });
    clusterEnd = Math.max(clusterEnd, s.end);
  }
  if (cluster.length) close();
  return out;
}

/** Free intervals within [from, to] not covered by `busy`. */
export function freeGaps(busy: { start: number; end: number }[], from: number, to: number): { start: number; end: number }[] {
  const sorted = busy.filter((b) => b.end > from && b.start < to).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  let cur = from;
  for (const b of sorted) {
    if (b.start > cur) out.push({ start: cur, end: Math.min(b.start, to) });
    cur = Math.max(cur, b.end);
    if (cur >= to) break;
  }
  if (cur < to) out.push({ start: cur, end: to });
  return out.filter((g) => g.end - g.start > 0);
}

/**
 * Fills free time with tasks in the given order (first fit, on snapped
 * starts). Tasks that don't fit anywhere are left out.
 */
export function autoPlan(tasks: { id: string; minutes: number }[], busy: { start: number; end: number }[], from: number, to: number): { id: string; start: number }[] {
  const taken = busy.map((b) => ({ ...b }));
  const out: { id: string; start: number }[] = [];
  for (const t of tasks) {
    const len = Math.max(SNAP, t.minutes);
    const gap = freeGaps(taken, Math.ceil(from / SNAP) * SNAP, to).find((g) => {
      const s = Math.ceil(g.start / SNAP) * SNAP;
      return s + len <= g.end;
    });
    if (!gap) continue;
    const start = Math.ceil(gap.start / SNAP) * SNAP;
    out.push({ id: t.id, start });
    taken.push({ start, end: start + len });
  }
  return out;
}

/** The part of an event on `day`, in minutes, or null (all-day events too). */
export function eventSpan(e: CalEvent, day: string): { start: number; end: number } | null {
  if (e.allDay) return null;
  const sDay = e.start.slice(0, 10);
  const eDay = e.end.slice(0, 10);
  if (sDay > day || eDay < day) return null;
  const start = sDay < day ? 0 : toMin(e.start.slice(11, 16));
  const end = eDay > day ? 24 * 60 : toMin(e.end.slice(11, 16));
  return { start, end: Math.max(end, start + 15) };
}

/** All-day events covering `day`. */
export const coversDay = (e: CalEvent, day: string) => e.allDay && e.start <= day && e.end >= day;
