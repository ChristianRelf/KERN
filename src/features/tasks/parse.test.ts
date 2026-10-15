/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { describe, expect, it } from "vitest";
import { parseQuickTask } from "./parse";

const today = "2026-10-12"; // a Monday
const projects = [
  { id: "p1", name: "Website Redesign" },
  { id: "p2", name: "Home Server" },
];

describe("parseQuickTask", () => {
  it("keeps plain titles untouched", () => {
    const r = parseQuickTask("Buy milk", { today });
    expect(r.title).toBe("Buy milk");
    expect(r.tokens).toHaveLength(0);
  });

  it("parses relative dates and times", () => {
    const r = parseQuickTask("Call Sam tomorrow at 3pm", { today });
    expect(r.title).toBe("Call Sam");
    expect(r.dueDate).toBe("2026-10-13");
    expect(r.dueTime).toBe("15:00");
  });

  it("parses weekdays to the next occurrence", () => {
    expect(parseQuickTask("Standup friday", { today }).dueDate).toBe("2026-10-16");
    // Same weekday means next week, not today.
    expect(parseQuickTask("Review monday", { today }).dueDate).toBe("2026-10-19");
  });

  it("time alone implies today", () => {
    const r = parseQuickTask("Dentist 9:30am", { today });
    expect(r.dueDate).toBe(today);
    expect(r.dueTime).toBe("09:30");
  });

  it("ignores bare numbers", () => {
    const r = parseQuickTask("Buy 3 apples", { today });
    expect(r.title).toBe("Buy 3 apples");
    expect(r.dueTime).toBeUndefined();
  });

  it("matches projects by prefix and labels", () => {
    const r = parseQuickTask("Fix nav #website @frontend p1", { today, projects });
    expect(r.projectId).toBe("p1");
    expect(r.labelNames).toEqual(["frontend"]);
    expect(r.priority).toBe(4);
    expect(r.title).toBe("Fix nav");
  });

  it("leaves unknown hashtags in the title", () => {
    const r = parseQuickTask("Read #rust book", { today, projects });
    expect(r.title).toBe("Read #rust book");
  });

  it("parses recurrence", () => {
    const r = parseQuickTask("Water plants every 3 days", { today });
    expect(r.recurrence).toEqual({ freq: "daily", interval: 3 });
    expect(r.dueDate).toBe(today);
    const w = parseQuickTask("Team sync every thursday", { today });
    expect(w.recurrence).toEqual({ freq: "weekly", interval: 1, weekdays: [4] });
    expect(w.dueDate).toBe("2026-10-15");
  });

  it("handles in N days / next week", () => {
    expect(parseQuickTask("Renew in 3 days", { today }).dueDate).toBe("2026-10-15");
    expect(parseQuickTask("Plan next week", { today }).dueDate).toBe("2026-10-19");
  });
});
