/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// Day planner: time blocking. Tasks to do (due, overdue, in progress or
// pinned) sit in a tray; drag them onto the day to plan when you'll do them,
// drag blocks to move them and their lower edge to change how long they
// take (the task's estimate). Subscribed calendar events show alongside, so
// plans fit around meetings. "Fill my day" places the tray's tasks into the
// free time, in order.

import { ChevronLeft, ChevronRight, CalendarPlus, Wand2, X, MapPin } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { CalEvent, Task } from "@/lib/types";
import { useTasks } from "@/hooks/data";
import { useNow, useToday } from "@/hooks/useToday";
import { addDaysStr, formatDue, formatDuration, formatTime, parseDateStr, weekStartStr } from "@/lib/dates";
import { api, describeError } from "@/lib/ipc";
import { invalidateTasks } from "@/lib/query";
import { useSetting } from "@/stores/settings";
import { pushUndo } from "@/stores/undo";
import { toast, toastError } from "@/stores/toast";
import { navigate } from "@/stores/router";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented, TaskCheck, TaskTitle } from "@/components/ui/Controls";
import { openTask } from "@/features/tasks/menu";
import { toggleComplete, updateTask } from "@/features/tasks/actions";
import { autoPlan, coversDay, DEFAULT_MINUTES, eventSpan, fromMin, layoutColumns, snap, toMin } from "./layout";
import "./planner.css";

/** Pixels per minute on the timeline. */
const PX = 0.9;

const minutesOf = (t: Task) => t.estimateMinutes ?? DEFAULT_MINUTES;
const isBlocked = (t: Task, from: string, to: string) => !!t.planDate && !!t.planTime && t.planDate >= from && t.planDate <= to;

function useCalendarEvents(from: string, to: string) {
  const on = useSetting("calendar.showEvents");
  return useQuery({ queryKey: ["calendar", "events", from, to], queryFn: () => api.calendar.events(from, to), enabled: on, staleTime: 60_000 }).data ?? [];
}

function TrayTask({ task, overlay }: { task: Task; overlay?: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: overlay ? `overlay:${task.id}` : `task:${task.id}`, data: { task }, disabled: overlay });
  const today = useToday();
  return (
    <div
      ref={overlay ? undefined : setNodeRef}
      {...(overlay ? {} : attributes)}
      {...(overlay ? {} : listeners)}
      className="planner-tray__task"
      data-dragging={isDragging || undefined}
      data-overlay={overlay || undefined}
      onClick={() => openTask(task.id)}
    >
      <TaskCheck checked={task.status === "completed"} onToggle={() => void toggleComplete(task)} priority={task.priority} />
      <div className="grow" style={{ minWidth: 0 }}>
        <TaskTitle title={task.title} done={task.status === "completed"} />
        <div className="planner-tray__meta">
          {task.dueDate && <span data-overdue={task.dueDate < today || undefined}>{formatDue(task.dueDate, task.dueTime, today)}</span>}
          <span>{formatDuration(minutesOf(task) * 60)}</span>
        </div>
      </div>
    </div>
  );
}

function Block({ task, top, height, left, width, onResize }: { task: Task; top: number; height: number; left: string; width: string; onResize: (minutes: number) => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `block:${task.id}`, data: { task } });
  const [live, setLive] = useState<number | null>(null);
  const done = task.status === "completed";
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const y0 = e.clientY;
    const m0 = minutesOf(task);
    let m = m0;
    const move = (ev: PointerEvent) => {
      m = Math.max(15, snap(m0 + (ev.clientY - y0) / PX));
      setLive(m);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      if (m !== m0) onResize(m);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const minutes = live ?? minutesOf(task);
  const h = live !== null ? Math.max(18, live * PX) : height;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="planner-block"
      data-done={done || undefined}
      data-dragging={isDragging || undefined}
      data-short={h < 34 || undefined}
      style={{ top, height: h, left, width }}
      onClick={() => openTask(task.id)}
      title={task.title}
    >
      <div className="planner-block__row">
        <TaskCheck checked={done} onToggle={() => void toggleComplete(task)} priority={task.priority} size={13} />
        <span className="planner-block__title">{task.title}</span>
      </div>
      {h >= 34 && (
        <span className="planner-block__time">
          {formatTime(task.planTime)}–{formatTime(fromMin(toMin(task.planTime!) + minutes))} · {formatDuration(minutes * 60)}
        </span>
      )}
      <button
        type="button"
        className="planner-block__remove"
        aria-label="Remove from plan"
        title="Remove from plan"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void updateTask(task.id, { planDate: null, planTime: null }, { undoLabel: "Removed from plan" });
        }}
      >
        <X size={12} />
      </button>
      <div className="planner-block__resize" onPointerDown={startResize} aria-hidden />
    </div>
  );
}

function EventBlock({ e, top, height, left, width }: { e: CalEvent; top: number; height: number; left: string; width: string }) {
  return (
    <div className="planner-event" style={{ top, height: Math.max(16, height), left, width, ["--event" as string]: e.color ?? "var(--hue-3)" }} title={`${e.title}${e.location ? ` · ${e.location}` : ""} (${e.feedName})`}>
      <span className="planner-event__title">{e.title}</span>
      {height >= 32 && (
        <span className="planner-event__time">
          {formatTime(e.start.slice(11, 16))}–{formatTime(e.end.slice(11, 16))}
          {e.location && (
            <>
              {" · "}
              <MapPin size={10} style={{ verticalAlign: -1 }} /> {e.location}
            </>
          )}
        </span>
      )}
    </div>
  );
}

function DayColumn({ day, today, tasks, events, startHour, endHour, now }: { day: string; today: string; tasks: Task[]; events: CalEvent[]; startHour: number; endHour: number; now: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${day}` });
  const origin = startHour * 60;
  const spans = useMemo(() => {
    const out: { id: string; start: number; end: number; kind: "task" | "event"; task?: Task; event?: CalEvent }[] = [];
    for (const t of tasks) {
      const s = toMin(t.planTime!);
      out.push({ id: `t:${t.id}`, start: s, end: s + minutesOf(t), kind: "task", task: t });
    }
    events.forEach((e, i) => {
      const span = eventSpan(e, day);
      if (span) out.push({ id: `e:${i}:${e.uid}`, ...span, kind: "event", event: e });
    });
    return out;
  }, [tasks, events, day]);
  const cols = useMemo(() => layoutColumns(spans), [spans]);
  const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  return (
    <div ref={setNodeRef} className="planner-col" data-today={day === today || undefined} data-over={isOver || undefined} style={{ height: (endHour - startHour) * 60 * PX }}>
      {Array.from({ length: endHour - startHour }, (_, i) => (
        <div key={i} className="planner-col__hour" style={{ top: i * 60 * PX, height: 60 * PX }} />
      ))}
      {spans.map((s) => {
        const c = cols.get(s.id) ?? { col: 0, cols: 1 };
        const top = (Math.max(s.start, origin) - origin) * PX;
        const height = (Math.min(s.end, endHour * 60) - Math.max(s.start, origin)) * PX;
        if (height <= 0) return null;
        const left = `calc(${(c.col / c.cols) * 100}% + 2px)`;
        const width = `calc(${100 / c.cols}% - 4px)`;
        return s.kind === "task" ? (
          <Block key={s.id} task={s.task!} top={top} height={Math.max(18, height)} left={left} width={width} onResize={(m) => void updateTask(s.task!.id, { estimateMinutes: m }, { undoLabel: `Now ${formatDuration(m * 60)}` })} />
        ) : (
          <EventBlock key={s.id} e={s.event!} top={top} height={height} left={left} width={width} />
        );
      })}
      {day === today && nowMin >= origin && nowMin <= endHour * 60 && <div className="planner-now" style={{ top: (nowMin - origin) * PX }} />}
    </div>
  );
}

function AllDay({ day, tasks, events }: { day: string; tasks: Task[]; events: CalEvent[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: `allday:${day}` });
  return (
    <div ref={setNodeRef} className="planner-allday" data-over={isOver || undefined}>
      {events.map((e) => (
        <span key={`${e.feedId}:${e.uid}:${e.start}`} className="planner-chip planner-chip--event" style={{ ["--event" as string]: e.color ?? "var(--hue-3)" }} title={`${e.title} (${e.feedName})`}>
          {e.title}
        </span>
      ))}
      {tasks.map((t) => (
        <button key={t.id} type="button" className="planner-chip" data-done={t.status === "completed" || undefined} onClick={() => openTask(t.id)} title="Planned for this day">
          {t.title}
        </button>
      ))}
    </div>
  );
}

function Tray({ tasks, day }: { tasks: Task[]; day: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: "tray" });
  return (
    <aside ref={setNodeRef} className="planner-tray" data-over={isOver || undefined}>
      <div className="section-title" style={{ padding: "12px 12px 6px" }}>
        To plan <span className="count">{tasks.length}</span>
      </div>
      <div className="planner-tray__list">
        {tasks.map((t) => (
          <TrayTask key={t.id} task={t} />
        ))}
        {!tasks.length && (
          <div className="faint" style={{ fontSize: "var(--fs-xs)", padding: "4px 12px" }}>
            Nothing left to plan for {formatDue(day)}. Tasks that are due, in progress or pinned show up here.
          </div>
        )}
      </div>
      <div className="planner-tray__hint">Drag a task onto the day to block out time. Drop it back here to unplan it.</div>
    </aside>
  );
}

export default function PlannerView() {
  const today = useToday();
  const now = useNow(60_000);
  const [day, setDay] = useState(today);
  const [mode, setMode] = useState<"day" | "week">("day");
  const [dragging, setDragging] = useState<Task | null>(null);
  const startHour = Math.max(0, Math.min(22, useSetting("calendar.dayStart")));
  const endHour = Math.max(startHour + 2, Math.min(24, useSetting("calendar.dayEnd")));
  const weekStartsOn = useSetting("tasks.weekStart");
  const days = useMemo(() => {
    if (mode === "day") return [day];
    const ws = weekStartStr(day, weekStartsOn);
    return Array.from({ length: 7 }, (_, i) => addDaysStr(ws, i));
  }, [mode, day, weekStartsOn]);
  const from = days[0];
  const to = days[days.length - 1];

  const { data: planned } = useTasks({ plannedFrom: from, plannedTo: to, includeCompleted: true, order: "manual" });
  const { data: due } = useTasks({ dueTo: to, topLevelOnly: true, order: "priority", limit: 300 });
  const { data: active } = useTasks({ statuses: ["in_progress"], topLevelOnly: true, limit: 100 });
  const { data: pinned } = useTasks({ pinned: true, topLevelOnly: true, limit: 100 });
  const events = useCalendarEvents(from, to);

  const tray = useMemo(() => {
    const seen = new Set<string>();
    const out: Task[] = [];
    for (const t of [...(due ?? []), ...(active ?? []), ...(pinned ?? [])]) {
      if (seen.has(t.id) || t.status === "completed" || isBlocked(t, from, to)) continue;
      seen.add(t.id);
      out.push(t);
    }
    // Overdue first, then by priority and due date.
    return out.sort((a, b) => Number((b.dueDate ?? "9") < today) - Number((a.dueDate ?? "9") < today) || b.priority - a.priority || (a.dueDate ?? "9").localeCompare(b.dueDate ?? "9"));
  }, [due, active, pinned, from, to, today]);

  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // Open at the current time (or the start of the working day).
    const el = scroller.current;
    if (!el) return;
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const target = days.includes(today) ? nowMin - 90 : 8 * 60;
    el.scrollTop = Math.max(0, (target - startHour * 60) * PX);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current as { task: Task }).task);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const task = (e.active.data.current as { task: Task } | undefined)?.task;
    const over = e.over;
    if (!task || !over) return;
    const id = String(over.id);
    if (id === "tray") {
      if (task.planDate) void updateTask(task.id, { planDate: null, planTime: null }, { undoLabel: "Removed from plan" });
      return;
    }
    if (id.startsWith("allday:")) {
      const d = id.slice(7);
      void updateTask(task.id, { planDate: d, planTime: null }, { undoLabel: `Planned for ${formatDue(d)}` });
      return;
    }
    if (!id.startsWith("col:")) return;
    const d = id.slice(4);
    const top = e.active.rect.current.translated?.top ?? 0;
    const minute = snap(startHour * 60 + (top - over.rect.top) / PX);
    const start = Math.max(startHour * 60, Math.min(endHour * 60 - 15, minute));
    const time = fromMin(start);
    if (task.planDate === d && task.planTime === time) return;
    void updateTask(task.id, { planDate: d, planTime: time }, { undoLabel: `Planned for ${formatTime(time)}${d !== day ? ` ${formatDue(d)}` : ""}` });
  };

  const fillDay = async () => {
    const d = day;
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const fromMinute = d === today ? Math.max(startHour * 60, nowMin) : startHour * 60;
    const busy = [
      ...(planned ?? []).filter((t) => t.planDate === d && t.planTime && t.status !== "completed").map((t) => ({ start: toMin(t.planTime!), end: toMin(t.planTime!) + minutesOf(t) })),
      ...events.map((ev) => eventSpan(ev, d)).filter((s): s is { start: number; end: number } => !!s),
    ];
    const candidates = tray.filter((t) => !t.dueDate || t.dueDate <= d);
    const plan = autoPlan(candidates.map((t) => ({ id: t.id, minutes: minutesOf(t) })), busy, fromMinute, endHour * 60);
    if (!plan.length) {
      toast(candidates.length ? "There's no free time left today for these tasks." : "Nothing to plan.");
      return;
    }
    const prev = new Map(candidates.map((t) => [t.id, { planDate: t.planDate ?? null, planTime: t.planTime ?? null }]));
    try {
      await api.tasks.patchBatch(plan.map((p) => [p.id, { planDate: d, planTime: fromMin(p.start) }]));
      invalidateTasks();
      const left = candidates.length - plan.length;
      pushUndo(`Planned ${plan.length} task${plan.length === 1 ? "" : "s"}${left ? ` (${left} didn't fit)` : ""}`, async () => {
        await api.tasks.patchBatch(plan.map((p) => [p.id, prev.get(p.id)!]));
        invalidateTasks();
      });
    } catch (err) {
      toastError(describeError(err, "Couldn't plan the day."));
    }
  };

  const step = mode === "day" ? 1 : 7;
  const planFor = (d: string) => (planned ?? []).filter((t) => t.planDate === d);

  // Keep a selected day inside the week when switching modes.
  useEffect(() => {
    if (!days.includes(day)) setDay(days[0]);
  }, [days]); // eslint-disable-line react-hooks/exhaustive-deps

  const free = useMemo(() => {
    if (mode !== "day") return null;
    const busy = [
      ...planFor(day).filter((t) => t.planTime && t.status !== "completed").map((t) => ({ start: toMin(t.planTime!), end: toMin(t.planTime!) + minutesOf(t) })),
      ...events.map((ev) => eventSpan(ev, day)).filter((s): s is { start: number; end: number } => !!s),
    ];
    const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
    const fromMinute = day === today ? Math.max(startHour * 60, nowMin) : startHour * 60;
    let total = 0;
    let cur = fromMinute;
    for (const b of busy.sort((a, b) => a.start - b.start)) {
      if (b.start > cur) total += Math.min(b.start, endHour * 60) - cur;
      cur = Math.max(cur, b.end);
    }
    if (cur < endHour * 60) total += endHour * 60 - cur;
    return Math.max(0, total);
  }, [mode, planned, events, day, today, now, startHour, endHour]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="toolbar">
        <span style={{ fontWeight: 600, minWidth: 150 }}>{mode === "day" ? format(parseDateStr(day), "EEEE d MMMM") : `${format(parseDateStr(from), "d MMM")} – ${format(parseDateStr(to), "d MMM yyyy")}`}</span>
        <IconButton icon={ChevronLeft} label={mode === "day" ? "Previous day" : "Previous week"} size="sm" onClick={() => setDay(addDaysStr(day, -step))} />
        <IconButton icon={ChevronRight} label={mode === "day" ? "Next day" : "Next week"} size="sm" onClick={() => setDay(addDaysStr(day, step))} />
        <Button size="sm" variant="ghost" onClick={() => setDay(today)}>
          Today
        </Button>
        <Segmented size="sm" value={mode} onChange={setMode} ariaLabel="Planner range" options={[{ value: "day", label: "Day" }, { value: "week", label: "Week" }]} />
        <span className="spacer" />
        {free !== null && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{formatDuration(free * 60)} free</span>}
        {mode === "day" && (
          <Button size="sm" icon={Wand2} onClick={() => void fillDay()} title="Place the tasks to plan into free time, most urgent first">
            Fill my day
          </Button>
        )}
        <IconButton icon={CalendarPlus} label="Calendar subscriptions" size="sm" onClick={() => navigate({ name: "settings", section: "calendars" })} />
      </div>
      <div className="planner">
        <div className="planner__main">
          <div className="planner__head" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
            <div />
            {days.map((d) => (
              <button key={d} type="button" className="planner__day" data-today={d === today || undefined} data-selected={(mode === "week" && d === day) || undefined} onClick={() => (mode === "week" ? (setDay(d), setMode("day")) : undefined)}>
                <span>{format(parseDateStr(d), "EEE")}</span> <b>{format(parseDateStr(d), "d")}</b>
              </button>
            ))}
            <div className="planner__allday-label">All day</div>
            {days.map((d) => (
              <AllDay key={d} day={d} tasks={planFor(d).filter((t) => !t.planTime)} events={events.filter((e) => coversDay(e, d))} />
            ))}
          </div>
          <div className="planner__scroll" ref={scroller}>
            <div className="planner__grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }}>
              <div className="planner__hours" style={{ height: (endHour - startHour) * 60 * PX }}>
                {Array.from({ length: endHour - startHour }, (_, i) => (
                  <span key={i} style={{ top: i * 60 * PX }}>
                    {i === 0 ? "" : formatTime(fromMin((startHour + i) * 60))}
                  </span>
                ))}
              </div>
              {days.map((d) => (
                <DayColumn key={d} day={d} today={today} tasks={planFor(d).filter((t) => !!t.planTime)} events={events} startHour={startHour} endHour={endHour} now={now} />
              ))}
            </div>
          </div>
        </div>
        <Tray tasks={tray} day={day} />
      </div>
      <DragOverlay dropAnimation={null}>{dragging && <TrayTask task={dragging} overlay />}</DragOverlay>
    </DndContext>
  );
}
