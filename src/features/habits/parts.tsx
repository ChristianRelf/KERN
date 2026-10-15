// Small habit controls shared by the Habits page and the dashboard widget.

import type { Habit } from "@/lib/types";
import { todayStr } from "@/lib/dates";
import { iconEmoji } from "@/features/projects/ProjectGlyph";
import { checkHabit } from "./data";

/** The big "done today" control: a ring that fills with progress. */
export function HabitCheck({ h, size = 30 }: { h: Habit; size?: number }) {
  const today = todayStr();
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const share = Math.min(1, h.progress / h.target);
  const color = h.color ?? "var(--accent)";
  const off = !h.dueToday && h.cadence === "daily";
  return (
    <button
      type="button"
      className="habit-check"
      data-done={h.done || undefined}
      data-off={off || undefined}
      style={{ width: size, height: size, ["--habit" as string]: color }}
      aria-label={h.done ? `${h.name}: done${h.target > 1 ? `, ${h.progress} of ${h.target}` : ""}. Click to add, right-click to undo` : `Mark ${h.name} done`}
      title={off ? "Not due today (you can still check it off)" : h.target > 1 ? `${h.progress} of ${h.target}` : undefined}
      onClick={() => void checkHabit(h, today, 1)}
      onContextMenu={(e) => {
        e.preventDefault();
        if ((h.checks[today] ?? 0) > 0) void checkHabit(h, today, -1);
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} className="habit-check__track" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} stroke={color} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - share)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="habit-check__mark">{h.done ? "✓" : h.target > 1 ? `${h.progress}` : ""}</span>
    </button>
  );
}

export function HabitGlyph({ h }: { h: Pick<Habit, "icon" | "name" | "color"> }) {
  const e = iconEmoji(h.icon);
  return (
    <span className="habit-glyph" style={{ ["--habit" as string]: h.color ?? "var(--accent)" }} aria-hidden>
      {e ?? h.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
