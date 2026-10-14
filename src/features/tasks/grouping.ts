import type { Label, Milestone, Project, Task, TaskFilters, TaskGrouping, TaskQuery } from "@/lib/types";
import { addDaysStr, diffDays, formatDayHeading, weekStartStr } from "@/lib/dates";
import { PRIORITY_LABELS, STATUS_LABELS, STATUS_ORDER } from "./meta";
import type { TaskSection } from "./TaskList";
import { accentColor } from "@/features/projects/ProjectGlyph";

export function filtersToQuery(f: TaskFilters, today: string): TaskQuery {
  const q: TaskQuery = { topLevelOnly: !f.search && !f.showSubtasks, order: f.sort ?? "manual" };
  if (f.projectIds?.length) q.projectIds = f.projectIds;
  if (f.noProject) q.noProject = true;
  if (f.statuses?.length) q.statuses = f.statuses;
  if (f.priorities?.length) q.priorities = f.priorities;
  if (f.labelIds?.length) q.labelIds = f.labelIds;
  if (f.search?.trim()) q.search = f.search.trim();
  q.includeCompleted = !!f.showCompleted;
  switch (f.due) {
    case "overdue":
      q.overdueAsOf = today;
      break;
    case "today":
      q.dueTo = today;
      q.hasDue = true;
      break;
    case "week": {
      const end = addDaysStr(weekStartStr(today), 6);
      q.dueTo = end;
      q.hasDue = true;
      break;
    }
    case "next7":
      q.dueTo = addDaysStr(today, 7);
      q.hasDue = true;
      break;
    case "next30":
      q.dueTo = addDaysStr(today, 30);
      q.hasDue = true;
      break;
    case "none":
      q.hasDue = false;
      break;
    case "dated":
      q.hasDue = true;
      break;
  }
  return q;
}

export function activeFilterCount(f: TaskFilters): number {
  let n = 0;
  if (f.projectIds?.length || f.noProject) n++;
  if (f.statuses?.length) n++;
  if (f.priorities?.length) n++;
  if (f.labelIds?.length) n++;
  if (f.due && f.due !== "any") n++;
  if (f.showCompleted) n++;
  if (f.search?.trim()) n++;
  return n;
}

function dueBucket(t: Task, today: string): { key: string; title: string; order: number } {
  if (!t.dueDate) return { key: "none", title: "No date", order: 9999 };
  const d = diffDays(today, t.dueDate);
  if (d < 0) return { key: "overdue", title: "Overdue", order: -1 };
  if (d === 0) return { key: "today", title: "Today", order: 0 };
  if (d === 1) return { key: "tomorrow", title: "Tomorrow", order: 1 };
  if (d < 7) return { key: "week", title: "Next 7 days", order: 2 };
  if (d < 30) return { key: "month", title: "Next 30 days", order: 3 };
  return { key: "later", title: "Later", order: 4 };
}

export interface GroupContext {
  today: string;
  projects: Map<string, Project>;
  labels?: Map<string, Label>;
  milestones?: Map<string, Milestone>;
}

export function groupTasks(tasks: Task[], grouping: TaskGrouping, ctx: GroupContext): TaskSection[] {
  if (grouping === "none") return [{ key: "all", tasks, collapsible: false }];
  const map = new Map<string, { title: string; order: number; tasks: Task[]; defaults?: TaskSection["addDefaults"]; color?: string }>();
  const push = (key: string, title: string, order: number, t: Task, defaults?: TaskSection["addDefaults"], color?: string) => {
    if (!map.has(key)) map.set(key, { title, order, tasks: [], defaults, color });
    map.get(key)!.tasks.push(t);
  };
  for (const t of tasks) {
    switch (grouping) {
      case "project": {
        const p = t.projectId ? ctx.projects.get(t.projectId) : undefined;
        push(p?.id ?? "none", p?.name ?? "No project", p ? p.sortOrder : -1, t, { projectId: p?.id ?? null, status: p ? "todo" : "inbox" });
        break;
      }
      case "due": {
        const b = dueBucket(t, ctx.today);
        push(b.key, b.title, b.order, t);
        break;
      }
      case "priority":
        push(String(t.priority), PRIORITY_LABELS[t.priority], -t.priority, t, { priority: t.priority });
        break;
      case "status":
        push(t.status, STATUS_LABELS[t.status], STATUS_ORDER.indexOf(t.status), t, { status: t.status });
        break;
      case "label": {
        // A task with several labels appears under each of them.
        const named = t.labelIds.map((id) => ctx.labels?.get(id)).filter(Boolean) as Label[];
        if (!named.length) push("none", "No label", Number.MAX_SAFE_INTEGER, t);
        for (const l of named) push(l.id, l.name, 0, t, { labelIds: [l.id] }, accentColor(l.color));
        break;
      }
      case "milestone": {
        const m = t.milestoneId ? ctx.milestones?.get(t.milestoneId) : undefined;
        const order = m ? (m.targetDate ? Date.parse(m.targetDate) : 8e15) + m.sortOrder : 9e15;
        push(m?.id ?? "none", m?.title ?? "No milestone", order, t);
        break;
      }
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[1].order - b[1].order || a[1].title.localeCompare(b[1].title))
    .map(([key, g]) => ({ key, title: g.title, tasks: g.tasks, color: g.color }));
}

/** Groups, then optionally sub-groups each group (a header row, then its sub-sections). */
export function groupSections(tasks: Task[], grouping: TaskGrouping, subGrouping: TaskGrouping | undefined, ctx: GroupContext): TaskSection[] {
  const top = groupTasks(tasks, grouping, ctx);
  if (grouping === "none" || !subGrouping || subGrouping === "none" || subGrouping === grouping) return top;
  return top.flatMap((s) => [
    { ...s, tasks: [], count: s.tasks.length },
    ...groupTasks(s.tasks, subGrouping, ctx).map((c) => ({ ...c, key: `${s.key}/${c.key}`, level: 1, parentKey: s.key })),
  ]);
}

/** Upcoming view: one section per day for the next `days` days, then later. */
export function upcomingSections(tasks: Task[], today: string, days = 14): TaskSection[] {
  const overdue = tasks.filter((t) => t.dueDate && t.dueDate < today);
  const sections: TaskSection[] = [];
  if (overdue.length) sections.push({ key: "overdue", title: "Overdue", tasks: overdue });
  for (let i = 0; i < days; i++) {
    const d = addDaysStr(today, i);
    const dayTasks = tasks.filter((t) => t.dueDate === d);
    // Always show the coming week; beyond that only days with tasks.
    if (i >= 7 && !dayTasks.length) continue;
    sections.push({ key: d, title: formatDayHeading(d, today), tasks: dayTasks, collapsible: false });
  }
  const horizon = addDaysStr(today, days - 1);
  const later = tasks.filter((t) => t.dueDate && t.dueDate > horizon);
  if (later.length) sections.push({ key: "later", title: "Later", tasks: later });
  return sections;
}
