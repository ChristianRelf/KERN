/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

import { Archive, ArchiveRestore, Ellipsis, Flame, Pencil, Plus, Repeat2, Trash, Trophy } from "lucide-react";
import { useMemo, useState } from "react";
import { format } from "date-fns";
import type { Habit } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { addDaysStr, isoWeekday, parseDateStr, todayStr } from "@/lib/dates";
import { useToday } from "@/hooks/useToday";
import { toastError } from "@/stores/toast";
import { pushUndo } from "@/stores/undo";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { Dropdown } from "@/components/ui/Menu";
import { confirmDelete } from "@/components/ui/Dialog";
import { HabitDialog } from "./HabitDialog";
import { HabitCheck, HabitGlyph } from "./parts";
import { cadenceLabel, checkHabit, useHabits } from "./data";
import "./habits.css";

const STRIP_DAYS = 14;

function DayStrip({ h, today }: { h: Habit; today: string }) {
  const days = Array.from({ length: STRIP_DAYS }, (_, i) => addDaysStr(today, i - STRIP_DAYS + 1));
  return (
    <div className="habit-strip" role="group" aria-label={`${h.name}, last ${STRIP_DAYS} days`}>
      {days.map((d) => {
        const n = h.checks[d] ?? 0;
        const due = h.cadence === "weekly" || h.weekdays.includes(isoWeekday(d));
        const met = n >= h.target;
        return (
          <button
            key={d}
            type="button"
            className="habit-day"
            data-state={met ? "met" : n > 0 ? "part" : due ? (d < today ? "missed" : "due") : "off"}
            data-today={d === today || undefined}
            style={{ ["--habit" as string]: h.color ?? "var(--accent)" }}
            title={`${format(parseDateStr(d), "EEE d MMM")}${n ? ` · ${n}×` : due ? "" : " · not due"}`}
            aria-label={`${format(parseDateStr(d), "EEEE d MMMM")}: ${n ? `done ${n} time${n === 1 ? "" : "s"}` : "not done"}`}
            onClick={() => void checkHabit(h, d, met && h.target === 1 ? -1 : 1)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (n > 0) void checkHabit(h, d, -1);
            }}
          >
            <span>{format(parseDateStr(d), "EEEEE")}</span>
          </button>
        );
      })}
    </div>
  );
}

async function archive(h: Habit, archived: boolean) {
  try {
    await api.habits.update(h.id, { archived }, todayStr());
    invalidate("habits", "review");
    pushUndo(archived ? `Archived ${h.name}` : `Restored ${h.name}`, async () => {
      await api.habits.update(h.id, { archived: !archived }, todayStr());
      invalidate("habits", "review");
    });
  } catch (e) {
    toastError(describeError(e));
  }
}

async function remove(h: Habit) {
  if (!(await confirmDelete(`Delete “${h.name}”?`, "Its history is deleted too. Archive it instead to keep the history."))) return;
  try {
    await api.habits.delete(h.id);
    invalidate("habits", "review");
  } catch (e) {
    toastError(describeError(e));
  }
}

function HabitRow({ h, today, onEdit }: { h: Habit; today: string; onEdit: () => void }) {
  return (
    <div className="habit-row" data-archived={!!h.archivedAt || undefined}>
      {!h.archivedAt && <HabitCheck h={h} />}
      <HabitGlyph h={h} />
      <div className="habit-row__main">
        <span className="habit-row__name">{h.name}</span>
        <span className="habit-row__meta">
          {cadenceLabel(h)}
          {h.streak > 0 && (
            <span className="habit-row__streak" title="Current streak">
              <Flame size={12} /> {h.streak} {h.cadence === "weekly" ? (h.streak === 1 ? "week" : "weeks") : h.streak === 1 ? "day" : "days"}
            </span>
          )}
          {h.bestStreak > 1 && (
            <span title="Best streak">
              <Trophy size={11} style={{ verticalAlign: -1 }} /> {h.bestStreak}
            </span>
          )}
          <span title="Met in the last 30 days">{Math.round(h.rate * 100)}%</span>
        </span>
      </div>
      <DayStrip h={h} today={today} />
      <Dropdown
        align="end"
        items={[
          { label: "Edit…", icon: Pencil, onSelect: onEdit },
          h.archivedAt ? { label: "Restore", icon: ArchiveRestore, onSelect: () => void archive(h, false) } : { label: "Archive", icon: Archive, onSelect: () => void archive(h, true) },
          { type: "separator" },
          { label: "Delete", icon: Trash, danger: true, onSelect: () => void remove(h) },
        ]}
      >
        <IconButton icon={Ellipsis} label="Habit actions" size="sm" noTooltip />
      </Dropdown>
    </div>
  );
}

export default function HabitsPage() {
  const today = useToday();
  const [showArchived, setShowArchived] = useState(false);
  const { data, isLoading } = useHabits(35, showArchived);
  const [editing, setEditing] = useState<Habit | null | "new">(null);
  const active = useMemo(() => (data ?? []).filter((h) => !h.archivedAt), [data]);
  const archived = useMemo(() => (data ?? []).filter((h) => h.archivedAt), [data]);
  const dueToday = active.filter((h) => h.dueToday);
  const doneToday = dueToday.filter((h) => h.done).length;

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <Repeat2 /> Habits
        </h1>
        {dueToday.length > 0 && (
          <span className="page-header__sub">
            {doneToday} of {dueToday.length} done today
          </span>
        )}
        <div className="page-header__actions">
          <Button size="sm" variant="ghost" icon={Archive} onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "Hide archived" : "Archived"}
          </Button>
          <Button size="sm" icon={Plus} onClick={() => setEditing("new")}>
            New habit
          </Button>
        </div>
      </header>
      <div className="page-body page-body--pad">
        <div className="page-body--readable col" style={{ gap: 4 }}>
          {isLoading && <Skeleton height={56} />}
          {!isLoading && !active.length && (
            <EmptyState icon={Repeat2} title="Build a habit" action={<Button icon={Plus} onClick={() => setEditing("new")}>New habit</Button>}>
              Track things you want to do regularly, every day or a few times a week. Tick them off here, on the dashboard or in your weekly review.
            </EmptyState>
          )}
          {active.map((h) => (
            <HabitRow key={h.id} h={h} today={today} onEdit={() => setEditing(h)} />
          ))}
          {showArchived && archived.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: 20 }}>
                Archived <span className="count">{archived.length}</span>
              </div>
              {archived.map((h) => (
                <HabitRow key={h.id} h={h} today={today} onEdit={() => setEditing(h)} />
              ))}
            </>
          )}
          {active.length > 0 && <p className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 12 }}>Click a day to check it off; right-click to take a check back.</p>}
        </div>
      </div>
      <HabitDialog open={editing !== null} habit={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
    </div>
  );
}
