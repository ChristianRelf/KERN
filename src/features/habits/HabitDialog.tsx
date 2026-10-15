/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

import { useEffect, useState } from "react";
import type { Habit, HabitInput } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { todayStr } from "@/lib/dates";
import { toastError } from "@/stores/toast";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Controls";
import { PROJECT_COLORS } from "@/features/projects/ProjectGlyph";

const DAYS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const EMOJI = ["💧", "🏃", "📚", "🧘", "🥗", "💤", "✍️", "🎸", "🧹", "💊", "🌱", "🙏"];

/** Create (habit = null) or edit a habit. */
export function HabitDialog({ open, habit, onClose }: { open: boolean; habit: Habit | null; onClose: () => void }) {
  const [draft, setDraft] = useState<Required<HabitInput>>({ name: "", icon: null, color: null, cadence: "daily", target: 1, weekdays: [1, 2, 3, 4, 5, 6, 7] });
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDraft(
      habit
        ? { name: habit.name, icon: habit.icon, color: habit.color, cadence: habit.cadence, target: habit.target, weekdays: habit.weekdays }
        : { name: "", icon: null, color: null, cadence: "daily", target: 1, weekdays: [1, 2, 3, 4, 5, 6, 7] },
    );
  }, [open, habit]);
  const set = (p: Partial<HabitInput>) => setDraft((d) => ({ ...d, ...p }) as Required<HabitInput>);

  const save = async () => {
    if (!draft.name.trim()) return;
    setSaving(true);
    try {
      if (habit) await api.habits.update(habit.id, draft, todayStr());
      else await api.habits.create(draft, todayStr());
      invalidate("habits", "review");
      onClose();
    } catch (e) {
      toastError(describeError(e, "Couldn't save the habit."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={habit ? "Edit habit" : "New habit"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!draft.name.trim() || saving} onClick={() => void save()}>
            {habit ? "Save" : "Create habit"}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <label className="field">
          <span className="field__label">Habit</span>
          <input
            className="input"
            autoFocus
            placeholder="e.g. Drink water, Read 20 pages, Stretch"
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && void save()}
          />
        </label>
        <div className="field">
          <span className="field__label">Icon</span>
          <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
            <button type="button" className="habit-emoji" data-active={!draft.icon || undefined} onClick={() => set({ icon: null })} aria-label="No icon">
              ·
            </button>
            {EMOJI.map((e) => (
              <button key={e} type="button" className="habit-emoji" data-active={draft.icon === `emoji:${e}` || undefined} onClick={() => set({ icon: `emoji:${e}` })} aria-label={e}>
                {e}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field__label">Colour</span>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <button type="button" className="swatch" data-active={!draft.color || undefined} style={{ background: "var(--accent)", width: 20, height: 20 }} onClick={() => set({ color: null })} aria-label="Default" />
            {Object.entries(PROJECT_COLORS).map(([id, c]) => (
              <button key={id} type="button" className="swatch" data-active={draft.color === c || undefined} style={{ background: c, width: 20, height: 20 }} onClick={() => set({ color: c })} aria-label={id} />
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field__label">How often</span>
          <Segmented
            size="sm"
            value={draft.cadence}
            onChange={(v) => set({ cadence: v, target: v === "weekly" ? Math.max(draft.target, 3) : 1 })}
            options={[
              { value: "daily", label: "On certain days" },
              { value: "weekly", label: "Times a week" },
            ]}
          />
        </div>
        {draft.cadence === "daily" ? (
          <div className="field">
            <span className="field__label">Days</span>
            <div className="row" style={{ gap: 4 }}>
              {DAYS.map((d, i) => {
                const n = i + 1;
                const on = draft.weekdays.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    className="habit-day-toggle"
                    data-active={on || undefined}
                    aria-pressed={on}
                    aria-label={DAY_NAMES[i]}
                    title={DAY_NAMES[i]}
                    onClick={() => set({ weekdays: on ? draft.weekdays.filter((x) => x !== n) : [...draft.weekdays, n].sort() })}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <label className="field">
          <span className="field__label">{draft.cadence === "weekly" ? "Times each week" : "Times each day"}</span>
          <input className="input" type="number" min={1} max={50} style={{ width: 90 }} value={draft.target} onChange={(e) => set({ target: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} />
        </label>
      </div>
    </Dialog>
  );
}
