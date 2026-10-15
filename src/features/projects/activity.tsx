/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Project activity: Kern's own activity log, optionally merged with
// development events Kern already fetched (pull requests, workflow runs,
// commits) into one stream. Nothing here touches the network.

import {
  Activity as ActivityIcon,
  Archive,
  ArrowRight,
  CalendarDays,
  CircleCheck,
  CircleX,
  Flag,
  FolderOpen,
  GitCommitHorizontal,
  GitPullRequest,
  Pencil,
  Play,
  Plus,
  Trash,
} from "lucide-react";
import { useMemo } from "react";
import type { Activity, CachedGithub } from "@/lib/types";
import { useActivity } from "@/hooks/data";
import { relativeTime } from "@/lib/dates";
import { openTask } from "@/features/tasks/menu";
import { openLink } from "@/features/links/links";
import { navigate } from "@/stores/router";
import { useUi } from "@/stores/ui";

const ACTION_ICONS: Record<string, typeof Pencil> = {
  linked: FolderOpen,
  connected: FolderOpen,
  completed: CircleCheck,
  reopened: CircleCheck,
  cancelled: CircleX,
  unblocked: ArrowRight,
  moved: ArrowRight,
  rescheduled: CalendarDays,
  created: Plus,
  archived: Archive,
  unarchived: Archive,
  renamed: Pencil,
  deleted: Trash,
  started: Play,
};

const ACTION_TEXT: Record<string, string> = {
  linked: "Linked folder",
  connected: "Connected",
  completed: "Completed",
  reopened: "Reopened",
  cancelled: "Cancelled",
  unblocked: "Unblocked",
  moved: "Moved",
  rescheduled: "Rescheduled",
  created: "Created",
  archived: "Archived",
  unarchived: "Unarchived",
  renamed: "Renamed",
  deleted: "Deleted",
  started: "Started session on",
};

/** Where an activity entry leads when clicked. */
function openActivity(a: Activity) {
  switch (a.entityType) {
    case "task":
      if (a.action !== "deleted") openTask(a.entityId);
      break;
    case "note":
      navigate({ name: "notes", id: a.entityId });
      break;
    case "milestone":
      if (a.action !== "deleted") useUi.getState().openInspector({ kind: "milestone", id: a.entityId });
      break;
    case "project":
      navigate({ name: "project", id: a.entityId });
      break;
  }
}

export function ActivityRow({ a }: { a: Activity }) {
  const Icon = a.entityType === "milestone" ? Flag : ACTION_ICONS[a.action] ?? ActivityIcon;
  const kind = a.entityType === "task" || a.entityType === "session" || a.action === "linked" || a.action === "connected" ? "" : ` ${a.entityType}`;
  const clickable = ["task", "note", "milestone"].includes(a.entityType) && a.action !== "deleted";
  return (
    <div className="activity-item" data-clickable={clickable || undefined} onClick={() => clickable && openActivity(a)} role={clickable ? "button" : undefined}>
      <span className="activity-item__icon">
        <Icon />
      </span>
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="muted">
          {ACTION_TEXT[a.action] ?? a.action}
          {kind}
        </span>{" "}
        <span className="selectable">{a.summary}</span>
      </span>
      <span className="activity-item__time">{relativeTime(a.createdAt)}</span>
    </div>
  );
}

export function ActivityList({ projectId, limit = 100, full }: { projectId: string; limit?: number; full?: boolean }) {
  const { data } = useActivity(projectId, limit);
  const rows = data ?? [];
  const body = rows.length ? rows.map((a) => <ActivityRow key={a.id} a={a} />) : <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No activity yet.</span>;
  return full ? (
    <div className="page-body page-body--pad">
      <div style={{ maxWidth: 760 }}>{body}</div>
    </div>
  ) : (
    <div className="col">{body}</div>
  );
}

interface Event {
  key: string;
  at: number;
  node: React.ReactNode;
}

/** Kern activity merged with cached GitHub events, newest first. */
export function UnifiedActivity({ projectId, github, limit = 12 }: { projectId: string; github?: CachedGithub[]; limit?: number }) {
  const { data } = useActivity(projectId, limit);
  const events = useMemo(() => {
    const out: Event[] = (data ?? []).map((a) => ({ key: `a${a.id}`, at: a.createdAt, node: <ActivityRow a={a} /> }));
    for (const g of github ?? []) {
      for (const p of g.pulls ?? []) {
        const at = Date.parse(p.updatedAt);
        out.push({
          key: `p${g.repository}${p.number}`,
          at,
          node: <DevEvent icon={GitPullRequest} label={`Pull request #${p.number} updated`} text={p.title} at={at} url={p.htmlUrl} />,
        });
      }
      for (const r of (g.actions?.latest ?? []).filter((r) => r.conclusion === "failure")) {
        const at = Date.parse(r.createdAt);
        out.push({ key: `r${r.id}`, at, node: <DevEvent icon={CircleX} label={`${r.workflow} failed`} text={r.branch} at={at} url={r.htmlUrl} /> });
      }
      for (const c of (g.commits ?? []).slice(0, 8)) {
        const at = Date.parse(c.date);
        out.push({ key: `c${c.sha}`, at, node: <DevEvent icon={GitCommitHorizontal} label="Commit" text={c.subject} at={at} url={c.htmlUrl} /> });
      }
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  }, [data, github, limit]);
  if (!events.length) return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No activity yet.</span>;
  return (
    <div className="col">
      {events.map((e) => (
        <div key={e.key}>{e.node}</div>
      ))}
    </div>
  );
}

function DevEvent({ icon: Icon, label, text, at, url }: { icon: typeof Pencil; label: string; text: string; at: number; url: string }) {
  return (
    <div className="activity-item" data-clickable role="button" onClick={() => void openLink(url)}>
      <span className="activity-item__icon">
        <Icon />
      </span>
      <span className="grow truncate" style={{ minWidth: 0 }}>
        <span className="muted">{label}</span> <span>{text}</span>
      </span>
      <span className="activity-item__time">{Number.isFinite(at) ? relativeTime(at) : ""}</span>
    </div>
  );
}
