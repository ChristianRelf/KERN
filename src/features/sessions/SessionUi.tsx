/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Work session interface: the compact sidebar pill and its panel, the gap
// prompt shown after sleep or a restart, and the start-session helper used
// from tasks, projects, the dashboard, the focus timer and the palette.

import { ChartColumn, CircleStop, FolderKanban, GitBranch, Hourglass, Pause, Play, SquareCheckBig, Timer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionInput } from "@/lib/types";
import { useNow } from "@/hooks/useToday";
import { useProjectMap } from "@/hooks/data";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, confirm } from "@/components/ui/Dialog";
import { Popover } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { navigate } from "@/stores/router";
import { openTask } from "@/features/tasks/menu";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { formatDuration } from "@/lib/dates";
import { formatElapsed, liveElapsed, useSessions } from "./store";

/** Starts a session, asking first if another one is running. */
export async function startSession(input: SessionInput) {
  const active = useSessions.getState().active;
  if (active) {
    const same = active.taskId && active.taskId === input.taskId;
    if (same) {
      useSessions.getState().setPanel(true);
      return active;
    }
    const ok = await confirm({
      title: "Stop the current session?",
      message: `${active.taskTitle ?? active.projectName ?? "The running session"} has been going for ${formatDuration(active.elapsedMs / 1000)}. It will be saved and a new one started.`,
      confirmLabel: "Stop and start new",
    });
    if (!ok) return null;
  }
  return useSessions.getState().start(input);
}

export function SessionPill({ collapsed }: { collapsed: boolean }) {
  const active = useSessions((s) => s.active);
  const fetchedAt = useSessions((s) => s.fetchedAt);
  const open = useSessions((s) => s.panelOpen);
  const setPanel = useSessions((s) => s.setPanel);
  const now = useNow(1000, active?.status === "running");
  if (!active) return null;
  const running = active.status === "running";
  const label = active.taskTitle ?? active.projectName ?? "Work session";
  const elapsed = formatElapsed(liveElapsed(active, fetchedAt, now));
  return (
    <Popover
      open={open}
      onOpenChange={setPanel}
      side="right"
      align="end"
      pad
      className="session-popover"
      trigger={
        <button type="button" className="focus-pill session-pill" data-paused={!running || undefined} aria-label={`Work session: ${label}, ${elapsed}${running ? "" : " (paused)"}`} style={collapsed ? { justifyContent: "center", padding: 0 } : undefined}>
          <Hourglass strokeWidth={1.75} />
          {!collapsed && (
            <>
              <span className="grow truncate" style={{ textAlign: "left" }}>
                {label}
              </span>
              <span style={{ opacity: running ? 1 : 0.55 }}>{elapsed}</span>
            </>
          )}
        </button>
      }
    >
      <SessionPanel onClose={() => setPanel(false)} />
    </Popover>
  );
}

function SessionPanel({ onClose }: { onClose: () => void }) {
  const s = useSessions();
  const a = s.active;
  const now = useNow(1000, a?.status === "running");
  const projectMap = useProjectMap();
  const [note, setNote] = useState(a?.note ?? "");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setNote(a?.note ?? ""), [a?.id]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!a) return <span className="faint">No session running.</span>;
  const project = a.projectId ? projectMap.get(a.projectId) : undefined;
  const running = a.status === "running";
  const saveNote = (v: string) => {
    setNote(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void s.update({ note: v }), 600);
  };
  return (
    <div className="session-panel">
      <div className="session-panel__clock" aria-live="off">
        {formatElapsed(liveElapsed(a, s.fetchedAt, now))}
        {!running && <span className="chip">Paused</span>}
      </div>
      <div className="col" style={{ gap: 4 }}>
        {a.taskTitle && (
          <button type="button" className="session-panel__link" onClick={() => a.taskId && (openTask(a.taskId), onClose())}>
            <SquareCheckBig size={13} /> <span className="truncate">{a.taskTitle}</span>
          </button>
        )}
        {project && (
          <button type="button" className="session-panel__link" onClick={() => (navigate({ name: "project", id: project.id }), onClose())}>
            <ProjectGlyph project={project} size={13} /> <span className="truncate">{project.name}</span>
          </button>
        )}
        {!a.taskTitle && !project && (
          <span className="faint row" style={{ gap: 6, fontSize: "var(--fs-sm)" }}>
            <FolderKanban size={13} /> No project
          </span>
        )}
        {(a.repositoryName || a.branch) && (
          <span className="faint row truncate" style={{ gap: 6, fontSize: "var(--fs-xs)" }}>
            <GitBranch size={12} />
            {[a.repositoryName, a.branch].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      <textarea className="textarea session-panel__note" rows={2} placeholder="Session note" value={note} onChange={(e) => saveNote(e.target.value)} aria-label="Session note" />
      <div className="row" style={{ gap: 6 }}>
        {running ? (
          <Button size="sm" icon={Pause} onClick={() => void s.pause()}>
            Pause
          </Button>
        ) : (
          <Button size="sm" icon={Play} onClick={() => void s.resume()}>
            Resume
          </Button>
        )}
        <Button
          size="sm"
          icon={CircleStop}
          onClick={async () => {
            window.clearTimeout(timer.current);
            const done = await s.stop(note);
            if (done) onClose();
          }}
        >
          Stop
        </Button>
        <span className="spacer" />
        <IconButton icon={ChartColumn} label="Time reports" size="sm" onClick={() => (navigate({ name: "sessions" }), onClose())} />
      </div>
    </div>
  );
}

/** Asks what to do with time that passed while the computer slept or Kern was closed. */
export function SessionGapHost() {
  const gap = useSessions((s) => s.gap);
  const resolve = useSessions((s) => s.resolveGap);
  if (!gap) return null;
  const away = formatDuration((gap.gapMs ?? 0) / 1000);
  const last = new Date(gap.lastSeenAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && void resolve("keep")}
      title="Were you still working?"
      centered
      footer={
        <>
          <Button variant="ghost" onClick={() => void resolve("end")}>
            End at {last}
          </Button>
          <Button onClick={() => void resolve("keep")}>Keep the time</Button>
          <Button variant="primary" autoFocus onClick={() => void resolve("exclude")}>
            Exclude {away}
          </Button>
        </>
      }
    >
      <p className="dialog__desc">
        Your session for <b>{gap.taskTitle ?? gap.projectName ?? "this work"}</b> was running, but Kern hasn't heard from you since {last} ({away} ago). The computer may have slept or Kern was closed.
      </p>
    </Dialog>
  );
}

/** Header button: start (or show) a session for a project or task. */
export function StartSessionButton({ projectId, taskId, label = "Start session", size = "sm" }: { projectId?: string | null; taskId?: string | null; label?: string; size?: "sm" | "md" }) {
  const active = useSessions((s) => s.active);
  const mine = active && ((taskId && active.taskId === taskId) || (!taskId && projectId && active.projectId === projectId && !active.taskId));
  return (
    <Tooltip content={mine ? "A session is running" : undefined} disabled={!mine}>
      <Button size={size} icon={mine ? Timer : Play} onClick={() => (mine ? useSessions.getState().setPanel(true) : void startSession({ projectId: projectId ?? null, taskId: taskId ?? null }))}>
        {mine ? "Session running" : label}
      </Button>
    </Tooltip>
  );
}
