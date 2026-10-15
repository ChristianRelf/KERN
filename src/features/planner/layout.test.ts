import { describe, expect, it } from "vitest";
import { autoPlan, eventSpan, freeGaps, fromMin, layoutColumns, snap, toMin } from "./layout";
import type { CalEvent } from "@/lib/types";

const ev = (start: string, end: string, allDay = false): CalEvent => ({ feedId: "f", feedName: "Work", color: null, uid: start, start, end, allDay, title: "Meeting", location: null });

describe("planner layout", () => {
  it("converts and snaps times", () => {
    expect(toMin("09:30")).toBe(570);
    expect(fromMin(570)).toBe("09:30");
    expect(fromMin(-5)).toBe("00:00");
    expect(snap(577)).toBe(570);
    expect(snap(583)).toBe(585);
  });

  it("puts overlapping items side by side, per cluster", () => {
    const m = layoutColumns([
      { id: "a", start: 540, end: 600 },
      { id: "b", start: 570, end: 630 },
      { id: "c", start: 600, end: 660 },
      { id: "d", start: 720, end: 780 },
    ]);
    expect(m.get("a")).toEqual({ col: 0, cols: 2 });
    expect(m.get("b")).toEqual({ col: 1, cols: 2 });
    // c starts when a ends, so it reuses a's column.
    expect(m.get("c")).toEqual({ col: 0, cols: 2 });
    expect(m.get("d")).toEqual({ col: 0, cols: 1 });
  });

  it("finds free time and fills it in order", () => {
    const busy = [
      { start: 540, end: 600 },
      { start: 630, end: 660 },
    ];
    expect(freeGaps(busy, 480, 720)).toEqual([
      { start: 480, end: 540 },
      { start: 600, end: 630 },
      { start: 660, end: 720 },
    ]);
    const plan = autoPlan(
      [
        { id: "long", minutes: 60 },
        { id: "short", minutes: 30 },
        { id: "huge", minutes: 600 },
      ],
      busy,
      487,
      720,
    );
    // Starts snap to the quarter hour; "long" doesn't fit before 9:00 any more.
    expect(plan).toEqual([
      { id: "long", start: 660 },
      { id: "short", start: 495 },
    ]);
  });

  it("clips events to the day", () => {
    expect(eventSpan(ev("2030-01-01T23:00", "2030-01-02T01:00"), "2030-01-02")).toEqual({ start: 0, end: 60 });
    expect(eventSpan(ev("2030-01-02T09:00", "2030-01-02T09:00"), "2030-01-02")).toEqual({ start: 540, end: 555 });
    expect(eventSpan(ev("2030-01-02", "2030-01-02", true), "2030-01-02")).toBeNull();
    expect(eventSpan(ev("2030-01-03T09:00", "2030-01-03T10:00"), "2030-01-02")).toBeNull();
  });
});
