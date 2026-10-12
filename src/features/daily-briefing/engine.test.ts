import { describe, expect, it } from "vitest";
import { buildRundown, inDays, scoreTask, summarize } from "./engine";
import type { Project, RundownData, Task } from "@/lib/types";

const today = "2026-10-12";

function task(p: Partial<Task>): Task {
  return {
    id: Math.random().toString(36).slice(2),
    title: "Task",
    description: "",
    status: "todo",
    priority: 0,
    projectId: null,
    columnId: null,
    parentId: null,
    dueDate: null,
    dueTime: null,
    startDate: null,
    estimateMinutes: null,
    trackedSeconds: 0,
    sortOrder: 0,
    boardOrder: 0,
    pinned: false,
    recurrence: null,
    seriesId: null,
    reminderMinutes: null,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
    labelIds: [],
    subtaskCount: 0,
    subtaskDone: 0,
    attachmentCount: 0,
    ...p,
  };
}

function project(p: Partial<Project>): Project {
  return {
    id: "p",
    name: "Project",
    description: "",
    icon: null,
    accent: null,
    targetDate: null,
    groupId: null,
    pinned: false,
    sortOrder: 0,
    defaultView: null,
    hiddenTabs: [],
    defaultBoardId: null,
    lastOpenedAt: null,
    archivedAt: null,
    deletedAt: null,
    createdAt: 0,
    updatedAt: 0,
    taskTotal: 0,
    taskDone: 0,
    taskOverdue: 0,
    taskDueSoon: 0,
    lastActivityAt: Date.now(),
    folderPath: null,
    folderTrust: null,
    aiPrefs: {},
    githubRepo: null,
    ...p,
  };
}

const empty: RundownData = {
  overdue: [],
  today: [],
  upcoming: [],
  highPriority: [],
  inProgress: [],
  pinned: [],
  completedToday: [],
  completedYesterday: [],
  projects: [],
};

const opts = {
  today,
  maxTasks: 6,
  includeOverdue: true,
  includeUpcoming: true,
  includeCompleted: true,
  includeProjects: true,
};

describe("scoreTask", () => {
  it("ranks overdue urgent above due-today low", () => {
    const a = scoreTask(task({ priority: 4, dueDate: "2026-10-10" }), { today });
    const b = scoreTask(task({ priority: 1, dueDate: today }), { today });
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.factors.map((f) => f.label)).toEqual(["Urgent", "2 days overdue"]);
  });

  it("penalises blocked tasks", () => {
    const s = scoreTask(task({ priority: 3, status: "blocked" }), { today });
    expect(s.score).toBeLessThan(0);
  });

  it("caps overdue growth", () => {
    const a = scoreTask(task({ dueDate: "2026-09-01" }), { today });
    const b = scoreTask(task({ dueDate: "2026-10-01" }), { today });
    expect(a.score).toBe(b.score);
  });
});

describe("buildRundown", () => {
  it("handles an empty day", () => {
    const r = buildRundown(empty, opts);
    expect(r.summary).toBe("Nothing is scheduled for today.");
    expect(r.suggestions).toHaveLength(0);
  });

  it("summarises counts, deadlines and yesterday", () => {
    const t1 = task({ dueDate: today, title: "A" });
    const t2 = task({ dueDate: today, title: "B", priority: 3 });
    const o = task({ dueDate: "2026-10-11", title: "Late" });
    const data: RundownData = {
      ...empty,
      today: [t1, t2],
      overdue: [o],
      highPriority: [t2],
      completedYesterday: [task({ status: "completed" }), task({ status: "completed" })],
      projects: [project({ name: "Website", targetDate: "2026-10-14", taskTotal: 5, taskDone: 2 })],
    };
    const r = buildRundown(data, opts);
    expect(r.summary).toBe(
      "Today you have 2 tasks scheduled, 1 overdue, and 1 high-priority item. Website is due in two days. You completed 2 tasks yesterday.",
    );
    // High priority + due today (53) outranks an unprioritised task 1 day overdue (34).
    expect(r.suggestions.map((s) => s.task.title)).toEqual(["B", "Late", "A"]);
    expect(r.high).toHaveLength(0); // already listed under today
  });

  it("excludes skipped and blocked tasks from suggestions, and marks carry-overs", () => {
    const a = task({ dueDate: today, priority: 4 });
    const b = task({ dueDate: today, priority: 3, status: "blocked" });
    const c = task({ dueDate: today });
    const r = buildRundown(
      { ...empty, today: [a, b, c] },
      { ...opts, skipped: new Set([a.id]), carryIds: new Set([c.id]) },
    );
    expect(r.suggestions.map((s) => s.task.id)).toEqual([c.id]);
    expect(r.carryovers.map((t) => t.id)).toEqual([c.id]);
  });

  it("omits disabled sections", () => {
    const data = { ...empty, overdue: [task({ dueDate: "2026-10-01" })], completedYesterday: [task({})] };
    const r = buildRundown(data, { ...opts, includeOverdue: false, includeCompleted: false });
    expect(r.overdue).toHaveLength(0);
    expect(summarize(data, { ...opts, includeOverdue: false, includeCompleted: false })).toBe(
      "Nothing is scheduled for today.",
    );
  });
});

describe("inDays", () => {
  it("phrases relative days", () => {
    expect(inDays(0)).toBe("today");
    expect(inDays(1)).toBe("tomorrow");
    expect(inDays(2)).toBe("in two days");
    expect(inDays(14)).toBe("in 14 days");
  });
});
