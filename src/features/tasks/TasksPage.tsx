/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { CalendarClock, CalendarDays, Columns3, List, ListFilter, Plus, Save, SquareCheckBig, Sun, CalendarRange } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Milestone, Task, TaskFilters } from "@/lib/types";
import { useLabelMap, useProjectMap, useTasks, useViews } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { navigate, useRouter, type TasksView } from "@/stores/router";
import { useSetting } from "@/stores/settings";
import { IconButton, Button } from "@/components/ui/Button";
import { EmptyState, Segmented } from "@/components/ui/Controls";
import { prompt } from "@/components/ui/Dialog";
import { TaskList, type TaskSection } from "./TaskList";
import { FilterBar } from "./FilterBar";
import { activeFilterCount, filtersToQuery, groupSections, upcomingSections } from "./grouping";
import { defaultTaskPlacement } from "./actions";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { addDaysStr } from "@/lib/dates";
import { resolveBindings } from "@/lib/shortcuts";
import { openNewTask } from "./creation";

const CalendarView = lazy(() => import("./CalendarView"));
const PlannerView = lazy(() => import("@/features/planner/PlannerView"));
const StatusBoard = lazy(() => import("@/features/boards/StatusBoard"));

const VIEWS: { value: TasksView; label: string; icon: typeof List }[] = [
  { value: "list", label: "List", icon: List },
  { value: "today", label: "Today", icon: Sun },
  { value: "plan", label: "Plan", icon: CalendarClock },
  { value: "upcoming", label: "Upcoming", icon: CalendarRange },
  { value: "calendar", label: "Calendar", icon: CalendarDays },
  { value: "board", label: "Board", icon: Columns3 },
];

export function TasksPage({ viewId }: { viewId?: string }) {
  const route = useRouter((s) => s.route);
  const defaultView = useSetting("tasks.defaultView");
  const defaultSort = useSetting("tasks.defaultSort");
  const showCompletedDefault = useSetting("tasks.showCompleted");
  const shortcuts = resolveBindings(useSetting("keyboard.shortcuts"));
  const { data: views } = useViews();
  const saved = viewId ? views?.find((v) => v.id === viewId) : undefined;
  const view: TasksView = viewId ? "list" : route.name === "tasks" ? (route.view ?? defaultView) : "list";

  const initial: TaskFilters = useMemo(
    () => saved?.filters ?? { sort: defaultSort, group: "none", showCompleted: showCompletedDefault },
    [saved, defaultSort, showCompletedDefault],
  );
  const [filters, setFilters] = useState<TaskFilters>(initial);
  useEffect(() => setFilters(initial), [initial]);

  const dirty = saved && JSON.stringify(saved.filters) !== JSON.stringify(filters);

  const saveView = async () => {
    try {
      if (saved) {
        await api.views.update(saved.id, { filters });
        toast("View updated");
      } else {
        const name = await prompt({ title: "Save view", placeholder: "View name", confirmLabel: "Save" });
        if (!name) return;
        const v = await api.views.create(name, filters);
        navigate({ name: "view", id: v.id });
        toast("View saved to the sidebar");
      }
      invalidate("views");
    } catch (e) {
      toastError(describeError(e));
    }
  };

  const setView = (v: TasksView) => navigate({ name: "tasks", view: v }, { replace: true });

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          {saved ? <ListFilter /> : <SquareCheckBig />}
          {saved?.name ?? "My Tasks"}
        </h1>
        {!saved && (
          <div style={{ marginLeft: 8 }}>
            <Segmented
              size="sm"
              value={view}
              onChange={setView}
              ariaLabel="Task view"
              options={VIEWS.map((v) => ({ value: v.value, icon: v.icon, tooltip: v.label, label: v.label }))}
            />
          </div>
        )}
        <div className="page-header__actions">
          {(view === "list" && (activeFilterCount(filters) > 0 || dirty)) && (
            <Button size="sm" variant="ghost" icon={Save} onClick={() => void saveView()}>
              {saved ? "Update view" : "Save view"}
            </Button>
          )}
          <IconButton icon={Plus} label="New task" shortcut={shortcuts.newTask} onClick={() => openNewTask()} />
        </div>
      </header>
      {view === "list" && <FilterBar filters={filters} onChange={setFilters} />}
      {view === "list" && <ListView filters={filters} />}
      {view === "today" && <TodayView />}
      {view === "upcoming" && <UpcomingView />}
      {(view === "calendar" || view === "board" || view === "plan") && (
        <Suspense fallback={<div className="page-loading" />}>
          {view === "calendar" ? <CalendarView /> : view === "plan" ? <PlannerView /> : <StatusBoard />}
        </Suspense>
      )}
    </div>
  );
}

/** Milestones of the projects these tasks belong to, by id (only when grouping by milestone). */
function useMilestoneMap(tasks: Task[] | undefined, enabled: boolean): Map<string, Milestone> {
  const projectIds = useMemo(
    () => (enabled ? [...new Set((tasks ?? []).filter((t) => t.milestoneId && t.projectId).map((t) => t.projectId!))].sort() : []),
    [tasks, enabled],
  );
  return useQueries({
    queries: projectIds.map((id) => ({ queryKey: ["milestones", id], queryFn: () => api.milestones.list(id), staleTime: 30_000 })),
    combine: combineMilestones,
  });
}

// Module-level so useQueries can keep the result stable between renders.
function combineMilestones(results: { data?: Milestone[] }[]): Map<string, Milestone> {
  return new Map(results.flatMap((r) => r.data ?? []).map((m) => [m.id, m]));
}

function ListView({ filters }: { filters: TaskFilters }) {
  const today = useToday();
  const projects = useProjectMap();
  const labels = useLabelMap();
  const { data: tasks, isLoading } = useTasks(filtersToQuery(filters, today));
  const milestones = useMilestoneMap(tasks, filters.group === "milestone" || filters.subGroup === "milestone");
  const sections = useMemo<TaskSection[]>(() => {
    const groups = groupSections(tasks ?? [], filters.group ?? "none", filters.subGroup, { today, projects, labels, milestones });
    // A single add row at the top creates tasks with the user's defaults
    // (or the filtered project, when filtering by exactly one project).
    const defaults =
      filters.projectIds?.length === 1 && !filters.noProject
        ? { projectId: filters.projectIds[0], status: "todo" as const }
        : defaultTaskPlacement();
    if (groups.length === 1 && groups[0].key === "all") return [{ ...groups[0], addDefaults: defaults }];
    return [{ key: "add", tasks: [], addDefaults: defaults, collapsible: false }, ...groups];
  }, [tasks, filters, today, projects, labels, milestones]);
  if (isLoading && !tasks) return <div className="page-loading" />;
  const manual = (filters.sort ?? "manual") === "manual" && (filters.group ?? "none") === "none";
  return (
    <TaskList
      sections={sections}
      sortable={manual}
      quickAddPosition="top"
      meta={filters.display}
      empty={
        <EmptyState icon={SquareCheckBig} title={activeFilterCount(filters) ? "No tasks match these filters" : "No tasks yet"}>
          {activeFilterCount(filters) ? "Try clearing a filter." : "Type above and press Enter to add one."}
        </EmptyState>
      }
    />
  );
}

function TodayView() {
  const today = useToday();
  const overdue = useTasks({ overdueAsOf: today, topLevelOnly: true, order: "due" });
  const todays = useTasks({ dueFrom: today, dueTo: today, topLevelOnly: true, order: "manual" });
  const done = useTasks({ dueFrom: today, dueTo: today, topLevelOnly: true, statuses: ["completed"], order: "completed" });
  const sections: TaskSection[] = [];
  if (overdue.data?.length) sections.push({ key: "overdue", title: "Overdue", tasks: overdue.data });
  sections.push({
    key: "today",
    title: overdue.data?.length ? "Today" : undefined,
    tasks: todays.data ?? [],
    addDefaults: { dueDate: today, status: "todo" },
  });
  if (done.data?.length) sections.push({ key: "done", title: "Completed today", tasks: done.data });
  const empty = !overdue.data?.length && !todays.data?.length;
  return (
    <TaskList
      sections={sections}
      sortable={!overdue.data?.length}
      quickAddPosition="bottom"
      empty={
        empty && !done.data?.length ? (
          <EmptyState icon={Sun} title="Nothing due today">
            Add something above, or plan ahead in Upcoming.
          </EmptyState>
        ) : undefined
      }
    />
  );
}

function UpcomingView() {
  const today = useToday();
  const { data: tasks } = useTasks({ hasDue: true, dueTo: addDaysStr(today, 120), topLevelOnly: true, order: "due" });
  const sections = useMemo(
    () =>
      upcomingSections(tasks ?? [], today, 14).map((s) =>
        /^\d{4}-/.test(s.key)
          ? {
              ...s,
              actions: (
                <IconButton
                  icon={Plus}
                  label="Add task on this day"
                  size="sm"
                  onClick={() => openNewTask({ dueDate: s.key })}
                />
              ),
            }
          : s,
      ),
    [tasks, today],
  );
  return <TaskList sections={sections} quickAddPosition="bottom" />;
}
