import { Timer, Minus, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useFocusClock, KindSwitch, TaskSelector, TransportControls } from "./FocusControls";
import { KIND_LABEL } from "./store";
import { api } from "@/lib/ipc";
import { addDaysStr, dayStartMs, formatClock, formatDuration, weekStartStr } from "@/lib/dates";
import { useToday } from "@/hooks/useToday";
import { useSetting } from "@/stores/settings";
import { IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Controls";
import { useTask } from "@/hooks/data";
import { TaskCheck } from "@/components/ui/Controls";
import { setCompleted } from "@/features/tasks/actions";
import { format } from "date-fns";

export default function FocusPage() {
  const { f, remaining, progress } = useFocusClock();
  const today = useToday();
  const tracking = useSetting("focus.trackHistory");
  const weekStart = weekStartStr(today);
  const { data: sessions } = useQuery({
    queryKey: ["focus", "sessions", weekStart],
    queryFn: () => api.focus.list(dayStartMs(weekStart), dayStartMs(addDaysStr(weekStart, 7))),
  });
  const { data: task } = useTask(f.taskId);
  const focusOnly = (sessions ?? []).filter((s) => s.kind === "focus");
  const todaySecs = focusOnly.filter((s) => s.startedAt >= dayStartMs(today)).reduce((n, s) => n + s.actualSeconds, 0);
  const weekSecs = focusOnly.reduce((n, s) => n + s.actualSeconds, 0);
  const todayCount = focusOnly.filter((s) => s.startedAt >= dayStartMs(today) && s.completed).length;
  const r = 140;
  const c = 2 * Math.PI * r;
  const byDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of focusOnly) {
      const d = format(new Date(s.startedAt), "yyyy-MM-dd");
      m.set(d, (m.get(d) ?? 0) + s.actualSeconds);
    }
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDaysStr(weekStart, i);
      return { d, secs: m.get(d) ?? 0 };
    });
  }, [focusOnly, weekStart]);
  const maxDay = Math.max(1, ...byDay.map((x) => x.secs));

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <Timer /> Focus
        </h1>
        <div style={{ marginLeft: 8 }}>
          <KindSwitch />
        </div>
      </header>
      <div className="focus-page">
        <div className="focus-stage">
          <div className="focus-dial">
            <svg viewBox="0 0 300 300" className="ring" aria-hidden>
              <circle className="ring__track" cx="150" cy="150" r={r} fill="none" strokeWidth="4" />
              <circle className="ring__bar" cx="150" cy="150" r={r} fill="none" strokeWidth="4" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} />
            </svg>
            <div className="focus-dial__center">
              <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
                {KIND_LABEL[f.kind]}
                {f.phase === "paused" ? " · paused" : ""}
              </span>
              <span className="focus-dial__time" role="timer" aria-live="off">
                {formatClock(remaining)}
              </span>
              {f.phase === "idle" && (
                <div className="row" style={{ gap: 4 }}>
                  <IconButton icon={Minus} label="5 minutes less" size="sm" onClick={() => f.setMinutes(f.durationSec / 60 - 5)} />
                  <span className="faint tabular" style={{ fontSize: "var(--fs-xs)", minWidth: 44, textAlign: "center" }}>
                    {Math.round(f.durationSec / 60)} min
                  </span>
                  <IconButton icon={Plus} label="5 minutes more" size="sm" onClick={() => f.setMinutes(f.durationSec / 60 + 5)} />
                </div>
              )}
            </div>
          </div>
          {f.kind === "focus" && (
            <div className="row" style={{ gap: 8, maxWidth: 420 }}>
              {task && <TaskCheck checked={task.status === "completed"} onToggle={() => void setCompleted(task, task.status !== "completed")} priority={task.priority} />}
              <TaskSelector />
            </div>
          )}
          <TransportControls />
        </div>
        <aside className="focus-side">
          {!tracking ? (
            <EmptyState compact>Focus history is turned off in Settings.</EmptyState>
          ) : (
            <>
              <div className="rundown-stats" style={{ margin: 0 }}>
                <div className="stat">
                  <span className="stat__value">{formatDuration(todaySecs)}</span>
                  <span className="stat__label">Today</span>
                </div>
                <div className="stat">
                  <span className="stat__value">{todayCount}</span>
                  <span className="stat__label">Sessions today</span>
                </div>
                <div className="stat">
                  <span className="stat__value">{formatDuration(weekSecs)}</span>
                  <span className="stat__label">This week</span>
                </div>
              </div>
              <div className="bars" style={{ height: 90 }}>
                {byDay.map((x) => (
                  <div key={x.d} className="bars__col" data-today={x.d === today || undefined} title={`${formatDuration(x.secs)}`}>
                    <div className="bars__bar" style={{ height: `${(x.secs / maxDay) * 80}%` }} />
                    <span className="bars__label">{format(new Date(dayStartMs(x.d)), "EEEEE")}</span>
                  </div>
                ))}
              </div>
              <div className="col" style={{ gap: 2 }}>
                <div className="section-title" style={{ marginBottom: 4 }}>
                  This week
                </div>
                {focusOnly.slice(0, 20).map((s) => (
                  <SessionRow key={s.id} taskId={s.taskId} startedAt={s.startedAt} secs={s.actualSeconds} completed={s.completed} />
                ))}
                {!focusOnly.length && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Completed sessions appear here.</span>}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function SessionRow({ taskId, startedAt, secs, completed }: { taskId: string | null; startedAt: number; secs: number; completed: boolean }) {
  const { data: task } = useTask(taskId);
  return (
    <div className="row" style={{ fontSize: "var(--fs-sm)", height: 26 }}>
      <span className="faint tabular" style={{ width: 70 }}>
        {format(new Date(startedAt), "EEE HH:mm")}
      </span>
      <span className="truncate grow">{task?.title ?? (taskId ? "Deleted task" : "No task")}</span>
      <span className="faint tabular">
        {formatDuration(secs)}
        {!completed && " (stopped)"}
      </span>
    </div>
  );
}

