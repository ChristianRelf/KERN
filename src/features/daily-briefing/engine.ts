/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Deterministic daily rundown. No AI, no network: a transparent score built
// from priority, due date, overdue duration, pinning, status and carry-over,
// with every contributing factor reported as a human-readable reason.

import { addDaysStr, diffDays } from "@/lib/dates";
import type { Project, RundownData, Task } from "@/lib/types";

export interface ScoreFactor {
  label: string;
  points: number;
}

export interface ScoredTask {
  task: Task;
  score: number;
  factors: ScoreFactor[];
}

export interface ProjectAttention {
  project: Project;
  reasons: string[];
}

export interface RundownOptions {
  today: string;
  maxTasks: number;
  includeOverdue: boolean;
  includeUpcoming: boolean;
  includeCompleted: boolean;
  includeProjects: boolean;
  /** Task ids carried over from the previous day's plan. */
  carryIds?: Set<string>;
  /** Tasks the user dismissed from today's suggestions. */
  skipped?: Set<string>;
}

export interface Rundown {
  day: string;
  summary: string;
  counts: {
    today: number;
    overdue: number;
    high: number;
    upcoming: number;
    inProgress: number;
    completedToday: number;
    completedYesterday: number;
  };
  suggestions: ScoredTask[];
  overdue: Task[];
  today: Task[];
  high: Task[];
  upcoming: Task[];
  carryovers: Task[];
  inProgress: Task[];
  completedToday: Task[];
  completedYesterday: Task[];
  projects: ProjectAttention[];
}

const PRIORITY_POINTS = [0, 5, 14, 28, 40];
const PRIORITY_NAMES = ["", "Low priority", "Medium priority", "High priority", "Urgent"];

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const words = (n: number) => (n <= 10 ? NUMBER_WORDS[n] : String(n));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function inDays(n: number): string {
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n < 0) return n === -1 ? "yesterday" : `${words(-n)} days ago`;
  return `in ${words(n)} days`;
}

export function scoreTask(t: Task, ctx: { today: string; carryIds?: Set<string>; projects?: Map<string, Project> }): ScoredTask {
  const factors: ScoreFactor[] = [];
  const add = (label: string, points: number) => points !== 0 && factors.push({ label, points });

  add(PRIORITY_NAMES[t.priority] ?? "", PRIORITY_POINTS[t.priority] ?? 0);
  if (t.dueDate) {
    const d = diffDays(ctx.today, t.dueDate);
    if (d < 0) {
      const days = -d;
      add(days === 1 ? "1 day overdue" : `${days} days overdue`, 30 + Math.min(days, 7) * 4);
    } else if (d === 0) {
      add("Due today", 25);
    } else if (d === 1) {
      add("Due tomorrow", 12);
    } else if (d <= 3) {
      add(`Due ${inDays(d)}`, 6);
    }
  }
  if (t.pinned) add("Pinned", 20);
  if (t.status === "in_progress") add("In progress", 10);
  if (t.status === "blocked") add("Blocked", -40);
  else if (t.blockedBy) add("Waiting on another task", -40);
  if (ctx.carryIds?.has(t.id)) add("Carried over", 8);
  if (t.projectId && ctx.projects) {
    const p = ctx.projects.get(t.projectId);
    if (p?.targetDate) {
      const d = diffDays(ctx.today, p.targetDate);
      if (d >= 0 && d <= 7) add(`${p.name} due ${inDays(d)}`, 5);
    }
  }
  const score = factors.reduce((s, f) => s + f.points, 0);
  return { task: t, score, factors };
}

function uniqueById(lists: Task[][]): Task[] {
  const seen = new Map<string, Task>();
  for (const list of lists) for (const t of list) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()];
}

export function projectsNeedingAttention(projects: Project[], today: string): ProjectAttention[] {
  const out: ProjectAttention[] = [];
  for (const p of projects) {
    if (p.archivedAt) continue;
    const reasons: string[] = [];
    const open = p.taskTotal - p.taskDone;
    if (p.taskOverdue > 0) reasons.push(`${plural(p.taskOverdue, "overdue task")}`);
    if (p.targetDate && open > 0) {
      const d = diffDays(today, p.targetDate);
      if (d < 0) reasons.push(`Target date passed ${inDays(d)}`);
      else if (d <= 7) reasons.push(`Due ${inDays(d)}, ${Math.round((p.taskDone / Math.max(1, p.taskTotal)) * 100)}% done`);
    }
    if (open > 0 && p.lastActivityAt) {
      const idle = Math.floor((Date.now() - p.lastActivityAt) / 86_400_000);
      if (idle >= 14) reasons.push(`No activity for ${idle} days`);
    }
    if (reasons.length) out.push({ project: p, reasons });
  }
  return out.sort((a, b) => b.project.taskOverdue - a.project.taskOverdue || b.reasons.length - a.reasons.length);
}

export function buildRundown(data: RundownData, opts: RundownOptions): Rundown {
  const { today } = opts;
  const projects = new Map(data.projects.map((p) => [p.id, p]));
  const open = uniqueById([data.overdue, data.today, data.highPriority, data.inProgress, data.pinned]);
  const carryovers = open.filter(
    (t) => opts.carryIds?.has(t.id) && (!t.dueDate || t.dueDate <= today),
  );
  const scored = open
    .filter((t) => opts.includeOverdue || !t.dueDate || t.dueDate >= today)
    .map((t) => scoreTask(t, { today, carryIds: opts.carryIds, projects }))
    .filter((s) => s.score > 0 && !opts.skipped?.has(s.task.id))
    .sort((a, b) => b.score - a.score || (a.task.dueDate ?? "9").localeCompare(b.task.dueDate ?? "9") || a.task.sortOrder - b.task.sortOrder);
  const suggestions = scored.filter((s) => s.task.status !== "blocked" && !s.task.blockedBy).slice(0, Math.min(3, opts.maxTasks));

  const counts = {
    today: data.today.length,
    overdue: data.overdue.length,
    high: data.highPriority.length,
    upcoming: data.upcoming.length,
    inProgress: data.inProgress.length,
    completedToday: data.completedToday.length,
    completedYesterday: data.completedYesterday.length,
  };

  const projectAttention = opts.includeProjects ? projectsNeedingAttention(data.projects, today) : [];

  return {
    day: today,
    summary: summarize(data, opts, projectAttention),
    counts,
    suggestions,
    overdue: opts.includeOverdue ? data.overdue : [],
    today: data.today,
    high: data.highPriority.filter((t) => !data.today.some((x) => x.id === t.id) && !data.overdue.some((x) => x.id === t.id)),
    upcoming: opts.includeUpcoming ? data.upcoming : [],
    carryovers,
    inProgress: data.inProgress,
    completedToday: data.completedToday,
    completedYesterday: opts.includeCompleted ? data.completedYesterday : [],
    projects: projectAttention,
  };
}

export function summarize(data: RundownData, opts: RundownOptions, attention: ProjectAttention[] = []): string {
  const parts: string[] = [];
  const nToday = data.today.length;
  const nOver = opts.includeOverdue ? data.overdue.length : 0;
  const nHigh = data.highPriority.length;

  if (nToday + nOver + nHigh === 0) {
    parts.push("Nothing is scheduled for today.");
  } else {
    const clauses: string[] = [`${plural(nToday, "task")} scheduled`];
    if (nOver) clauses.push(`${nOver} overdue`);
    if (nHigh) clauses.push(`${plural(nHigh, "high-priority item")}`);
    const last = clauses.pop()!;
    parts.push(`Today you have ${clauses.length ? `${clauses.join(", ")}${clauses.length > 1 ? "," : ""} and ${last}` : last}.`);
  }

  // The most pressing deadline: a project target or the next dated task.
  if (opts.includeUpcoming) {
    const target = data.projects
      .filter((p) => p.targetDate && p.taskDone < p.taskTotal)
      .map((p) => ({ name: p.name, d: diffDays(opts.today, p.targetDate!) }))
      .filter((x) => x.d >= 0 && x.d <= 7)
      .sort((a, b) => a.d - b.d)[0];
    if (target) {
      parts.push(`${target.name} is due ${inDays(target.d)}.`);
    } else {
      const next = data.upcoming.find((t) => t.priority >= 3 && t.dueDate && t.dueDate <= addDaysStr(opts.today, 3));
      if (next) parts.push(`"${next.title}" is due ${inDays(diffDays(opts.today, next.dueDate!))}.`);
    }
  }
  if (opts.includeProjects && attention.length && !parts.some((p) => p.includes(attention[0].project.name))) {
    const a = attention[0];
    if (a.project.taskOverdue > 0) parts.push(`${a.project.name} needs attention.`);
  }
  if (opts.includeCompleted && data.completedYesterday.length) {
    parts.push(`You completed ${plural(data.completedYesterday.length, "task")} yesterday.`);
  }
  return parts.join(" ");
}

// ------------------------------------------------------------ snapshots

export interface SnapshotTask {
  id: string;
  title: string;
  dueDate: string | null;
  priority: number;
  projectId: string | null;
}

export interface MorningSnapshot {
  version: 1;
  generatedAt: number;
  summary: string;
  counts: Rundown["counts"];
  suggested: (SnapshotTask & { reasons: string[] })[];
  overdue: SnapshotTask[];
  today: SnapshotTask[];
  upcoming: SnapshotTask[];
  completedYesterday: SnapshotTask[];
  projects: { id: string; name: string; reasons: string[] }[];
  skipped: string[];
}

export interface EveningSnapshot {
  version: 1;
  generatedAt: number;
  completed: SnapshotTask[];
  unfinished: SnapshotTask[];
  movedToTomorrow: SnapshotTask[];
}

export const snapTask = (t: Task): SnapshotTask => ({
  id: t.id,
  title: t.title,
  dueDate: t.dueDate,
  priority: t.priority,
  projectId: t.projectId,
});

export function toMorningSnapshot(r: Rundown, skipped: string[] = []): MorningSnapshot {
  return {
    version: 1,
    generatedAt: Date.now(),
    summary: r.summary,
    counts: r.counts,
    suggested: r.suggestions.map((s) => ({ ...snapTask(s.task), reasons: s.factors.map((f) => f.label) })),
    overdue: r.overdue.map(snapTask),
    today: r.today.map(snapTask),
    upcoming: r.upcoming.slice(0, 20).map(snapTask),
    completedYesterday: r.completedYesterday.map(snapTask),
    projects: r.projects.map((p) => ({ id: p.project.id, name: p.project.name, reasons: p.reasons })),
    skipped,
  };
}

/** Ids planned for a day (scheduled or suggested), used for carry-over. */
export function plannedIds(s: MorningSnapshot | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set([...s.today.map((t) => t.id), ...s.suggested.map((t) => t.id)]);
}
