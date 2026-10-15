/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Optional dashboard widgets for time, milestones and resuming work. None
// of them are on the default layouts; users add them if they want them.

import { Flag, History, Play } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { WidgetProps } from "../types";
import { api } from "@/lib/ipc";
import { useProjectMap, useProjects } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { addDaysStr, dayStartMs, formatDue, formatDuration, weekStartStr, relativeTime } from "@/lib/dates";
import { Button } from "@/components/ui/Button";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { navigate } from "@/stores/router";
import { openMilestone } from "@/features/milestones/actions";
import { MilestoneStatusIcon, milestoneLabel } from "@/features/milestones/MilestonesTab";
import { resumeProject, resumeWork } from "@/features/workspace/store";
import { startSession } from "@/features/sessions/SessionUi";
import { formatElapsed, liveElapsed, useSessions } from "@/features/sessions/store";
import { useNow } from "@/hooks/useToday";

export function TimeWidget(_: WidgetProps) {
  const today = useToday();
  const week = weekStartStr(today);
  const { data: day } = useQuery({ queryKey: ["sessions", "report", today, "day"], queryFn: () => api.sessions.report(dayStartMs(today), dayStartMs(addDaysStr(today, 1))) });
  const { data: wk } = useQuery({ queryKey: ["sessions", "report", week, "week"], queryFn: () => api.sessions.report(dayStartMs(week), dayStartMs(addDaysStr(week, 7))) });
  const active = useSessions((s) => s.active);
  const fetchedAt = useSessions((s) => s.fetchedAt);
  const now = useNow(1000, active?.status === "running");
  return (
    <div className="col" style={{ gap: 10, height: "100%" }}>
      <div className="rundown-stats" style={{ margin: 0 }}>
        <div className="stat">
          <span className="stat__value">{day ? formatDuration(day.totalMs / 1000) : "–"}</span>
          <span className="stat__label">Today</span>
        </div>
        <div className="stat">
          <span className="stat__value">{wk ? formatDuration(wk.totalMs / 1000) : "–"}</span>
          <span className="stat__label">This week</span>
        </div>
        <div className="stat">
          <span className="stat__value">{wk?.sessions ?? "–"}</span>
          <span className="stat__label">Sessions</span>
        </div>
      </div>
      {active ? (
        <button type="button" className="shortcut-tile" onClick={() => useSessions.getState().setPanel(true)}>
          <Play />
          <span className="grow truncate">{active.taskTitle ?? active.projectName ?? "Work session"}</span>
          <span className="tabular faint">{formatElapsed(liveElapsed(active, fetchedAt, now))}</span>
        </button>
      ) : (
        <Button size="sm" icon={Play} onClick={() => void startSession({})} style={{ alignSelf: "flex-start" }}>
          Start a session
        </Button>
      )}
      <div className="col" style={{ gap: 2, minHeight: 0, overflow: "auto" }}>
        {(wk?.byProject ?? []).slice(0, 5).map((b) => (
          <button key={b.key ?? "none"} type="button" className="breakdown-row" disabled={!b.key} onClick={() => b.key && navigate({ name: "sessions", projectId: b.key })}>
            <span className="truncate grow">{b.label}</span>
            <span className="faint tabular">{formatDuration(b.ms / 1000)}</span>
            <span className="breakdown-row__bar" style={{ width: `${wk && wk.totalMs ? (b.ms / wk.totalMs) * 100 : 0}%` }} aria-hidden />
          </button>
        ))}
      </div>
    </div>
  );
}

export type MilestonesWidgetConfig = { days: number };

export function MilestonesWidget({ config }: WidgetProps<MilestonesWidgetConfig>) {
  const today = useToday();
  const projectMap = useProjectMap();
  const { data } = useQuery({ queryKey: ["milestones", "upcoming", today, config.days], queryFn: () => api.milestones.upcoming(addDaysStr(today, config.days), 20) });
  if (!data) return <Skeleton height={60} />;
  if (!data.length)
    return (
      <EmptyState compact icon={Flag}>
        No milestones due in the next {config.days} days.
      </EmptyState>
    );
  return (
    <div className="col" style={{ gap: 2 }}>
      {data.map((m) => {
        const p = projectMap.get(m.projectId);
        return (
          <button key={m.id} type="button" className="ms-mini" onClick={() => openMilestone(m.id)}>
            <MilestoneStatusIcon m={m} size={13} />
            <span className="truncate grow">{milestoneLabel(m)}</span>
            {p && (
              <span className="row faint truncate" style={{ gap: 4, maxWidth: 120, fontSize: "var(--fs-xs)" }}>
                <ProjectGlyph project={p} size={11} /> {p.name}
              </span>
            )}
            <span className="ms-mini__bar" aria-hidden>
              <span style={{ width: `${Math.round(m.progress * 100)}%` }} />
            </span>
            <span className="faint ms-row__date" data-overdue={m.overdue || undefined}>
              {m.targetDate ? formatDue(m.targetDate) : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ResumeWidget(_: WidgetProps) {
  const { data: projects } = useProjects();
  const recent = [...(projects ?? [])].filter((p) => p.lastOpenedAt).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)).slice(0, 4);
  return (
    <div className="col" style={{ gap: 6 }}>
      <Button size="sm" variant="primary" icon={History} onClick={() => void resumeWork()} style={{ alignSelf: "flex-start" }}>
        Resume work
      </Button>
      {recent.map((p) => (
        <button key={p.id} type="button" className="shortcut-tile" onClick={() => void resumeProject(p.id)}>
          <ProjectGlyph project={p} size={15} />
          <span className="grow truncate">{p.name}</span>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {relativeTime(p.lastOpenedAt!)}
          </span>
        </button>
      ))}
      {!recent.length && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Open a project and Kern remembers where you were.</span>}
    </div>
  );
}
