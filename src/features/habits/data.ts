// Habits: queries and the check-off action (optimistic, with undo).

import { useQuery } from "@tanstack/react-query";
import type { Habit } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { useToday } from "@/hooks/useToday";
import { pushUndo } from "@/stores/undo";
import { toastError } from "@/stores/toast";
import { todayStr } from "@/lib/dates";

export function useHabits(days = 35, includeArchived = false) {
  const today = useToday();
  return useQuery({ queryKey: ["habits", today, days, includeArchived], queryFn: () => api.habits.list(today, days, includeArchived), staleTime: 30_000 });
}

/** "Every day", "Weekdays", "Mon, Wed, Fri", "3× a week". */
export function cadenceLabel(h: Pick<Habit, "cadence" | "target" | "weekdays">): string {
  const times = h.target > 1 ? `${h.target}× ` : "";
  if (h.cadence === "weekly") return `${h.target}× a week`;
  const d = [...h.weekdays].sort();
  if (d.length === 7) return `${times}every day`.replace(/^./, (c) => c.toUpperCase());
  if (d.join() === "1,2,3,4,5") return `${times}weekdays`.replace(/^./, (c) => c.toUpperCase());
  if (d.join() === "6,7") return `${times}weekends`.replace(/^./, (c) => c.toUpperCase());
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return `${times}${d.map((x) => names[x - 1]).join(", ")}`;
}

/** Adds (or removes) one check on a day, optimistically. */
export async function checkHabit(h: Habit, day: string, delta: 1 | -1) {
  const today = todayStr();
  const before = queryClient.getQueriesData<Habit[]>({ queryKey: ["habits"] });
  for (const [key, list] of before) {
    if (!Array.isArray(list)) continue;
    queryClient.setQueryData<Habit[]>(
      key,
      list.map((x) => {
        if (x.id !== h.id) return x;
        const n = Math.max(0, (x.checks[day] ?? 0) + delta);
        const checks = { ...x.checks };
        if (n) checks[day] = n;
        else delete checks[day];
        const progress = day === today || x.cadence === "weekly" ? Math.max(0, x.progress + delta) : x.progress;
        return { ...x, checks, progress, done: progress >= x.target };
      }),
    );
  }
  try {
    await api.habits.check(h.id, day, delta, today);
    invalidate("habits", "review");
    if (delta > 0 && day === today) {
      pushUndo(
        `${h.name} done`,
        async () => {
          await api.habits.check(h.id, day, -1, todayStr());
          invalidate("habits", "review");
        },
        { silent: true },
      );
    }
  } catch (e) {
    for (const [key, list] of before) queryClient.setQueryData(key, list);
    toastError(describeError(e, "Couldn't update the habit."));
  }
}
