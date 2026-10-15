/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

import { Flame, Repeat2 } from "lucide-react";
import type { WidgetProps } from "@/features/dashboard/types";
import { EmptyState } from "@/components/ui/Controls";
import { Button } from "@/components/ui/Button";
import { navigate } from "@/stores/router";
import { HabitCheck, HabitGlyph } from "./parts";
import { useHabits } from "./data";
import "./habits.css";

/** Today's habits with one-click check-off. */
export function HabitsWidget(_: WidgetProps) {
  const { data } = useHabits(14);
  const list = (data ?? []).filter((h) => h.dueToday || h.cadence === "weekly");
  if (!data) return null;
  if (!list.length)
    return (
      <EmptyState compact icon={Repeat2} action={<Button size="sm" onClick={() => navigate({ name: "habits" })}>Add a habit</Button>}>
        {data.length ? "Nothing due today." : "Track things you want to do regularly."}
      </EmptyState>
    );
  return (
    <div className="habits-widget">
      {list.map((h) => (
        <div key={h.id} className="habits-widget__row">
          <HabitCheck h={h} size={24} />
          <HabitGlyph h={h} />
          <button type="button" className="truncate grow" style={{ textAlign: "left" }} onClick={() => navigate({ name: "habits" })}>
            {h.name}
            {h.cadence === "weekly" && <span className="faint"> · {h.progress}/{h.target} this week</span>}
          </button>
          {h.streak > 1 && (
            <span className="faint tabular" style={{ fontSize: "var(--fs-xs)", display: "inline-flex", gap: 2, alignItems: "center" }} title="Streak">
              <Flame size={12} /> {h.streak}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
