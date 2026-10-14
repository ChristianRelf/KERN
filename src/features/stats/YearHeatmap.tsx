// Tasks completed per day as a heatmap (newest week on the right), with
// optional totals and streaks. Used by Settings → About, Account & Cloud and
// the dashboard's Activity Heatmap widget.

import { useMemo, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { addDaysStr, dayStartMs, formatDateAbs, isoWeekday, toDateStr, weekStartStr } from "@/lib/dates";
import { useToday } from "@/hooks/useToday";
import { Tooltip } from "@/components/ui/Tooltip";

/** Completions per local day over the last `weeks` weeks, plus streaks. */
export function useCompletionYear(weeks: number) {
  const today = useToday();
  const start = weekStartStr(addDaysStr(today, -7 * (weeks - 1)));
  const q = useQuery({
    queryKey: ["stats", "heatmap", start, today],
    queryFn: () => api.stats.completions(dayStartMs(start), dayStartMs(addDaysStr(today, 1))),
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const perDay = new Map<string, number>();
    for (const t of q.data ?? []) {
      const d = toDateStr(new Date(t));
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    let total = 0;
    let best: { day: string; n: number } | null = null;
    for (const [day, n] of perDay) {
      total += n;
      if (!best || n > best.n) best = { day, n };
    }
    // Longest run inside the window, and the current run (today may still be empty).
    let longest = 0;
    let run = 0;
    for (let d = start; d <= today; d = addDaysStr(d, 1)) {
      run = perDay.has(d) ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    let current = 0;
    for (let d = perDay.has(today) ? today : addDaysStr(today, -1); perDay.has(d); d = addDaysStr(d, -1)) current++;
    const max = Math.max(1, ...perDay.values());
    return { today, start, weeks, perDay, total, best, longest, current, max, loading: q.isLoading };
  }, [q.data, q.isLoading, start, today, weeks]);
}

const level = (n: number, max: number) => (n ? Math.min(4, Math.ceil((n / max) * 4)) : 0);

export function YearHeatmap({ weeks = 53, stats = true, legend = true, framed = true }: { weeks?: number; stats?: boolean; legend?: boolean; framed?: boolean }) {
  const y = useCompletionYear(weeks);
  const cols = useMemo(() => Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, i) => addDaysStr(y.start, w * 7 + i))), [y.start, weeks]);
  // A month's name sits over the first week that starts in it.
  const months = useMemo(
    () =>
      cols.map((col, i) => {
        const m = new Date(`${col[0]}T12:00`).getMonth();
        const prev = i > 0 ? new Date(`${cols[i - 1][0]}T12:00`).getMonth() : -1;
        return m !== prev && i < cols.length - 2 ? new Date(`${col[0]}T12:00`).toLocaleDateString(undefined, { month: "short" }) : "";
      }),
    [cols],
  );
  const span = weeks >= 52 ? "this year" : `in ${weeks} weeks`;

  return (
    <div className="year-heatmap">
      {stats && (
        <div className="year-stats">
          <Stat value={y.total} label={`completed ${span}`} />
          <Stat value={y.current} label="day streak" accent={y.current > 0} />
          <Stat value={y.longest} label="longest streak" />
          <Stat value={y.best?.n ?? 0} label={y.best ? `best day · ${formatDateAbs(y.best.day, false, "dmy")}` : "best day"} />
        </div>
      )}
      <div className="heatmap" data-framed={framed || undefined} role="img" aria-label={`${y.total} tasks completed ${span}`} style={{ "--weeks": weeks } as CSSProperties}>
        <div className="heatmap__months" aria-hidden>
          {months.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
        <div className="heatmap__grid">
          {cols.map((col, w) => (
            <div key={w} className="heatmap__col">
              {col.map((d) => {
                const n = y.perDay.get(d) ?? 0;
                const future = d > y.today;
                return (
                  <Tooltip key={d} content={future ? formatDateAbs(d, true) : `${n || "No"} task${n === 1 ? "" : "s"} · ${formatDateAbs(d, true)}`}>
                    <i data-l={future ? undefined : level(n, y.max)} data-future={future || undefined} data-today={d === y.today || undefined} style={{ animationDelay: `${w * 9 + (isoWeekday(d) - 1) * 6}ms` }} />
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </div>
        {legend && (
          <div className="heatmap__legend" aria-hidden>
            {!stats && <span className="heatmap__summary">{y.total.toLocaleString()} completed{y.current > 0 ? ` · ${y.current}-day streak` : ""}</span>}
            <span>Less</span>
            {[0, 1, 2, 3, 4].map((l) => (
              <i key={l} data-l={l} />
            ))}
            <span>More</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ value, label, accent }: { value: number; label: string; accent?: boolean }) {
  return (
    <div className="year-stat" data-accent={accent || undefined}>
      <span className="year-stat__value">{value.toLocaleString()}</span>
      <span className="year-stat__label">{label}</span>
    </div>
  );
}
