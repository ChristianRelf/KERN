/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// The weekly review: look back (what got done, what slipped, how time was
// spent, habits, estimates), tidy up (reschedule or drop slipped work, deal
// with the inbox and tasks that have gone quiet) and look ahead (pick what
// matters next week and note what you learned). The reflection is kept as a
// "weekly" snapshot of the week's first day, so past reviews stay readable.

import {
  ArrowRight,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Flame,
  Inbox,
  NotebookPen,
  Pin,
  Sparkles,
  Timer,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import type { Task, WeekReflection, WeekReview } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { addDaysStr, formatDue, formatDuration, parseDateStr, weekStartStr } from "@/lib/dates";
import { useToday } from "@/hooks/useToday";
import { useProjectMap } from "@/hooks/data";
import { useSetting } from "@/stores/settings";
import { navigate } from "@/stores/router";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox, EmptyState, Skeleton, TaskCheck } from "@/components/ui/Controls";
import { DuePopover } from "@/features/tasks/pickers";
import { openTask } from "@/features/tasks/menu";
import { toggleComplete, updateTask, updateTasks } from "@/features/tasks/actions";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { openAssist } from "@/features/assist/open";
import "./review.css";

const EMPTY: WeekReflection = { wins: "", lessons: "", focus: "", focusTaskIds: [], summary: null, doneAt: null };

function TaskLine({ t, children, done }: { t: Task; children?: React.ReactNode; done?: boolean }) {
  const projects = useProjectMap();
  const p = t.projectId ? projects.get(t.projectId) : undefined;
  return (
    <div className="review-task">
      <TaskCheck checked={done ?? t.status === "completed"} onToggle={() => void toggleComplete(t)} priority={t.priority} cancelled={!!t.resolution} />
      <button type="button" className="review-task__title truncate" onClick={() => openTask(t.id)}>
        {t.title}
      </button>
      {p && (
        <span className="review-task__project faint">
          <ProjectGlyph project={p} size={11} /> {p.name}
        </span>
      )}
      {children}
    </div>
  );
}

function Section({ icon: Icon, title, count, children, action }: { icon: typeof Inbox; title: string; count?: number; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="review-section">
      <div className="review-section__head">
        <Icon size={15} />
        <h2>{title}</h2>
        {count !== undefined && <span className="count">{count}</span>}
        <span className="spacer" />
        {action}
      </div>
      {children}
    </section>
  );
}

/** The first `n` items, with "Show all" for the rest. */
function Limited<T>({ items, n = 8, render }: { items: T[]; n?: number; render: (t: T) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, n);
  return (
    <>
      {shown.map(render)}
      {items.length > n && (
        <button type="button" className="review-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}

function useReflection(week: string) {
  const { data, isLoading } = useQuery({ queryKey: ["review", "reflection", week], queryFn: () => api.daily.getSnapshot<WeekReflection>(week, "weekly"), staleTime: Infinity });
  const [draft, setDraft] = useState<WeekReflection | null>(null);
  useEffect(() => setDraft(null), [week]);
  const value: WeekReflection = draft ?? { ...EMPTY, ...(data?.data ?? {}) };
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(value);
  latest.current = value;
  const persist = (v: WeekReflection) => api.daily.saveSnapshot(week, "weekly", v, true).then(() => queryClient.setQueryData(["review", "reflection", week], { day: week, kind: "weekly", data: v, createdAt: Date.now(), viewedAt: null }));
  const set = (patch: Partial<WeekReflection>, now = false) => {
    const next = { ...latest.current, ...patch };
    setDraft(next);
    window.clearTimeout(timer.current);
    const run = () => void persist(next).catch((e) => toastError(describeError(e, "Couldn't save the review.")));
    if (now) run();
    else timer.current = window.setTimeout(run, 600);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { value, set, loading: isLoading, saved: !!data };
}

export default function ReviewPage({ week: initial }: { week?: string }) {
  const today = useToday();
  const weekStartsOn = useSetting("tasks.weekStart");
  const week = initial ?? weekStartStr(today, weekStartsOn);
  const end = addDaysStr(week, 6);
  const isCurrent = today >= week && today <= end;
  const { data, isLoading } = useQuery({ queryKey: ["review", week, today], queryFn: () => api.review.week(week, today) });
  const r = useReflection(week);
  const go = (w: string) => navigate({ name: "review", week: w }, { replace: true });
  const nextWeekStart = addDaysStr(week, 7);

  const finish = async () => {
    r.set({ doneAt: Date.now(), completedCount: data?.completed.length ?? 0, slippedCount: data?.slipped.length ?? 0 }, true);
    if (r.value.focusTaskIds.length) await updateTasks(r.value.focusTaskIds, { pinned: true });
    toast("Weekly review done. Have a good week!");
  };

  const saveAsNote = async () => {
    const v = r.value;
    const md = [
      v.summary ? `${v.summary}\n` : "",
      `## Done (${data?.completed.length ?? 0})\n\n${(data?.completed ?? []).map((t) => `- [x] ${t.title}`).join("\n")}\n`,
      v.wins.trim() ? `## What went well\n\n${v.wins.trim()}\n` : "",
      v.lessons.trim() ? `## What I'd change\n\n${v.lessons.trim()}\n` : "",
      v.focus.trim() ? `## Focus for next week\n\n${v.focus.trim()}\n` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      const n = await api.notes.create({ title: `Weekly review · ${format(parseDateStr(week), "d MMM")}–${format(parseDateStr(end), "d MMM yyyy")}`, content: md });
      invalidate("notes", "recent");
      toast("Saved as a note", { action: { label: "Open", run: () => navigate({ name: "notes", id: n.id }) } });
    } catch (e) {
      toastError(describeError(e));
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <ClipboardCheck /> Weekly review
        </h1>
        <span className="page-header__sub">
          {format(parseDateStr(week), "d MMM")} – {format(parseDateStr(end), "d MMM yyyy")}
          {r.value.doneAt ? " · done" : ""}
        </span>
        <IconButton icon={ChevronLeft} label="Previous week" size="sm" onClick={() => go(addDaysStr(week, -7))} />
        <IconButton icon={ChevronRight} label="Next week" size="sm" disabled={nextWeekStart > today} onClick={() => go(nextWeekStart)} />
        {!isCurrent && (
          <Button size="sm" variant="ghost" onClick={() => go(weekStartStr(today, weekStartsOn))}>
            This week
          </Button>
        )}
        <div className="page-header__actions">
          <Button size="sm" variant="ghost" icon={NotebookPen} onClick={() => void saveAsNote()} disabled={!data}>
            Save as note
          </Button>
          <Button size="sm" variant={r.value.doneAt ? "default" : "primary"} icon={Check} onClick={() => void finish()} disabled={!data}>
            {r.value.doneAt ? "Done" : "Finish review"}
          </Button>
        </div>
      </header>
      <div className="page-body page-body--pad">
        <div className="review page-body--readable">
          {isLoading || !data ? <Skeleton height={200} /> : <Body data={data} today={today} week={week} reflection={r} />}
        </div>
      </div>
    </div>
  );
}

function Body({ data, today, week, reflection: r }: { data: WeekReview; today: string; week: string; reflection: ReturnType<typeof useReflection> }) {
  const nextMonday = addDaysStr(week, 7);
  const slippedIds = data.slipped.map((t) => t.id);
  const picks = new Set(r.value.focusTaskIds);
  const candidates = useMemo(() => {
    const seen = new Set<string>();
    return [...data.nextWeek, ...data.slipped].filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }, [data]);
  const est = data.estimates;
  const estLine = est.medianRatio !== null && est.count >= 2 ? (est.medianRatio > 1.15 ? `Tasks took about ${est.medianRatio.toFixed(1)}× their estimates.` : est.medianRatio < 0.85 ? `Tasks took about ${Math.round(est.medianRatio * 100)}% of their estimates.` : "Your estimates were about right.") : null;

  const summarise = () =>
    openAssist({
      input: { action: "weekly", weekStart: week, today },
      title: "Summarise my week",
      intro: "A short, honest summary of the week from the counts and task titles below. Nothing else is sent.",
      textActionLabel: "Use as summary",
      onText: (text) => r.set({ summary: text }, true),
    });

  return (
    <>
      <div className="rundown-stats" style={{ margin: 0 }}>
        <div className="stat">
          <span className="stat__value tabular">{data.completed.length}</span>
          <span className="stat__label">Done</span>
        </div>
        <div className="stat">
          <span className="stat__value tabular">{data.slipped.length}</span>
          <span className="stat__label">Slipped</span>
        </div>
        <div className="stat">
          <span className="stat__value tabular">{data.trackedMs ? formatDuration(data.trackedMs / 1000) : "–"}</span>
          <span className="stat__label">Tracked</span>
        </div>
        <div className="stat">
          <span className="stat__value tabular">{data.focusMinutes ? formatDuration(data.focusMinutes * 60) : "–"}</span>
          <span className="stat__label">Focus</span>
        </div>
        <div className="stat">
          <span className="stat__value tabular">{data.created}</span>
          <span className="stat__label">Added</span>
        </div>
      </div>

      <div className="review-summary">
        {r.value.summary ? (
          <p className="selectable">{r.value.summary}</p>
        ) : (
          <p className="faint">
            {data.completed.length
              ? `You finished ${data.completed.length} task${data.completed.length === 1 ? "" : "s"}${data.slipped.length ? ` and ${data.slipped.length} slipped` : ""}${data.cancelled ? `; ${data.cancelled} were dropped` : ""}.`
              : "A quiet week."}
            {estLine ? ` ${estLine}` : ""}
          </p>
        )}
        <Button size="sm" variant="ghost" icon={Sparkles} onClick={summarise}>
          {r.value.summary ? "Rewrite with AI" : "Summarise with AI"}
        </Button>
      </div>

      <Section icon={Check} title="Done this week" count={data.completed.length}>
        {data.completed.length ? <Limited items={data.completed} render={(t) => <TaskLine key={t.id} t={t} done />} /> : <EmptyState compact>Nothing completed this week yet.</EmptyState>}
      </Section>

      <Section
        icon={CalendarClock}
        title="Slipped"
        count={data.slipped.length}
        action={
          data.slipped.length > 1 && (
            <Button size="sm" variant="ghost" icon={ArrowRight} onClick={() => void updateTasks(slippedIds, { dueDate: nextMonday }, `Moved ${slippedIds.length} to next week`)}>
              Move all to next week
            </Button>
          )
        }
      >
        {data.slipped.length ? (
          <Limited
            items={data.slipped}
            render={(t) => (
              <TaskLine key={t.id} t={t}>
                <span className="faint review-task__when">{formatDue(t.dueDate, null, today)}</span>
                <span className="review-task__actions">
                  <Button size="sm" variant="ghost" onClick={() => void updateTask(t.id, { dueDate: nextMonday }, { undoLabel: "Moved to next week" })}>
                    Next week
                  </Button>
                  <DuePopover date={t.dueDate} onChange={(d, tm) => void updateTask(t.id, { dueDate: d, dueTime: tm }, { undoLabel: d ? `Moved to ${formatDue(d)}` : "Date removed" })} trigger={<Button size="sm" variant="ghost">Date…</Button>} />
                  <IconButton icon={X} label="Drop it (cancel)" size="sm" onClick={() => void updateTask(t.id, { status: "completed", resolution: "cancelled" }, { undoLabel: "Dropped" })} />
                </span>
              </TaskLine>
            )}
          />
        ) : (
          <EmptyState compact>Nothing slipped. Nice.</EmptyState>
        )}
        {data.olderOverdue > 0 && (
          <button type="button" className="review-more" onClick={() => navigate({ name: "tasks", view: "today" })}>
            {data.olderOverdue} more overdue from earlier weeks →
          </button>
        )}
      </Section>

      <Section
        icon={Inbox}
        title="Inbox"
        count={data.inboxItems.length + data.inboxTasks.length}
        action={
          data.inboxItems.length + data.inboxTasks.length > 0 && (
            <Button size="sm" variant="ghost" icon={ArrowRight} onClick={() => navigate({ name: "inbox" })}>
              Sort the inbox
            </Button>
          )
        }
      >
        {data.inboxItems.length + data.inboxTasks.length === 0 ? (
          <EmptyState compact>Inbox zero.</EmptyState>
        ) : (
          <p className="faint" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
            {data.inboxTasks.length} task{data.inboxTasks.length === 1 ? "" : "s"} and {data.inboxItems.length} idea{data.inboxItems.length === 1 ? "" : "s"} waiting to be organised
            {data.inboxItems.length ? `, the oldest from ${formatDue(new Date(Math.min(...data.inboxItems.map((i) => i.createdAt))).toISOString().slice(0, 10), null, today)}` : ""}.
          </p>
        )}
      </Section>

      {data.stale.length > 0 && (
        <Section icon={Clock} title="Gone quiet" count={data.stale.length}>
          <p className="faint" style={{ margin: "0 0 4px", fontSize: "var(--fs-xs)" }}>Open tasks nobody has touched in a month. Still worth doing?</p>
          <Limited
            items={data.stale}
            n={5}
            render={(t) => (
              <TaskLine key={t.id} t={t}>
                <span className="review-task__actions">
                  <Button size="sm" variant="ghost" onClick={() => void updateTask(t.id, { archived: true }, { undoLabel: "Archived" })}>
                    Archive
                  </Button>
                  <IconButton icon={X} label="Drop it (cancel)" size="sm" onClick={() => void updateTask(t.id, { status: "completed", resolution: "cancelled" }, { undoLabel: "Dropped" })} />
                </span>
              </TaskLine>
            )}
          />
        </Section>
      )}

      {(data.byProject.length > 0 || data.habits.length > 0 || est.count > 0) && (
        <div className="review-cols">
          {data.byProject.length > 0 && (
            <div className="panel">
              <div className="panel__title">
                <Timer size={13} /> Where the time went
              </div>
              {data.byProject.slice(0, 6).map((b) => (
                <div key={b.key ?? "none"} className="breakdown-row" style={{ cursor: "default" }}>
                  <span className="truncate grow">{b.label}</span>
                  <span className="faint tabular">{formatDuration(b.ms / 1000)}</span>
                  <span className="breakdown-row__bar" style={{ width: `${data.trackedMs ? (b.ms / data.trackedMs) * 100 : 0}%` }} aria-hidden />
                </div>
              ))}
            </div>
          )}
          {data.habits.length > 0 && (
            <div className="panel">
              <div className="panel__title">
                <Flame size={13} /> Habits
              </div>
              {data.habits.map((h) => (
                <div key={h.id} className="row" style={{ gap: 8, fontSize: "var(--fs-sm)", padding: "3px 0" }}>
                  <span className="truncate grow">{h.name}</span>
                  <span className="tabular" style={{ color: h.due && h.met >= h.due ? "var(--accent)" : "var(--text-2)" }}>
                    {h.met}/{h.due}
                  </span>
                </div>
              ))}
              <button type="button" className="review-more" onClick={() => navigate({ name: "habits" })}>
                Open habits →
              </button>
            </div>
          )}
          {est.count > 0 && (
            <div className="panel">
              <div className="panel__title">
                <Clock size={13} /> Estimates
              </div>
              <span style={{ fontSize: "var(--fs-sm)" }}>
                {formatDuration(est.totalActualMinutes * 60)} tracked against {formatDuration(est.totalEstimateMinutes * 60)} estimated across {est.count} task{est.count === 1 ? "" : "s"}.
              </span>
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                {est.onTarget} on target · {est.over} over · {est.under} under{estLine ? ` · ${estLine}` : ""}
              </span>
            </div>
          )}
        </div>
      )}

      <Section icon={Pin} title="Next week" count={data.nextWeek.length}>
        <p className="faint" style={{ margin: "0 0 4px", fontSize: "var(--fs-xs)" }}>Tick up to three to focus on. Finishing the review pins them.</p>
        {candidates.length ? (
          <Limited
            items={candidates}
            render={(t) => (
              <div key={t.id} className="review-task">
                <Checkbox
                  checked={picks.has(t.id)}
                  label={`Focus on ${t.title}`}
                  disabled={!picks.has(t.id) && picks.size >= 3}
                  onChange={(v) => r.set({ focusTaskIds: v ? [...r.value.focusTaskIds, t.id] : r.value.focusTaskIds.filter((x) => x !== t.id) }, true)}
                />
                <button type="button" className="review-task__title truncate" onClick={() => openTask(t.id)}>
                  {t.title}
                </button>
                <span className="faint review-task__when">{formatDue(t.dueDate, t.dueTime, today)}</span>
              </div>
            )}
          />
        ) : (
          <EmptyState compact>Nothing is due next week yet.</EmptyState>
        )}
        {data.milestones.length > 0 && (
          <div className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 6 }}>
            Milestones coming up: {data.milestones.map((m) => `${m.title} (${formatDue(m.targetDate, null, today)})`).join(" · ")}
          </div>
        )}
      </Section>

      <Section icon={NotebookPen} title="Reflection">
        <div className="review-reflect">
          <label className="field">
            <span className="field__label">What went well?</span>
            <textarea className="textarea" rows={3} value={r.value.wins} onChange={(e) => r.set({ wins: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">What would you change?</span>
            <textarea className="textarea" rows={3} value={r.value.lessons} onChange={(e) => r.set({ lessons: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">What matters most next week?</span>
            <textarea className="textarea" rows={3} value={r.value.focus} onChange={(e) => r.set({ focus: e.target.value })} />
          </label>
        </div>
      </Section>
      <span className="faint" style={{ fontSize: "var(--fs-2xs)" }}>Changes save as you go.</span>
    </>
  );
}
