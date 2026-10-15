/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

import { describe, expect, it } from "vitest";
import type { Label, Task } from "@/lib/types";
import { groupSections, groupTasks } from "./grouping";
import { nextLabelColor } from "./labels";

const today = "2026-10-14";
const task = (id: string, p: Partial<Task> = {}) => ({ id, title: id, status: "todo", priority: 0, labelIds: [], ...p }) as Task;
const label = (id: string, name: string, color: string | null = null): Label => ({ id, name, color, taskCount: 0 });

describe("groupTasks", () => {
  it("puts a task under each of its labels, with the label's colour", () => {
    const labels = new Map([
      ["l1", label("l1", "Bug", "red")],
      ["l2", label("l2", "UI", "#123456")],
    ]);
    const s = groupTasks([task("a", { labelIds: ["l1", "l2"] }), task("b")], "label", { today, projects: new Map(), labels });
    expect(s.map((g) => [g.title, g.tasks.map((t) => t.id), g.color])).toEqual([
      ["Bug", ["a"], "#e08a80"],
      ["UI", ["a"], "#123456"],
      ["No label", ["b"], undefined],
    ]);
  });
});

describe("groupSections", () => {
  it("nests sub-groups under a header that counts them", () => {
    const tasks = [task("a", { priority: 3 }), task("b", { priority: 3, status: "in_progress" }), task("c", { priority: 1 })];
    const s = groupSections(tasks, "priority", "status", { today, projects: new Map() });
    expect(s.map((g) => [g.key, g.level ?? 0, g.count ?? g.tasks.length])).toEqual([
      ["3", 0, 2],
      ["3/todo", 1, 1],
      ["3/in_progress", 1, 1],
      ["1", 0, 1],
      ["1/todo", 1, 1],
    ]);
    expect(s[1].parentKey).toBe("3");
  });

  it("ignores a sub-grouping equal to the grouping", () => {
    expect(groupSections([task("a")], "status", "status", { today, projects: new Map() })).toHaveLength(1);
  });
});

describe("nextLabelColor", () => {
  it("picks the least used preset", () => {
    expect(nextLabelColor([])).toBe("blue");
    expect(nextLabelColor([{ color: "blue" }])).not.toBe("blue");
  });
});
