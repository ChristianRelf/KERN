/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { WidgetProps } from "../types";
import { api } from "@/lib/ipc";
import { useOverview, useTasks } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import {
  addDaysStr,
  addMonthsStr,
  dayStartMs,
  monthGrid,
  monthStartStr,
  parseDateStr,
  toDateStr,
  weekStartStr,
  weekdayLabels,
  formatDuration,
  formatDayHeading,
} from "@/lib/dates";
import { IconButton } from "@/components/ui/Button";
import { MiniTaskList } from "../MiniTaskList";
import { Segmented } from "@/components/ui/Controls";
import { useUi } from "@/stores/ui";

/** Completion counts per local day for [from, from+days). */
function useCompletionsByDay(from: string, days: number) {
  return useQuery({
    queryKey: ["stats", "completions", from, days],
    queryFn: async () => {
      const ts = await api.stats.completions(dayStartMs(from), dayStartMs(addDaysStr(from, days)));
      const counts = new Map<string, number>();
      for (const t of ts) {
        const d = toDateStr(new Date(t));
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
      return Array.from({ length: days }, (_, i) => {
        const d = addDaysStr(from, i);
        return { day: d, count: counts.get(d) ?? 0 };
      });
    },
  });
}

function Bars({ data, today, labelFmt = "EEEEE", height = "100%" }: { data: { day: string; count: number }[]; today: string; labelFmt?: string; height?: number | string }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="bars" style={{ height }} role="img" aria-label={data.map((d) => `${d.day}: ${d.count}`).join(", ")}>
      {data.map((d) => (
        <div key={d.day} className="bars__col" data-today={d.day === today || undefined} title={`${formatDayHeading(d.day, today)} - ${d.count} completed`}>
          <span className="bars__value">{d.count || ""}</span>
          <div className="bars__bar" style={{ height: `${(d.count / max) * 70}%` }} />
          <span className="bars__label">{format(parseDateStr(d.day), labelFmt)}</span>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- Progress

export type ProgressConfig = { trendDays: number };

export function ProgressWidget({ config, size }: WidgetProps<ProgressConfig>) {
  const today = useToday();
  const { data: o } = useOverview();
  const { data: trend } = useCompletionsByDay(addDaysStr(today, -(config.trendDays - 1)), config.trendDays);
  const total = trend?.reduce((n, d) => n + d.count, 0) ?? 0;
  return (
    <div className="col" style={{ gap: 12, height: "100%" }}>
      <div className="rundown-stats" style={{ margin: 0 }}>
        <Stat value={o?.completedToday} label="Done today" />
        <Stat value={o?.completedWeek} label="This week" />
        <Stat value={o?.openTasks} label="Remaining" />
        <Stat value={o?.activeProjects} label="Active projects" />
      </div>
      {size.h >= 5 && trend && (
        <div className="col" style={{ flex: 1, minHeight: 60, gap: 4 }}>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {total} completed in the last {config.trendDays} days
          </span>
          <Bars data={trend} today={today} labelFmt={config.trendDays > 7 ? "d" : "EEEEE"} />
        </div>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number | undefined; label: string }) {
  return (
    <div className="stat">
      <span className="stat__value">{value ?? "–"}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

export function ProgressConfigForm({ config, setConfig }: { config: ProgressConfig; setConfig: (p: Partial<ProgressConfig>) => void }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)", gap: 12 }}>
      <span className="muted">Trend</span>
      <Segmented
        size="sm"
        value={String(config.trendDays)}
        onChange={(v) => setConfig({ trendDays: Number(v) })}
        options={[7, 14, 30].map((d) => ({ value: String(d), label: `${d} days` }))}
      />
    </div>
  );
}

// ------------------------------------------------------------- Weekly activity

export function WeeklyActivityWidget(_: WidgetProps) {
  const today = useToday();
  const start = weekStartStr(today);
  const { data } = useCompletionsByDay(start, 7);
  const { data: focus } = useQuery({
    queryKey: ["focus", "week", start],
    queryFn: () => api.focus.list(dayStartMs(start), dayStartMs(addDaysStr(start, 7))),
  });
  const focusSecs = (focus ?? []).filter((f) => f.kind === "focus").reduce((n, f) => n + f.actualSeconds, 0);
  const total = data?.reduce((n, d) => n + d.count, 0) ?? 0;
  return (
    <div className="col" style={{ gap: 8, height: "100%" }}>
      <div className="row faint" style={{ fontSize: "var(--fs-xs)", gap: 12 }}>
        <span>
          <b className="tabular" style={{ color: "var(--text)" }}>{total}</b> tasks completed
        </span>
        {focusSecs > 0 && (
          <span>
            <b style={{ color: "var(--text)" }}>{formatDuration(focusSecs)}</b> focused
          </span>
        )}
      </div>
      {data && <Bars data={data} today={today} labelFmt="EEE" />}
    </div>
  );
}

// ------------------------------------------------------------- Calendar

export function CalendarWidget(_: WidgetProps) {
  const today = useToday();
  const [month, setMonth] = useState(monthStartStr(today));
  const [selected, setSelected] = useState(today);
  const days = useMemo(() => monthGrid(month), [month]);
  const { data: counts } = useQuery({
    queryKey: ["stats", "due", days[0], days[41]],
    queryFn: () => api.stats.dueCounts(days[0], days[41]),
  });
  const byDay = useMemo(() => new Map((counts ?? []).map(([d, open, done]) => [d, { open, done }])), [counts]);
  const { data: dayTasks } = useTasks({ dueFrom: selected, dueTo: selected, topLevelOnly: true, includeCompleted: true, order: "due" });
  const m = parseDateStr(month).getMonth();
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span style={{ fontSize: "var(--fs-sm)", fontWeight: 600 }}>{format(parseDateStr(month), "MMMM yyyy")}</span>
        <div className="row" style={{ gap: 0 }}>
          <IconButton icon={ChevronLeft} label="Previous month" size="sm" onClick={() => setMonth(addMonthsStr(month, -1))} />
          <IconButton icon={ChevronRight} label="Next month" size="sm" onClick={() => setMonth(addMonthsStr(month, 1))} />
        </div>
      </div>
      <div className="mcal">
        {weekdayLabels(undefined, "narrow").map((d, i) => (
          <div key={i} className="mcal__dow">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const c = byDay.get(d);
          return (
            <button
              key={d}
              type="button"
              className="mcal__day"
              data-outside={parseDateStr(d).getMonth() !== m}
              data-today={d === today}
              data-selected={d === selected}
              onClick={() => setSelected(d)}
              onDoubleClick={() => useUi.getState().openCapture("task", { dueDate: d })}
              aria-label={`${d}${c ? `, ${c.open} open` : ""}`}
            >
              {parseDateStr(d).getDate()}
              {c && c.open > 0 && (
                <span className="mcal__dots">
                  {Array.from({ length: Math.min(3, c.open) }, (_, i) => (
                    <span key={i} />
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="mini-head">{formatDayHeading(selected, today)}</div>
      {dayTasks?.length ? (
        <MiniTaskList tasks={dayTasks} showDue={false} max={6} />
      ) : (
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Nothing due. Double-click a day to add a task.
        </span>
      )}
    </div>
  );
}
