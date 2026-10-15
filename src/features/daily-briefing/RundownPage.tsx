import { CalendarClock, History, Moon, Pin, RotateCcw, Sunrise, Sunset, X, Archive, CircleCheck, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@/lib/types";
import { api } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { navigate } from "@/stores/router";
import { useToday } from "@/hooks/useToday";
import { addDaysStr, dayBounds, formatDayHeading, formatDue } from "@/lib/dates";
import { useRundown } from "./useRundown";
import { snapTask, type EveningSnapshot, type MorningSnapshot, type SnapshotTask } from "./engine";
import { MiniTaskList, MiniTask } from "@/features/dashboard/MiniTaskList";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox, EmptyState, Segmented, Skeleton, TaskCheck } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { openTask } from "@/features/tasks/menu";
import { rescheduleTasks, toggleComplete, updateTask } from "@/features/tasks/actions";
import { DueLabel } from "@/features/tasks/TaskRow";
import { useProjects, useTasks } from "@/hooks/data";
import { Dropdown } from "@/components/ui/Menu";
import { openCatchup } from "@/features/catchup/open";
import { toast } from "@/stores/toast";
import { useSetting } from "@/stores/settings";
import { format } from "date-fns";
import { parseDateStr } from "@/lib/dates";

export default function RundownPage({ day, mode }: { day?: string; mode?: "morning" | "evening" }) {
  const today = useToday();
  const isHistory = !!day && day !== today;
  const view = mode ?? "morning";
  const { data: history } = useQuery({ queryKey: ["snapshots", "list"], queryFn: () => api.daily.listSnapshots(120) });
  const days = useMemo(() => {
    const m = new Map<string, { morning: boolean; evening: boolean }>();
    for (const s of history ?? []) {
      // Weekly reviews have their own page.
      if (s.kind === "weekly") continue;
      const e = m.get(s.day) ?? { morning: false, evening: false };
      e[s.kind] = true;
      m.set(s.day, e);
    }
    return [...m.entries()];
  }, [history]);

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          {view === "evening" ? <Sunset /> : <Sunrise />}
          {isHistory ? formatDayHeading(day!, today) : view === "evening" ? "Evening review" : "Daily rundown"}
        </h1>
        {!isHistory && <span className="page-header__sub">{format(parseDateStr(today), "EEEE d MMMM")}</span>}
        <div className="page-header__actions">
          <CatchupMenu />
          <Segmented
            size="sm"
            value={view}
            onChange={(m) => navigate({ name: "rundown", day, mode: m }, { replace: true })}
            options={[
              { value: "morning", label: "Morning", icon: Sunrise },
              { value: "evening", label: "Evening", icon: Moon },
            ]}
          />
        </div>
      </header>
      <div className="page-body">
        <div className="rundown">
          <div style={{ minWidth: 0 }}>
            {isHistory ? (
              <HistoricView day={day!} kind={view} />
            ) : view === "evening" ? (
              <EveningReview />
            ) : (
              <MorningView />
            )}
          </div>
          <aside className="col" style={{ gap: 6 }}>
            <div className="section-title" style={{ marginBottom: 4 }}>
              <History size={14} /> History
            </div>
            <button type="button" className="history-item" data-active={!isHistory || undefined} onClick={() => navigate({ name: "rundown", mode: view }, { replace: true })}>
              Today <span className="faint">(live)</span>
            </button>
            {days
              .filter(([d]) => d !== today)
              .map(([d, k]) => (
                <button key={d} type="button" className="history-item" data-active={day === d || undefined} onClick={() => navigate({ name: "rundown", day: d, mode: k.morning ? "morning" : "evening" }, { replace: true })}>
                  <span className="grow">{formatDayHeading(d, today)}</span>
                  {k.morning && <Sunrise size={12} className="faint" />}
                  {k.evening && <Moon size={12} className="faint" />}
                </button>
              ))}
            {days.filter(([d]) => d !== today).length === 0 && (
              <span className="faint" style={{ fontSize: "var(--fs-xs)", padding: "0 8px" }}>
                Each day's rundown is kept here.
              </span>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rundown__section">
      <div className="section-title" style={{ marginBottom: 4 }}>
        {title}
        <span className="spacer" />
        {actions}
      </div>
      {children}
    </section>
  );
}

function MorningView() {
  const { rundown, isLoading, snapshot, setSkipped, markViewed, today } = useRundown();
  const maxTasks = useSetting("rundown.maxTasks");
  useEffect(() => {
    if (snapshot && !snapshot.viewedAt) markViewed();
  }, [snapshot, markViewed]);
  if (isLoading || !rundown)
    return (
      <div className="col" style={{ gap: 10 }}>
        <Skeleton height={18} width="80%" />
        <Skeleton height={18} width="60%" />
        <Skeleton height={120} />
      </div>
    );
  const skipped = snapshot?.data.skipped ?? [];
  const r = rundown;
  return (
    <>
      <p className="rundown__hero selectable">{r.summary}</p>
      <div className="rundown-stats" style={{ marginTop: 14 }}>
        {(
          [
            [r.counts.today, "Due today"],
            [r.counts.overdue, "Overdue"],
            [r.counts.high, "High priority"],
            [r.counts.inProgress, "In progress"],
            [r.counts.completedToday, "Done today"],
          ] as [number, string][]
        ).map(([v, l]) => (
          <div key={l} className="stat">
            <span className="stat__value">{v}</span>
            <span className="stat__label">{l}</span>
          </div>
        ))}
      </div>

      <Section title="Suggested order">
        {r.suggestions.length ? (
          r.suggestions.map((s, i) => (
            <div key={s.task.id} className="suggest" role="button" tabIndex={0} onClick={() => openTask(s.task.id)}>
              <span className="suggest__rank">{i + 1}</span>
              <TaskCheck checked={false} onToggle={() => void toggleComplete(s.task)} priority={s.task.priority} />
              <div className="col grow">
                <span className="truncate">{s.task.title}</span>
                <span className="suggest__reasons">
                  {s.factors.map((f) => `${f.label} +${f.points}`).join(" · ")} = {s.score}
                </span>
              </div>
              <DueLabel date={s.task.dueDate} time={s.task.dueTime} done={false} today={today} />
              <Tooltip content={s.task.pinned ? "Unpin" : "Pin - always rank higher"}>
                <IconButton
                  icon={Pin}
                  label={s.task.pinned ? "Unpin" : "Pin"}
                  size="sm"
                  active={s.task.pinned}
                  noTooltip
                  onClick={(e) => {
                    e.stopPropagation();
                    void updateTask(s.task.id, { pinned: !s.task.pinned });
                  }}
                />
              </Tooltip>
              <IconButton
                icon={X}
                label="Not today"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  void setSkipped(s.task.id, true);
                }}
              />
            </div>
          ))
        ) : (
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            No suggestions. Tasks with due dates, priorities or pins are ranked here.
          </span>
        )}
        {skipped.length > 0 && (
          <button type="button" className="mini-more" onClick={() => skipped.forEach((id) => void setSkipped(id, false))}>
            <RotateCcw size={11} style={{ verticalAlign: -1 }} /> Restore {skipped.length} dismissed suggestion{skipped.length === 1 ? "" : "s"}
          </button>
        )}
        <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 4 }}>
          Ranking: priority, due date and days overdue, pinned, in progress, carried over, project deadlines; blocked tasks are skipped.
        </span>
      </Section>

      {r.overdue.length > 0 && (
        <Section
          title={`Overdue · ${r.overdue.length}`}
          actions={
            <Button size="sm" variant="ghost" icon={CalendarClock} onClick={() => void rescheduleTasks(r.overdue.map((t) => t.id), today)}>
              Move all to today
            </Button>
          }
        >
          <MiniTaskList tasks={r.overdue} max={maxTasks * 2} />
        </Section>
      )}
      <Section title={`Today · ${r.today.length}`}>
        {r.today.length ? <MiniTaskList tasks={r.today} showDue={false} showProject /> : <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Nothing scheduled.</span>}
      </Section>
      {r.carryovers.length > 0 && (
        <Section title="Carried over from yesterday">
          <MiniTaskList tasks={r.carryovers} showProject />
        </Section>
      )}
      {r.high.length > 0 && (
        <Section title="High priority">
          <MiniTaskList tasks={r.high} max={maxTasks} showProject />
        </Section>
      )}
      {r.upcoming.length > 0 && (
        <Section title="Coming up">
          <MiniTaskList tasks={r.upcoming} max={maxTasks} showProject />
        </Section>
      )}
      {r.projects.length > 0 && (
        <Section title="Projects needing attention">
          {r.projects.map((p) => (
            <button key={p.project.id} type="button" className="mini-task" style={{ textAlign: "left" }} onClick={() => navigate({ name: "project", id: p.project.id })}>
              <span className="mini-task__title">{p.project.name}</span>
              <span className="mini-task__meta">{p.reasons.join(" · ")}</span>
            </button>
          ))}
        </Section>
      )}
      {r.completedYesterday.length > 0 && (
        <Section title={`Completed yesterday · ${r.completedYesterday.length}`}>
          <MiniTaskList tasks={r.completedYesterday} max={maxTasks} showDue={false} />
        </Section>
      )}
    </>
  );
}

function EveningReview() {
  const today = useToday();
  const tomorrow = addDaysStr(today, 1);
  const b = dayBounds(today);
  const { data: done } = useTasks({ completedFrom: b.dayStart, completedTo: b.tomorrowStart, topLevelOnly: true, order: "completed", includeArchived: true });
  const { data: dueToday } = useTasks({ dueTo: today, hasDue: true, topLevelOnly: true, order: "due" });
  const { data: upcoming } = useTasks({ dueFrom: tomorrow, dueTo: addDaysStr(today, 3), topLevelOnly: true, order: "due" });
  const unfinished = dueToday ?? [];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => setSelected(new Set(unfinished.map((t) => t.id))), [dueToday]); // default: move everything
  const { data: snap } = useQuery({ queryKey: ["snapshots", today, "evening"], queryFn: () => api.daily.getSnapshot<EveningSnapshot>(today, "evening") });

  const finish = async (moved: Task[]) => {
    const data: EveningSnapshot = {
      version: 1,
      generatedAt: Date.now(),
      completed: (done ?? []).map(snapTask),
      unfinished: unfinished.filter((t) => !moved.includes(t)).map(snapTask),
      movedToTomorrow: moved.map(snapTask),
    };
    await api.daily.saveSnapshot(today, "evening", data, true);
    await api.daily.markViewed(today, "evening");
    invalidate("snapshots");
  };

  const moveSelected = async () => {
    const moved = unfinished.filter((t) => selected.has(t.id));
    if (moved.length) await rescheduleTasks(moved.map((t) => t.id), tomorrow);
    await finish(moved);
    toast(moved.length ? `${moved.length} moved to tomorrow` : "Review saved");
  };

  return (
    <>
      <p className="rundown__hero">
        You completed <b>{done?.length ?? 0}</b> task{done?.length === 1 ? "" : "s"} today
        {unfinished.length ? (
          <>
            {" "}
            and <b>{unfinished.length}</b> remain{unfinished.length === 1 ? "s" : ""} unfinished.
          </>
        ) : (
          ". Nothing left over."
        )}
      </p>
      {snap && (
        <div className="snapshot-banner" style={{ marginTop: 12 }}>
          <CircleCheck size={14} /> Reviewed at {format(new Date(snap.data.generatedAt), "HH:mm")}
          {snap.data.movedToTomorrow.length ? ` · ${snap.data.movedToTomorrow.length} moved to tomorrow` : ""}
        </div>
      )}
      <Section
        title={`Unfinished · ${unfinished.length}`}
        actions={
          unfinished.length > 0 && (
            <Button size="sm" variant="primary" icon={CalendarClock} onClick={() => void moveSelected()} disabled={!selected.size}>
              Move {selected.size} to tomorrow
            </Button>
          )
        }
      >
        {unfinished.length ? (
          unfinished.map((t) => (
            <div key={t.id} className="row" style={{ gap: 6 }}>
              <Checkbox
                checked={selected.has(t.id)}
                onChange={(on) => {
                  const next = new Set(selected);
                  if (on) next.add(t.id);
                  else next.delete(t.id);
                  setSelected(next);
                }}
                label={`Move ${t.title} to tomorrow`}
              />
              <div className="grow" style={{ minWidth: 0 }}>
                <MiniTask task={t} />
              </div>
            </div>
          ))
        ) : (
          <EmptyState compact icon={CircleCheck}>
            Everything due today is done.
          </EmptyState>
        )}
        {unfinished.length > 0 && (
          <Button size="sm" variant="ghost" icon={Archive} style={{ alignSelf: "flex-start", marginTop: 6 }} onClick={() => void finish([]).then(() => toast("Review saved"))}>
            Save review without moving
          </Button>
        )}
      </Section>
      <Section title={`Completed today · ${done?.length ?? 0}`}>
        {done?.length ? <MiniTaskList tasks={done} showDue={false} showProject /> : <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Nothing completed yet.</span>}
      </Section>
      <Section title="Next few days">
        {upcoming?.length ? <MiniTaskList tasks={upcoming} showProject /> : <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Nothing due in the next three days.</span>}
      </Section>
    </>
  );
}

function SnapList({ items }: { items: SnapshotTask[] }) {
  return (
    <div className="col">
      {items.map((t) => (
        <button key={t.id} type="button" className="mini-task" style={{ textAlign: "left" }} onClick={() => openTask(t.id)}>
          <span className="mini-task__title">{t.title}</span>
          {t.dueDate && <span className="mini-task__meta">{formatDue(t.dueDate)}</span>}
        </button>
      ))}
    </div>
  );
}

function HistoricView({ day, kind }: { day: string; kind: "morning" | "evening" }) {
  const { data: snap, isLoading } = useQuery({
    queryKey: ["snapshots", day, kind],
    queryFn: () => api.daily.getSnapshot<MorningSnapshot | EveningSnapshot>(day, kind),
  });
  if (isLoading) return <Skeleton height={80} />;
  if (!snap) return <EmptyState icon={History}>No {kind} snapshot was saved for this day.</EmptyState>;
  const banner = (
    <div className="snapshot-banner">
      <History size={14} /> Snapshot saved {format(new Date(snap.createdAt), "EEE d MMM, HH:mm")} - a historical record; tasks may have changed since.
    </div>
  );
  if (kind === "evening") {
    const d = snap.data as EveningSnapshot;
    return (
      <>
        {banner}
        <Section title={`Completed · ${d.completed.length}`}>
          <SnapList items={d.completed} />
        </Section>
        <Section title={`Moved to the next day · ${d.movedToTomorrow.length}`}>
          <SnapList items={d.movedToTomorrow} />
        </Section>
        <Section title={`Left unfinished · ${d.unfinished.length}`}>
          <SnapList items={d.unfinished} />
        </Section>
      </>
    );
  }
  const d = snap.data as MorningSnapshot;
  return (
    <>
      {banner}
      <p className="rundown__hero">{d.summary}</p>
      {d.suggested.length > 0 && (
        <Section title="Suggested order">
          {d.suggested.map((t, i) => (
            <button key={t.id} type="button" className="suggest" style={{ textAlign: "left", width: "100%" }} onClick={() => openTask(t.id)}>
              <span className="suggest__rank">{i + 1}</span>
              <div className="col grow">
                <span className="truncate">{t.title}</span>
                <span className="suggest__reasons">{t.reasons.join(" · ")}</span>
              </div>
            </button>
          ))}
        </Section>
      )}
      {d.overdue.length > 0 && (
        <Section title={`Overdue · ${d.overdue.length}`}>
          <SnapList items={d.overdue} />
        </Section>
      )}
      <Section title={`Scheduled · ${d.today.length}`}>
        <SnapList items={d.today} />
      </Section>
      {d.projects.length > 0 && (
        <Section title="Projects needing attention">
          {d.projects.map((p) => (
            <div key={p.id} className="mini-task">
              <span className="mini-task__title">{p.name}</span>
              <span className="mini-task__meta">{p.reasons.join(" · ")}</span>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

/** Catch up on a project from the rundown (recently active projects first). */
function CatchupMenu() {
  const { data: projects } = useProjects();
  const recent = [...(projects ?? [])].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)).slice(0, 12);
  if (!recent.length) return null;
  return (
    <Dropdown align="end" items={[{ type: "label", label: "Catch up on…" }, ...recent.map((p) => ({ label: p.name, onSelect: () => openCatchup(p.id) }))]}>
      <Button size="sm" variant="ghost" icon={Sparkles}>
        Catch up
      </Button>
    </Dropdown>
  );
}
