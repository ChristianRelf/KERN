/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// Today's agenda for the dashboard: calendar events and time-blocked tasks
// in time order, with what's on now highlighted.

import { CalendarClock } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { WidgetProps } from "@/features/dashboard/types";
import { useTasks } from "@/hooks/data";
import { useNow, useToday } from "@/hooks/useToday";
import { api } from "@/lib/ipc";
import { formatDuration, formatTime } from "@/lib/dates";
import { useSetting } from "@/stores/settings";
import { navigate } from "@/stores/router";
import { EmptyState, TaskCheck } from "@/components/ui/Controls";
import { Button } from "@/components/ui/Button";
import { openTask } from "@/features/tasks/menu";
import { toggleComplete } from "@/features/tasks/actions";
import { DEFAULT_MINUTES, coversDay, eventSpan, fromMin, toMin } from "./layout";
import "./planner.css";

export function AgendaWidget(_: WidgetProps) {
  const today = useToday();
  const now = useNow(60_000);
  const showEvents = useSetting("calendar.showEvents");
  const { data: planned } = useTasks({ plannedFrom: today, plannedTo: today, includeCompleted: true });
  const { data: events } = useQuery({ queryKey: ["calendar", "events", today, today], queryFn: () => api.calendar.events(today, today), enabled: showEvents, staleTime: 60_000 });
  const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const allDay = [...(events ?? []).filter((e) => coversDay(e, today)).map((e) => e.title), ...(planned ?? []).filter((t) => !t.planTime).map((t) => t.title)];
  const items = [
    ...(events ?? []).flatMap((e) => {
      const s = eventSpan(e, today);
      return s ? [{ key: `e:${e.uid}:${e.start}`, start: s.start, end: s.end, title: e.title, color: e.color ?? "var(--hue-3)", sub: e.location ?? e.feedName, task: null }] : [];
    }),
    ...(planned ?? [])
      .filter((t) => t.planTime)
      .map((t) => {
        const s = toMin(t.planTime!);
        return { key: `t:${t.id}`, start: s, end: s + (t.estimateMinutes ?? DEFAULT_MINUTES), title: t.title, color: "var(--accent)", sub: formatDuration((t.estimateMinutes ?? DEFAULT_MINUTES) * 60), task: t };
      }),
  ].sort((a, b) => a.start - b.start);
  if (!items.length && !allDay.length)
    return (
      <EmptyState compact icon={CalendarClock} action={<Button size="sm" onClick={() => navigate({ name: "tasks", view: "plan" })}>Plan your day</Button>}>
        Nothing scheduled today.
      </EmptyState>
    );
  return (
    <div className="col" style={{ gap: 2, height: "100%", overflowY: "auto" }}>
      {allDay.length > 0 && (
        <div className="row" style={{ flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
          {allDay.map((t, i) => (
            <span key={i} className="planner-chip">
              {t}
            </span>
          ))}
        </div>
      )}
      {items.map((it) => {
        const live = nowMin >= it.start && nowMin < it.end;
        const past = nowMin >= it.end;
        return (
          <div key={it.key} className="row" style={{ gap: 8, padding: "4px 2px", opacity: past ? 0.55 : 1, borderRadius: "var(--r-sm)", background: live ? "var(--accent-soft)" : undefined }}>
            <span className="tabular faint" style={{ fontSize: "var(--fs-xs)", width: 74, flexShrink: 0 }}>
              {formatTime(fromMin(it.start))}–{formatTime(fromMin(it.end))}
            </span>
            <span style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: it.color, flexShrink: 0 }} aria-hidden />
            {it.task && <TaskCheck checked={it.task.status === "completed"} onToggle={() => void toggleComplete(it.task!)} priority={it.task.priority} />}
            <button type="button" className="truncate grow" style={{ textAlign: "left" }} disabled={!it.task} onClick={() => it.task && openTask(it.task.id)}>
              {it.title}
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}> · {it.sub}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
