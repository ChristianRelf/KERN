import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { api } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { addDaysStr, dayBounds } from "@/lib/dates";
import { useToday } from "@/hooks/useToday";
import { useSettings } from "@/stores/settings";
import { buildRundown, plannedIds, toMorningSnapshot, type MorningSnapshot, type Rundown } from "./engine";

/** Live rundown for today plus snapshot bookkeeping (carry-over, skips). */
export function useRundown(opts: { horizonDays?: number } = {}) {
  const today = useToday();
  const v = useSettings((s) => s.values);
  const horizon = opts.horizonDays ?? v["rundown.upcomingDays"];
  const projectIds = v["rundown.projectIds"];
  const yesterday = addDaysStr(today, -1);

  const data = useQuery({
    queryKey: ["rundown", today, horizon, projectIds],
    queryFn: () => {
      const b = dayBounds(today);
      return api.daily.data({
        today,
        horizonEnd: addDaysStr(today, horizon),
        dayStart: b.dayStart,
        yesterdayStart: b.yesterdayStart,
        tomorrowStart: b.tomorrowStart,
        projectIds,
      });
    },
  });
  const prev = useQuery({
    queryKey: ["snapshots", yesterday, "morning"],
    queryFn: () => api.daily.getSnapshot<MorningSnapshot>(yesterday, "morning"),
    staleTime: Infinity,
  });
  const snap = useQuery({
    queryKey: ["snapshots", today, "morning"],
    queryFn: () => api.daily.getSnapshot<MorningSnapshot>(today, "morning"),
  });

  const skipped = useMemo(() => new Set(snap.data?.data.skipped ?? []), [snap.data]);
  const rundown: Rundown | null = useMemo(() => {
    if (!data.data) return null;
    return buildRundown(data.data, {
      today,
      maxTasks: v["rundown.maxTasks"],
      includeOverdue: v["rundown.includeOverdue"],
      includeUpcoming: v["rundown.includeUpcoming"],
      includeCompleted: v["rundown.includeCompleted"],
      includeProjects: v["rundown.includeProjects"],
      carryIds: plannedIds(prev.data?.data),
      skipped,
    });
  }, [data.data, today, v, prev.data, skipped]);

  // Persist the first rundown of the day as its historical snapshot.
  const saving = useRef<string | null>(null);
  useEffect(() => {
    if (!rundown || !snap.isFetched || snap.data || saving.current === today) return;
    saving.current = today;
    void api.daily
      .saveSnapshot(today, "morning", toMorningSnapshot(rundown))
      .then(() => invalidate("snapshots"))
      .catch(() => (saving.current = null));
  }, [rundown, snap.isFetched, snap.data, today]);

  const setSkipped = async (id: string, skip: boolean) => {
    const current = snap.data?.data ?? (rundown ? toMorningSnapshot(rundown) : null);
    if (!current) return;
    const set = new Set(current.skipped);
    if (skip) set.add(id);
    else set.delete(id);
    await api.daily.saveSnapshot(today, "morning", { ...current, skipped: [...set] }, true);
    invalidate("snapshots");
  };

  const markViewed = () => void api.daily.markViewed(today, "morning").then(() => invalidate("snapshots"));

  return { rundown, isLoading: data.isLoading, snapshot: snap.data, setSkipped, markViewed, today };
}
