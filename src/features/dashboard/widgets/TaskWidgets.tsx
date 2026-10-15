/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { CalendarRange, SquareCheckBig, ListFilter } from "lucide-react";
import { useMemo } from "react";
import type { WidgetProps } from "../types";
import type { TaskOrder } from "@/lib/types";
import { useTasks, useProjects, useLabels } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { addDaysStr, formatDayHeading, weekStartStr } from "@/lib/dates";
import { MiniTaskList } from "../MiniTaskList";
import { QuickAdd } from "@/features/tasks/QuickAdd";
import { EmptyState, Select, Segmented } from "@/components/ui/Controls";
import { navigate } from "@/stores/router";
import { ToggleRow } from "./RundownWidget";
import { PRIORITY_LABELS } from "@/features/tasks/meta";

// ------------------------------------------------------------- Today

export type TodayConfig = { includeOverdue: boolean; showCompleted: boolean; max: number; showAdd: boolean; sort: TaskOrder };

export function TodayWidget({ config }: WidgetProps<TodayConfig>) {
  const today = useToday();
  const { data: overdue } = useTasks({ overdueAsOf: today, topLevelOnly: true, order: "due" }, { enabled: config.includeOverdue });
  const { data: due } = useTasks({
    dueFrom: today,
    dueTo: today,
    topLevelOnly: true,
    includeCompleted: config.showCompleted,
    order: config.sort,
  });
  const tasks = useMemo(() => {
    const list = [...(config.includeOverdue ? overdue ?? [] : []), ...(due ?? [])];
    // Completed tasks sink to the bottom.
    return list.sort((a, b) => Number(a.status === "completed") - Number(b.status === "completed"));
  }, [overdue, due, config.includeOverdue]);
  return (
    <div className="col" style={{ gap: 2 }}>
      {tasks.length === 0 && !config.showAdd && (
        <EmptyState compact icon={SquareCheckBig}>
          Nothing due today.
        </EmptyState>
      )}
      <MiniTaskList tasks={tasks} max={config.max} onMore={() => navigate({ name: "tasks", view: "today" })} />
      {config.showAdd && (
        <div style={{ margin: "0 -8px" }}>
          <QuickAdd defaults={{ dueDate: today, status: "todo" }} placeholder={tasks.length ? "Add task for today" : "Nothing due today - add a task"} />
        </div>
      )}
    </div>
  );
}

export function TodayConfigForm({ config, setConfig }: { config: TodayConfig; setConfig: (p: Partial<TodayConfig>) => void }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <ToggleRow label="Include overdue" value={config.includeOverdue} onChange={(v) => setConfig({ includeOverdue: v })} />
      <ToggleRow label="Show completed" value={config.showCompleted} onChange={(v) => setConfig({ showCompleted: v })} />
      <ToggleRow label="Quick add" value={config.showAdd} onChange={(v) => setConfig({ showAdd: v })} />
      <SortRow value={config.sort} onChange={(sort) => setConfig({ sort })} />
      <MaxRow value={config.max} onChange={(max) => setConfig({ max })} />
    </div>
  );
}

function SortRow({ value, onChange }: { value: TaskOrder; onChange: (v: TaskOrder) => void }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
      <span className="muted">Sort</span>
      <Select
        value={value}
        onChange={onChange}
        options={[
          { value: "manual", label: "Manual" },
          { value: "due", label: "Due date" },
          { value: "priority", label: "Priority" },
          { value: "created", label: "Newest" },
          { value: "title", label: "Title" },
        ]}
      />
    </div>
  );
}

function MaxRow({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
      <span className="muted">Visible tasks</span>
      <Select
        value={String(value)}
        onChange={(v) => onChange(Number(v))}
        options={[5, 8, 12, 20, 50].map((n) => ({ value: String(n), label: String(n) }))}
      />
    </div>
  );
}

// ------------------------------------------------------------- Upcoming

export type UpcomingConfig = { days: number; max: number; showProject: boolean };

export function UpcomingWidget({ config }: WidgetProps<UpcomingConfig>) {
  const today = useToday();
  const tomorrow = addDaysStr(today, 1);
  const { data } = useTasks({ dueFrom: tomorrow, dueTo: addDaysStr(today, config.days), topLevelOnly: true, order: "due" });
  const groups = useMemo(() => {
    const out: { day: string; tasks: NonNullable<typeof data> }[] = [];
    let shown = 0;
    for (const t of data ?? []) {
      if (shown >= config.max) break;
      const last = out[out.length - 1];
      if (last && last.day === t.dueDate) last.tasks.push(t);
      else out.push({ day: t.dueDate!, tasks: [t] });
      shown++;
    }
    return out;
  }, [data, config.max]);
  const remaining = (data?.length ?? 0) - groups.reduce((n, g) => n + g.tasks.length, 0);
  if (!data?.length)
    return (
      <EmptyState compact icon={CalendarRange}>
        No deadlines in the next {config.days} days.
      </EmptyState>
    );
  return (
    <div className="col">
      {groups.map((g) => (
        <div key={g.day}>
          <div className="mini-head">{formatDayHeading(g.day, today)}</div>
          <MiniTaskList tasks={g.tasks} showDue={false} showProject={config.showProject} />
        </div>
      ))}
      {remaining > 0 && (
        <button type="button" className="mini-more" onClick={() => navigate({ name: "tasks", view: "upcoming" })}>
          +{remaining} more
        </button>
      )}
    </div>
  );
}

export function UpcomingConfigForm({ config, setConfig }: { config: UpcomingConfig; setConfig: (p: Partial<UpcomingConfig>) => void }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
        <span className="muted">Look ahead</span>
        <Segmented
          size="sm"
          value={String(config.days)}
          onChange={(v) => setConfig({ days: Number(v) })}
          options={[3, 7, 14, 30].map((d) => ({ value: String(d), label: `${d}d` }))}
        />
      </div>
      <ToggleRow label="Show project" value={config.showProject} onChange={(v) => setConfig({ showProject: v })} />
      <MaxRow value={config.max} onChange={(max) => setConfig({ max })} />
    </div>
  );
}

// ------------------------------------------------------------- Custom list

export type CustomListConfig = {
  title: string;
  projectIds: string[];
  minPriority: number;
  labelIds: string[];
  due: "any" | "overdue" | "today" | "week" | "next7" | "none";
  sort: TaskOrder;
  max: number;
  showCompleted: boolean;
  showProject: boolean;
};

export function CustomListWidget({ config }: WidgetProps<CustomListConfig>) {
  const today = useToday();
  const query = useMemo(() => {
    const q: Parameters<typeof useTasks>[0] = { topLevelOnly: true, order: config.sort, includeCompleted: config.showCompleted, limit: 200 };
    if (config.projectIds.length) q.projectIds = config.projectIds;
    if (config.minPriority > 0) q.minPriority = config.minPriority;
    if (config.labelIds.length) q.labelIds = config.labelIds;
    if (config.due === "overdue") q.overdueAsOf = today;
    if (config.due === "today") {
      q.dueTo = today;
      q.hasDue = true;
    }
    if (config.due === "week") {
      q.dueTo = addDaysStr(weekStartStr(today), 6);
      q.hasDue = true;
    }
    if (config.due === "next7") {
      q.dueTo = addDaysStr(today, 7);
      q.hasDue = true;
    }
    if (config.due === "none") q.hasDue = false;
    return q;
  }, [config, today]);
  const { data } = useTasks(query);
  if (!data?.length)
    return (
      <EmptyState compact icon={ListFilter}>
        No tasks match this list.
      </EmptyState>
    );
  return <MiniTaskList tasks={data} max={config.max} showProject={config.showProject} onMore={() => navigate({ name: "tasks", view: "list" })} />;
}

export function CustomListConfigForm({ config, setConfig }: { config: CustomListConfig; setConfig: (p: Partial<CustomListConfig>) => void }) {
  const { data: projects } = useProjects();
  const { data: labels } = useLabels();
  return (
    <div className="col" style={{ gap: 10, width: 280 }}>
      <div className="field">
        <span className="field__label">Title</span>
        <input className="input" value={config.title} onChange={(e) => setConfig({ title: e.target.value })} />
      </div>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
        <span className="muted">Project</span>
        <Select
          value={config.projectIds[0] ?? "all"}
          onChange={(v) => setConfig({ projectIds: v === "all" ? [] : [v] })}
          options={[{ value: "all", label: "All projects" }, ...(projects ?? []).map((p) => ({ value: p.id, label: p.name }))]}
        />
      </div>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
        <span className="muted">Priority</span>
        <Select
          value={String(config.minPriority)}
          onChange={(v) => setConfig({ minPriority: Number(v) })}
          options={[
            { value: "0", label: "Any" },
            { value: "2", label: `${PRIORITY_LABELS[2]} or higher` },
            { value: "3", label: `${PRIORITY_LABELS[3]} or higher` },
            { value: "4", label: PRIORITY_LABELS[4] },
          ]}
        />
      </div>
      {!!labels?.length && (
        <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
          <span className="muted">Label</span>
          <Select
            value={config.labelIds[0] ?? "any"}
            onChange={(v) => setConfig({ labelIds: v === "any" ? [] : [v] })}
            options={[{ value: "any", label: "Any" }, ...labels.map((l) => ({ value: l.id, label: l.name }))]}
          />
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
        <span className="muted">Due</span>
        <Select
          value={config.due}
          onChange={(v) => setConfig({ due: v })}
          options={[
            { value: "any", label: "Any time" },
            { value: "overdue", label: "Overdue" },
            { value: "today", label: "By today" },
            { value: "week", label: "This week" },
            { value: "next7", label: "Next 7 days" },
            { value: "none", label: "No date" },
          ]}
        />
      </div>
      <SortRow value={config.sort} onChange={(sort) => setConfig({ sort })} />
      <MaxRow value={config.max} onChange={(max) => setConfig({ max })} />
      <ToggleRow label="Show completed" value={config.showCompleted} onChange={(v) => setConfig({ showCompleted: v })} />
      <ToggleRow label="Show project" value={config.showProject} onChange={(v) => setConfig({ showProject: v })} />
    </div>
  );
}
