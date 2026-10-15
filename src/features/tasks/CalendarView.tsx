/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ChevronLeft, ChevronRight, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { format } from "date-fns";
import type { CalEvent, Task } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { useSetting } from "@/stores/settings";
import { useTasks } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { addMonthsStr, formatDue, formatTime, monthGrid, monthStartStr, parseDateStr, weekdayLabels, addDaysStr } from "@/lib/dates";
import { IconButton, Button } from "@/components/ui/Button";
import { Popover, TaskCheck, TaskTitle, Switch } from "@/components/ui/Controls";
import { openTask } from "./menu";
import { toggleComplete, updateTask } from "./actions";
import { useUi } from "@/stores/ui";

function sortDay(a: Task, b: Task) {
  return (
    Number(a.status === "completed") - Number(b.status === "completed") ||
    (a.dueTime ?? "99").localeCompare(b.dueTime ?? "99") ||
    b.priority - a.priority ||
    a.sortOrder - b.sortOrder
  );
}

function CalTask({ task, overlay, still }: { task: Task; overlay?: boolean; still?: boolean }) {
  const inert = overlay || still;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: inert ? `inert:${task.id}` : task.id, data: { task }, disabled: inert });
  return (
    <div
      ref={inert ? undefined : setNodeRef}
      {...(inert ? {} : attributes)}
      {...(inert ? {} : listeners)}
      className="cal-task"
      data-done={task.status === "completed"}
      style={{ opacity: isDragging && !overlay ? 0.35 : 1, boxShadow: overlay ? "var(--shadow-md)" : undefined }}
      onClick={(e) => {
        e.stopPropagation();
        openTask(task.id);
      }}
      title={task.title}
    >
      <TaskCheck checked={task.status === "completed"} onToggle={() => void toggleComplete(task)} priority={task.priority} cancelled={!!task.resolution} />
      {task.dueTime && <span className="faint tabular">{formatTime(task.dueTime)}</span>}
      <TaskTitle title={task.title} done={task.status === "completed"} />
    </div>
  );
}

function CalEventChip({ e }: { e: CalEvent }) {
  return (
    <div className="cal-event" style={{ ["--event" as string]: e.color ?? "var(--hue-3)" }} title={`${e.title}${e.location ? ` · ${e.location}` : ""} (${e.feedName})`}>
      {!e.allDay && <span className="faint tabular">{formatTime(e.start.slice(11, 16))}</span>}
      <span className="truncate">{e.title}</span>
    </div>
  );
}

function DayCell({ day, tasks, events, month, today, maxVisible }: { day: string; tasks: Task[]; events: CalEvent[]; month: number; today: string; maxVisible: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day}` });
  const d = parseDateStr(day);
  const shownEvents = events.slice(0, Math.max(1, Math.min(2, maxVisible - tasks.length)));
  const visible = tasks.slice(0, Math.max(1, maxVisible - shownEvents.length));
  const more = tasks.length - visible.length + (events.length - shownEvents.length);
  return (
    <div
      ref={setNodeRef}
      className="cal__cell"
      data-outside={d.getMonth() !== month}
      data-today={day === today}
      data-over={isOver || undefined}
      onDoubleClick={() => useUi.getState().openCapture("task", { dueDate: day })}
    >
      <div className="cal__date">
        <b>{d.getDate() === 1 ? format(d, "d MMM") : d.getDate()}</b>
      </div>
      <div className="cal__tasks">
        {shownEvents.map((e) => (
          <CalEventChip key={`${e.feedId}:${e.uid}:${e.start}`} e={e} />
        ))}
        {visible.map((t) => (
          <CalTask key={t.id} task={t} />
        ))}
        {more > 0 && (
          <Popover trigger={<button type="button" className="cal__more">+{more} more</button>} pad>
            <div className="col" style={{ gap: 2, width: 260 }}>
              <div className="section-title" style={{ marginBottom: 4 }}>
                {formatDue(day, null, today)}
              </div>
              {events.map((e) => (
                <CalEventChip key={`${e.feedId}:${e.uid}:${e.start}`} e={e} />
              ))}
              {tasks.map((t) => (
                <CalTask key={t.id} task={t} still />
              ))}
            </div>
          </Popover>
        )}
      </div>
    </div>
  );
}

function Unscheduled({ tasks }: { tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: "day:none" });
  return (
    <aside
      ref={setNodeRef}
      style={{
        width: 240,
        borderLeft: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        background: isOver ? "var(--accent-soft)" : "var(--bg-sunken)",
        minHeight: 0,
      }}
    >
      <div className="section-title" style={{ padding: "10px 12px 6px" }}>
        Unscheduled <span className="count">{tasks.length}</span>
      </div>
      <div className="col" style={{ gap: 2, padding: "0 8px 12px", overflowY: "auto" }}>
        {tasks.map((t) => (
          <CalTask key={t.id} task={t} />
        ))}
        {!tasks.length && <div className="faint" style={{ fontSize: "var(--fs-xs)", padding: "4px 4px" }}>Drag a task here to remove its date.</div>}
      </div>
    </aside>
  );
}

export default function CalendarView() {
  const today = useToday();
  const [month, setMonth] = useState(() => monthStartStr(today));
  const [showDone, setShowDone] = useState(false);
  const [showTray, setShowTray] = useState(true);
  const [dragging, setDragging] = useState<Task | null>(null);
  const days = useMemo(() => monthGrid(month), [month]);
  const { data: tasks } = useTasks({
    dueFrom: days[0],
    dueTo: days[days.length - 1],
    topLevelOnly: true,
    includeCompleted: showDone,
    order: "due",
  });
  const { data: undated } = useTasks({ hasDue: false, topLevelOnly: true, limit: 100, order: "priority" }, { enabled: showTray });
  const showEvents = useSetting("calendar.showEvents");
  const { data: events } = useQuery({
    queryKey: ["calendar", "events", days[0], days[days.length - 1]],
    queryFn: () => api.calendar.events(days[0], days[days.length - 1]),
    enabled: showEvents,
    staleTime: 60_000,
  });
  const eventsByDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events ?? []) {
      // Multi-day events show on each of their days.
      let d = e.start.slice(0, 10);
      const last = e.end.slice(0, 10);
      for (let i = 0; i < 62 && d <= last; i++) {
        if (!m.has(d)) m.set(d, []);
        m.get(d)!.push(e);
        d = addDaysStr(d, 1);
      }
    }
    return m;
  }, [events]);
  const byDay = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of tasks ?? []) {
      if (!t.dueDate) continue;
      if (!m.has(t.dueDate)) m.set(t.dueDate, []);
      m.get(t.dueDate)!.push(t);
    }
    for (const list of m.values()) list.sort(sortDay);
    return m;
  }, [tasks]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current as { task: Task }).task);
  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null);
    const task = (e.active.data.current as { task: Task } | undefined)?.task;
    const target = e.over?.id ? String(e.over.id).slice(4) : null;
    if (!task || target === null) return;
    const date = target === "none" ? null : target;
    if (date === task.dueDate) return;
    void updateTask(task.id, { dueDate: date, ...(date ? {} : { dueTime: null }) }, { undoLabel: date ? `Moved to ${formatDue(date)}` : "Date removed" });
  };
  const monthIdx = parseDateStr(month).getMonth();

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="toolbar">
        <span style={{ fontWeight: 600, minWidth: 130 }}>{format(parseDateStr(month), "MMMM yyyy")}</span>
        <IconButton icon={ChevronLeft} label="Previous month" size="sm" onClick={() => setMonth(addMonthsStr(month, -1))} />
        <IconButton icon={ChevronRight} label="Next month" size="sm" onClick={() => setMonth(addMonthsStr(month, 1))} />
        <Button size="sm" variant="ghost" onClick={() => setMonth(monthStartStr(today))}>
          Today
        </Button>
        <span className="spacer" />
        <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)", color: "var(--text-2)" }}>
          Completed
          <Switch checked={showDone} onChange={setShowDone} label="Show completed" />
        </label>
        <IconButton
          icon={showTray ? PanelRightClose : PanelRightOpen}
          label={showTray ? "Hide unscheduled" : "Show unscheduled"}
          size="sm"
          onClick={() => setShowTray(!showTray)}
        />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div className="cal" style={{ flex: 1, minWidth: 0 }}>
          <div className="cal__head">
            {weekdayLabels().map((d) => (
              <div key={d} className="cal__dow">
                {d}
              </div>
            ))}
          </div>
          <div className="cal__grid">
            {days.map((d) => (
              <DayCell key={d} day={d} tasks={byDay.get(d) ?? []} events={eventsByDay.get(d) ?? []} month={monthIdx} today={today} maxVisible={4} />
            ))}
          </div>
        </div>
        {showTray && <Unscheduled tasks={undated ?? []} />}
      </div>
      <DragOverlay dropAnimation={null}>{dragging && <CalTask task={dragging} overlay />}</DragOverlay>
    </DndContext>
  );
}
