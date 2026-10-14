// Project Command Centre widgets. Productivity widgets are part of every
// project; development widgets are separate (and lazy) so a personal
// project never loads or shows them unless the user adds them.

import {
  Activity,
  Bookmark,
  CalendarDays,
  ChartPie,
  CircleCheck,
  FileText,
  Flag,
  FolderGit2,
  FolderOpen,
  GitPullRequest,
  Globe,
  HeartPulse,
  Hourglass,
  Info,
  Link2,
  ListTodo,
  Pin,
  Play,
  Plus,
  Presentation,
  Server,
  Sparkles,
  SquareKanban,
  SquareTerminal,
  Workflow,
  X,
  FolderTree,
  Palette,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Milestone, ProjectTab, Task, Whiteboard } from "@/lib/types";
import type { WidgetDef, WidgetProps, WidgetConfig } from "@/features/dashboard/types";
import { api } from "@/lib/ipc";
import { useBoard, useBoards, useGroups, useNotes, useTasks, useWhiteboards } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { addDaysStr, dayStartMs, formatDue, formatDuration, relativeTime, weekStartStr } from "@/lib/dates";
import { navigate } from "@/stores/router";
import { useUi } from "@/stores/ui";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { EmptyState, Popover, Progress, Segmented, Select, Skeleton } from "@/components/ui/Controls";
import { prompt } from "@/components/ui/Dialog";
import { MiniTaskList } from "@/features/dashboard/MiniTaskList";
import { WhiteboardThumb } from "@/features/dashboard/widgets/ProjectWidgets";
import { DuePopover, FilterList } from "@/features/tasks/pickers";
import { createTask } from "@/features/tasks/actions";
import { openTask } from "@/features/tasks/menu";
import { createNote, createWhiteboard } from "@/features/search/commands";
import { createMilestone, openMilestone } from "@/features/milestones/actions";
import { UpcomingMilestones } from "@/features/milestones/MilestoneDetail";
import { MilestoneStatusIcon } from "@/features/milestones/MilestonesTab";
import { UnifiedActivity } from "@/features/projects/activity";
import { updateProject } from "@/features/projects/actions";
import { IconAccentPicker } from "@/features/projects/CreateProjectDialog";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { linkFolder } from "@/features/projects/folders";
import { openLink, normalizeUrl } from "@/features/links/links";
import { HealthPanel } from "@/features/health/Health";
import { openCatchup } from "@/features/catchup/open";
import { useGithubCached, useRepos } from "@/features/dev/hooks";
import { startSession } from "@/features/sessions/SessionUi";
import { formatElapsed, liveElapsed, useSessions } from "@/features/sessions/store";
import { useNow } from "@/hooks/useToday";
import { useProjectWidget } from "./context";

const ProjectAiSettings = lazy(() => import("@/features/ai/ProjectAiSettings").then((m) => ({ default: m.ProjectAiSettings })));

const muted = { fontSize: "var(--fs-sm)" } as const;

function def<C extends WidgetConfig>(d: WidgetDef<C>): WidgetDef {
  return d as unknown as WidgetDef;
}

/** Wraps a lazily-loaded widget body. */
function lazyBody(load: () => Promise<{ default: ComponentType }>): WidgetDef["Component"] {
  const L = lazy(load);
  return function LazyWidget() {
    return (
      <Suspense fallback={<Skeleton height={40} />}>
        <L />
      </Suspense>
    );
  };
}

const go = (id: string, tab: ProjectTab, extra?: { boardId?: string; whiteboardId?: string }) => navigate({ name: "project", id, tab, ...extra }, { replace: true });

// ------------------------------------------------------------ productivity

function ProgressBody() {
  const { project: p } = useProjectWidget();
  const pct = p.taskTotal ? p.taskDone / p.taskTotal : 0;
  const open = p.taskTotal - p.taskDone;
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="rundown-stats" style={{ margin: 0 }}>
        <div className="stat">
          <span className="stat__value">{Math.round(pct * 100)}%</span>
          <span className="stat__label">Complete</span>
        </div>
        <div className="stat">
          <span className="stat__value">
            {p.taskDone}
            <span className="faint">/{p.taskTotal}</span>
          </span>
          <span className="stat__label">Tasks done</span>
        </div>
        <button type="button" className="stat stat--btn" onClick={() => go(p.id, "tasks")}>
          <span className="stat__value">{open}</span>
          <span className="stat__label">Outstanding</span>
        </button>
        {p.taskOverdue > 0 && (
          <button type="button" className="stat stat--btn" data-warn onClick={() => go(p.id, "tasks")}>
            <span className="stat__value">{p.taskOverdue}</span>
            <span className="stat__label">Overdue</span>
          </button>
        )}
      </div>
      <Progress value={pct} />
      {!p.taskTotal && (
        <span className="faint" style={muted}>
          Progress comes from this project's tasks.
        </span>
      )}
    </div>
  );
}

type NextConfig = { max: number; order: "priority" | "due" | "manual" };

function NextTasksBody({ config }: WidgetProps<NextConfig>) {
  const { project: p } = useProjectWidget();
  const { data: tasks } = useTasks({ projectIds: [p.id], topLevelOnly: true, order: config.order, limit: config.max + 1, excludeStatuses: ["blocked"] });
  const [adding, setAdding] = useState("");
  const add = async () => {
    const title = adding.trim();
    if (!title) return;
    setAdding("");
    await createTask({ title, projectId: p.id, status: "todo" }, { quiet: true });
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      {!tasks ? (
        <Skeleton height={40} />
      ) : tasks.length ? (
        <MiniTaskList tasks={tasks} max={config.max} onMore={() => go(p.id, "tasks")} />
      ) : (
        <span className="faint" style={muted}>
          Nothing outstanding.
        </span>
      )}
      <div className="subtask-row">
        <Plus size={14} className="faint" />
        <input placeholder="Add a task" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} aria-label="Add a task" />
      </div>
    </div>
  );
}

function NextConfigForm({ config, setConfig }: { config: NextConfig; setConfig: (p: Partial<NextConfig>) => void }) {
  return (
    <div className="col" style={{ gap: 10, minWidth: 240 }}>
      <div className="row" style={{ justifyContent: "space-between", ...muted }}>
        <span className="muted">Order</span>
        <Segmented size="sm" value={config.order} onChange={(order) => setConfig({ order })} options={[{ value: "priority", label: "Priority" }, { value: "due", label: "Due" }, { value: "manual", label: "Manual" }]} />
      </div>
      <div className="row" style={{ justifyContent: "space-between", ...muted }}>
        <span className="muted">Show</span>
        <Segmented size="sm" value={String(config.max)} onChange={(v) => setConfig({ max: Number(v) })} options={[5, 8, 12, 20].map((n) => ({ value: String(n), label: String(n) }))} />
      </div>
    </div>
  );
}

function BoardPreviewBody() {
  const { project: p } = useProjectWidget();
  const { data: boards } = useBoards(p.id);
  const board = boards?.find((b) => b.isDefault) ?? boards?.[0];
  const { data } = useBoard(board?.id);
  const counts = useMemo(() => {
    if (!data) return [];
    const ids = new Set(data.columns.map((c) => c.id));
    const of = (t: Task) => (t.columnId && ids.has(t.columnId) ? t.columnId : data.columns.find((c) => c.status === t.status)?.id ?? data.columns[0]?.id);
    const open = data.tasks.filter((t) => !t.parentId);
    return data.columns.map((c) => ({ c, n: open.filter((t) => of(t) === c.id).length }));
  }, [data]);
  if (!boards) return <Skeleton height={40} />;
  if (!board) return <EmptyState compact icon={SquareKanban}>No board yet.</EmptyState>;
  const max = Math.max(1, ...counts.map((x) => x.n));
  return (
    <div className="col" style={{ gap: 4 }}>
      {counts.map(({ c, n }) => (
        <button key={c.id} type="button" className="board-col-row" onClick={() => navigate({ name: "project", id: p.id, tab: "board", boardId: board.id, column: c.id }, { replace: true })}>
          <span className="truncate grow">{c.name}</span>
          <span className="board-col-row__bar" aria-hidden>
            <span style={{ width: `${(n / max) * 100}%` }} />
          </span>
          <span className="tabular faint" style={{ width: 24, textAlign: "right" }}>
            {n}
          </span>
        </button>
      ))}
      {boards.length > 1 && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{board.name} · {boards.length} boards</span>}
    </div>
  );
}

type DeadlinesConfig = { days: number };

function DeadlinesBody({ config }: WidgetProps<DeadlinesConfig>) {
  const { project: p } = useProjectWidget();
  const today = useToday();
  const until = addDaysStr(today, config.days);
  const { data: tasks } = useTasks({ projectIds: [p.id], hasDue: true, dueTo: until, topLevelOnly: true, order: "due", limit: 30 });
  const { data: milestones } = useQuery({ queryKey: ["milestones", p.id], queryFn: () => api.milestones.list(p.id) });
  const ms = (milestones ?? []).filter((m) => (m.status === "planned" || m.status === "active") && m.targetDate && m.targetDate <= until);
  if (!tasks) return <Skeleton height={40} />;
  if (!tasks.length && !ms.length)
    return (
      <span className="faint" style={muted}>
        No deadlines in the next {config.days} days.
      </span>
    );
  return (
    <div className="col" style={{ gap: 4 }}>
      {ms.map((m) => (
        <button key={m.id} type="button" className="ms-mini" onClick={() => openMilestone(m.id)}>
          <MilestoneStatusIcon m={m} size={13} />
          <span className="truncate grow">{m.title}</span>
          <span className="faint ms-row__date" data-overdue={m.overdue || undefined}>
            {formatDue(m.targetDate)}
          </span>
        </button>
      ))}
      {tasks.length > 0 && <MiniTaskList tasks={tasks} max={10} onMore={() => go(p.id, "tasks")} />}
    </div>
  );
}

function RecentNotesBody() {
  const { project: p } = useProjectWidget();
  const { data: notes } = useNotes(p.id);
  const list = [...(notes ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  return (
    <div className="col" style={{ gap: 2 }}>
      {!notes ? (
        <Skeleton height={40} />
      ) : !list.length ? (
        <span className="faint" style={muted}>
          No notes yet.
        </span>
      ) : (
        list.map((n) => (
          <button key={n.id} type="button" className="note-mini" onClick={() => navigate({ name: "notes", id: n.id })}>
            {n.pinned ? <Pin size={13} className="faint" /> : <FileText size={13} className="faint" />}
            <span className="col grow" style={{ minWidth: 0 }}>
              <span className="truncate">{n.title || "Untitled"}</span>
              {n.excerpt && <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>{n.excerpt}</span>}
            </span>
            <span className="faint" style={{ fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>
              {relativeTime(n.updatedAt)}
            </span>
          </button>
        ))
      )}
      <button type="button" className="mini-more" onClick={() => void createNote(p.id)}>
        <Plus size={12} /> New note
      </button>
    </div>
  );
}

function WhiteboardBody() {
  const { project: p } = useProjectWidget();
  const { data: boards } = useWhiteboards(p.id);
  const latest = [...(boards ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const { data: scene } = useQuery({ queryKey: ["whiteboard", "preview", latest?.id], queryFn: () => api.whiteboards.preview(latest!.id), enabled: !!latest });
  if (!boards) return <Skeleton height={60} />;
  if (!latest)
    return (
      <EmptyState compact icon={Presentation} action={<Button size="sm" icon={Plus} onClick={() => void createWhiteboard(p.id)}>Create a whiteboard</Button>}>
        Sketch ideas and plans next to your tasks.
      </EmptyState>
    );
  return (
    <div className="col" style={{ height: "100%", gap: 6 }}>
      <div role="button" aria-label={`Open ${latest.name}`} style={{ flex: 1, minHeight: 0, cursor: "pointer" }} onClick={() => go(p.id, "whiteboard", { whiteboardId: latest.id })}>
        {scene ? <WhiteboardThumb scene={scene} /> : <Skeleton height={80} />}
      </div>
      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
        {(boards ?? []).slice(0, 4).map((w: Whiteboard) => (
          <button key={w.id} type="button" className="chip chip-btn" onClick={() => go(p.id, "whiteboard", { whiteboardId: w.id })}>
            {w.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function MilestonesBody() {
  const { project: p } = useProjectWidget();
  return (
    <div className="col" style={{ gap: 6 }}>
      <UpcomingMilestones projectId={p.id} max={6} />
      <div className="row" style={{ gap: 16 }}>
        <button type="button" className="mini-more" onClick={() => void createMilestone({ projectId: p.id })}>
          <Plus size={12} /> Milestone
        </button>
        <button type="button" className="mini-more" onClick={() => go(p.id, "milestones")}>
          All milestones
        </button>
      </div>
    </div>
  );
}

function ActivityBody() {
  const { project: p, caps } = useProjectWidget();
  const { data: github } = useGithubCached(p.id, !!caps?.githubRepositories);
  return <UnifiedActivity projectId={p.id} github={github} limit={14} />;
}

interface PinnedItem {
  kind: "note" | "task" | "board" | "whiteboard" | "milestone" | "link" | "folder" | "repo";
  id?: string;
  url?: string;
  title: string;
}
type PinnedConfig = { items: PinnedItem[] };

const PIN_ICONS: Record<PinnedItem["kind"], typeof Pin> = { note: FileText, task: CircleCheck, board: SquareKanban, whiteboard: Presentation, milestone: Flag, link: Globe, folder: FolderOpen, repo: FolderGit2 };

function PinnedBody({ config, setConfig }: WidgetProps<PinnedConfig>) {
  const { project: p } = useProjectWidget();
  const [picking, setPicking] = useState<PinnedItem["kind"] | null>(null);
  const items = config.items ?? [];
  const add = (it: PinnedItem) => setConfig({ items: [...items.filter((x) => !(x.kind === it.kind && x.id === it.id && x.url === it.url)), it] });
  const open = (it: PinnedItem) => {
    switch (it.kind) {
      case "note":
        return navigate({ name: "notes", id: it.id });
      case "task":
        return openTask(it.id!);
      case "board":
        return go(p.id, "board", { boardId: it.id });
      case "whiteboard":
        return go(p.id, "whiteboard", { whiteboardId: it.id });
      case "milestone":
        return openMilestone(it.id!);
      case "repo":
        return go(p.id, "code");
      case "folder":
        return void api.system.reveal(it.url!).catch(() => undefined);
      default:
        return void openLink(it.url!);
    }
  };
  return (
    <div className="col" style={{ gap: 2 }}>
      {items.map((it, i) => {
        const Icon = PIN_ICONS[it.kind];
        return (
          <div key={i} className="pinned-row">
            <button type="button" className="row grow" style={{ gap: 8, minWidth: 0 }} onClick={() => open(it)}>
              <Icon size={13} className="faint" />
              <span className="truncate">{it.title}</span>
            </button>
            <IconButton icon={X} label="Unpin" size="sm" onClick={() => setConfig({ items: items.filter((_, j) => j !== i) })} />
          </div>
        );
      })}
      {!items.length && (
        <span className="faint" style={muted}>
          Keep the notes, tasks, boards, links and folders you use most one click away.
        </span>
      )}
      <PinPicker projectId={p.id} kind={picking} onClose={() => setPicking(null)} onPick={add} />
      <Dropdown
        align="start"
        items={[
          { label: "Note…", icon: FileText, onSelect: () => setPicking("note") },
          { label: "Task…", icon: CircleCheck, onSelect: () => setPicking("task") },
          { label: "Board…", icon: SquareKanban, onSelect: () => setPicking("board") },
          { label: "Whiteboard…", icon: Presentation, onSelect: () => setPicking("whiteboard") },
          { label: "Milestone…", icon: Flag, onSelect: () => setPicking("milestone") },
          { type: "separator" },
          {
            label: "Link…",
            icon: Link2,
            onSelect: async () => {
              const raw = await prompt({ title: "Pin a link", placeholder: "https://…", confirmLabel: "Pin" });
              if (raw) add({ kind: "link", url: normalizeUrl(raw), title: raw.replace(/^https?:\/\//, "") });
            },
          },
          {
            label: "Folder…",
            icon: FolderOpen,
            onSelect: async () => {
              const { open } = await import("@tauri-apps/plugin-dialog");
              const f = await open({ directory: true, title: "Pin a folder" });
              if (typeof f === "string") add({ kind: "folder", url: f, title: f.split(/[\\/]/).filter(Boolean).pop() ?? f });
            },
          },
          { label: "Repository…", icon: FolderGit2, onSelect: () => setPicking("repo") },
        ]}
      >
        <button type="button" className="mini-more">
          <Plus size={12} /> Pin something
        </button>
      </Dropdown>
    </div>
  );
}

function PinPicker({ projectId, kind, onClose, onPick }: { projectId: string; kind: PinnedItem["kind"] | null; onClose: () => void; onPick: (it: PinnedItem) => void }) {
  const { data: notes } = useNotes(projectId);
  const { data: tasks } = useTasks({ projectIds: [projectId], topLevelOnly: true, order: "updated", limit: 200 }, { enabled: kind === "task" });
  const { data: boards } = useBoards(projectId);
  const { data: whiteboards } = useWhiteboards(projectId);
  const { data: milestones } = useQuery({ queryKey: ["milestones", projectId], queryFn: () => api.milestones.list(projectId), enabled: kind === "milestone" });
  const { data: repos } = useRepos(projectId, kind === "repo");
  const items: { id: string; title: string }[] =
    kind === "note"
      ? (notes ?? []).map((n: { id: string; title: string }) => ({ id: n.id, title: n.title || "Untitled" }))
      : kind === "task"
        ? (tasks ?? []).map((t) => ({ id: t.id, title: t.title }))
        : kind === "board"
          ? (boards ?? []).map((b) => ({ id: b.id, title: b.name }))
          : kind === "whiteboard"
            ? (whiteboards ?? []).map((w) => ({ id: w.id, title: w.name }))
            : kind === "milestone"
              ? (milestones ?? []).map((m: Milestone) => ({ id: m.id, title: m.title }))
              : kind === "repo"
                ? (repos ?? []).map((r) => ({ id: r.id, title: r.name }))
                : [];
  return (
    <Popover open={!!kind} onOpenChange={(o) => !o && onClose()} trigger={<span />}>
      <FilterList
        items={items}
        placeholder="Pin…"
        getKey={(i) => i.id}
        getText={(i) => i.title}
        onPick={(i) => {
          if (kind) onPick({ kind, id: i.id, title: i.title });
          onClose();
        }}
        render={(i) => <span className="truncate grow">{i.title}</span>}
      />
    </Popover>
  );
}

function SessionBody() {
  const { project: p } = useProjectWidget();
  const active = useSessions((s) => s.active);
  const fetchedAt = useSessions((s) => s.fetchedAt);
  const mine = active && active.projectId === p.id;
  const now = useNow(1000, !!mine && active?.status === "running");
  const today = useToday();
  const week = weekStartStr(today);
  const { data: wk } = useQuery({ queryKey: ["sessions", "report", week, p.id], queryFn: () => api.sessions.report(dayStartMs(week), dayStartMs(addDaysStr(week, 7)), p.id) });
  return (
    <div className="col" style={{ gap: 8 }}>
      {mine ? (
        <button type="button" className="session-mini" onClick={() => useSessions.getState().setPanel(true)}>
          <span className="session-mini__clock tabular">{formatElapsed(liveElapsed(active, fetchedAt, now))}</span>
          <span className="col grow" style={{ minWidth: 0 }}>
            <span className="truncate">{active.taskTitle ?? "Working on this project"}</span>
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
              {active.status === "paused" ? "Paused" : "Running"}
              {active.branch ? ` · ${active.branch}` : ""}
            </span>
          </span>
        </button>
      ) : (
        <Button size="sm" icon={Play} onClick={() => void startSession({ projectId: p.id })} style={{ alignSelf: "flex-start" }}>
          Start session
        </Button>
      )}
      <button type="button" className="row faint" style={{ gap: 6, ...muted }} onClick={() => navigate({ name: "sessions", projectId: p.id })}>
        <Hourglass size={13} /> {wk ? `${formatDuration(wk.totalMs / 1000)} this week across ${wk.sessions} session${wk.sessions === 1 ? "" : "s"}` : "…"}
      </button>
    </div>
  );
}

function HealthBody() {
  const { project: p } = useProjectWidget();
  return <HealthPanel project={p} />;
}

function CatchupBody() {
  const { project: p } = useProjectWidget();
  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="faint" style={muted}>
        {p.prevOpenedAt ? `Last here ${relativeTime(p.prevOpenedAt)}.` : "See what changed and what to do next."}
      </span>
      <Button size="sm" icon={Sparkles} onClick={() => openCatchup(p.id)} style={{ alignSelf: "flex-start" }}>
        Catch up
      </Button>
    </div>
  );
}

function AboutBody() {
  const { project: p } = useProjectWidget();
  const { data: groups } = useGroups();
  const [desc, setDesc] = useState(p.description);
  useEffect(() => setDesc(p.description), [p.description]);
  return (
    <div className="col" style={{ gap: 10 }}>
      <textarea
        className="overview-desc"
        placeholder="Add a description…"
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onBlur={() => desc !== p.description && void updateProject(p.id, { description: desc })}
        rows={Math.max(2, desc.split("\n").length)}
        aria-label="Project description"
      />
      <div className="props">
        <span className="props__label">Target date</span>
        <div>
          <DuePopover
            date={p.targetDate}
            withTime={false}
            onChange={(d) => void updateProject(p.id, { targetDate: d })}
            trigger={
              <button type="button" className="prop-btn" data-empty={!p.targetDate}>
                {p.targetDate ? formatDue(p.targetDate) : "None"}
              </button>
            }
          />
        </div>
        <span className="props__label">Group</span>
        <div>
          <Select value={p.groupId ?? "none"} onChange={(v) => void updateProject(p.id, { groupId: v === "none" ? null : v })} options={[{ value: "none", label: "No group" }, ...(groups ?? []).map((g) => ({ value: g.id, label: g.name }))]} />
        </div>
        <span className="props__label">Folder</span>
        <div style={{ minWidth: 0 }}>
          <button type="button" className="prop-btn" data-empty={!p.folderPath} onClick={() => (p.folderPath ? go(p.id, "files") : void linkFolder(p))}>
            <FolderOpen size={14} />
            <span className="truncate">{p.folderPath ? p.folderPath.split(/[\\/]/).filter(Boolean).pop() : "Link a folder…"}</span>
          </button>
        </div>
        <span className="props__label">AI</span>
        <div style={{ minWidth: 0 }}>
          <Suspense fallback={<Skeleton height={24} width={120} />}>
            <ProjectAiSettings project={p} />
          </Suspense>
        </div>
        <span className="props__label">Appearance</span>
        <div>
          <Popover
            pad
            trigger={
              <button type="button" className="prop-btn">
                <ProjectGlyph project={p} size={14} /> Icon & colour
              </button>
            }
          >
            <div className="col" style={{ width: 300, gap: 10 }}>
              <IconAccentPicker icon={p.icon} accent={p.accent} name={p.name} onChange={(c) => void updateProject(p.id, c)} />
              <Button size="sm" variant="ghost" icon={Palette} style={{ alignSelf: "flex-start" }} onClick={() => useUi.getState().set({ customizeProjectId: p.id })}>
                Customize project…
              </Button>
            </div>
          </Popover>
        </div>
        <span className="props__label">Created</span>
        <span className="faint">{relativeTime(p.createdAt)}</span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ registry

export const PROJECT_WIDGETS: WidgetDef[] = [
  def({ type: "p.progress", name: "Project Progress", description: "Completed and outstanding tasks.", icon: ChartPie, defaultConfig: {}, defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 3 }, Component: ProgressBody, single: true }),
  def<NextConfig>({ type: "p.next", name: "My Next Tasks", description: "The most relevant open tasks, with quick add.", icon: ListTodo, defaultConfig: { max: 8, order: "priority" }, defaultSize: { w: 6, h: 8 }, minSize: { w: 3, h: 3 }, Component: NextTasksBody, Config: NextConfigForm }),
  def({ type: "p.board", name: "Board Preview", description: "Cards per column; click a column to open it.", icon: SquareKanban, defaultConfig: {}, defaultSize: { w: 4, h: 5 }, minSize: { w: 3, h: 3 }, Component: BoardPreviewBody, single: true }),
  def<DeadlinesConfig>({
    type: "p.deadlines",
    name: "Upcoming Deadlines",
    description: "Due tasks and milestone targets.",
    icon: CalendarDays,
    defaultConfig: { days: 14 },
    defaultSize: { w: 4, h: 6 },
    minSize: { w: 3, h: 3 },
    Component: DeadlinesBody,
    Config: ({ config, setConfig }) => (
      <div className="row" style={{ justifyContent: "space-between", ...muted, gap: 12 }}>
        <span className="muted">Look ahead</span>
        <Segmented size="sm" value={String(config.days)} onChange={(v) => setConfig({ days: Number(v) })} options={[7, 14, 30, 90].map((d) => ({ value: String(d), label: `${d}d` }))} />
      </div>
    ),
    title: (c) => `Deadlines · ${c.days} days`,
  }),
  def({ type: "p.notes", name: "Recent Notes", description: "Recently edited notes in this project.", icon: FileText, defaultConfig: {}, defaultSize: { w: 4, h: 5 }, minSize: { w: 3, h: 3 }, Component: RecentNotesBody, single: true }),
  def({ type: "p.whiteboard", name: "Whiteboard", description: "A preview of the latest whiteboard.", icon: Presentation, defaultConfig: {}, defaultSize: { w: 4, h: 6 }, minSize: { w: 3, h: 3 }, Component: WhiteboardBody, single: true }),
  def({ type: "p.milestones", name: "Milestones", description: "Upcoming milestones and their progress.", icon: Flag, defaultConfig: {}, defaultSize: { w: 4, h: 5 }, minSize: { w: 3, h: 3 }, Component: MilestonesBody, single: true }),
  def({ type: "p.activity", name: "Recent Activity", description: "Tasks, notes, milestones and code events in one stream.", icon: Activity, defaultConfig: {}, defaultSize: { w: 4, h: 7 }, minSize: { w: 3, h: 3 }, Component: ActivityBody, single: true }),
  def<PinnedConfig>({ type: "p.pinned", name: "Pinned", description: "Notes, tasks, boards, links and folders you use most.", icon: Bookmark, defaultConfig: { items: [] }, defaultSize: { w: 4, h: 4 }, minSize: { w: 2, h: 2 }, Component: PinnedBody }),
  def({ type: "p.session", name: "Current Session", description: "The running work session and time this week.", icon: Hourglass, defaultConfig: {}, defaultSize: { w: 4, h: 3 }, minSize: { w: 3, h: 2 }, Component: SessionBody, single: true }),
  def({ type: "p.health", name: "Project Health", description: "What needs attention, with links to it.", icon: HeartPulse, defaultConfig: {}, defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 2 }, Component: HealthBody, single: true }),
  def({ type: "p.catchup", name: "Catch Up", description: "Summary of recent activity and next steps.", icon: Sparkles, defaultConfig: {}, defaultSize: { w: 3, h: 3 }, minSize: { w: 2, h: 2 }, Component: CatchupBody, single: true }),
  def({ type: "p.about", name: "Details", description: "Description, target date, folder, AI and appearance.", icon: Info, defaultConfig: {}, defaultSize: { w: 4, h: 7 }, minSize: { w: 3, h: 4 }, Component: AboutBody, single: true }),
];

export const DEV_WIDGETS: WidgetDef[] = [
  def({ type: "d.status", name: "Development Status", description: "Branch, uncommitted changes, last commit and builds.", icon: FolderTree, defaultConfig: {}, defaultSize: { w: 4, h: 6 }, minSize: { w: 3, h: 3 }, Component: lazyBody(() => import("@/features/dev/widgets").then((m) => ({ default: m.DevStatusWidget }))), single: true }),
  def({ type: "d.github", name: "GitHub Activity", description: "Pull requests, issues, builds and commits.", icon: GitPullRequest, defaultConfig: {}, defaultSize: { w: 6, h: 7 }, minSize: { w: 3, h: 4 }, Component: lazyBody(() => import("@/features/dev/widgets").then((m) => ({ default: m.GithubActivityWidget }))), single: true }),
  def({ type: "d.services", name: "Local Services", description: "Status of this project's local services.", icon: Server, defaultConfig: {}, defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 2 }, Component: lazyBody(() => import("@/features/dev/widgets").then((m) => ({ default: m.ServicesWidget }))), single: true }),
  def({ type: "d.commands", name: "Commands", description: "Pinned commands, one click to run.", icon: SquareTerminal, defaultConfig: {}, defaultSize: { w: 4, h: 4 }, minSize: { w: 3, h: 2 }, Component: lazyBody(() => import("@/features/dev/widgets").then((m) => ({ default: m.CommandsWidget }))), single: true }),
  def({ type: "d.repos", name: "Repositories", description: "Linked repositories and their state.", icon: FolderGit2, defaultConfig: {}, defaultSize: { w: 4, h: 5 }, minSize: { w: 3, h: 3 }, Component: lazyBody(() => import("@/features/dev/widgets").then((m) => ({ default: m.ReposWidget }))), single: true }),
  def({ type: "d.worktrees", name: "Worktrees", description: "Worktrees with their branches and tasks.", icon: Workflow, defaultConfig: {}, defaultSize: { w: 4, h: 5 }, minSize: { w: 3, h: 3 }, Component: lazyBody(() => import("@/features/dev/widgets").then((m) => ({ default: m.WorktreesWidget }))), single: true }),
];

export const PROJECT_WIDGET_MAP = new Map([...PROJECT_WIDGETS, ...DEV_WIDGETS].map((w) => [w.type, w]));

type Slot = { type: string; x: number; y: number; w: number; h: number };

export const PRESETS: { id: "general" | "development" | "hybrid"; name: string; description: string; slots: Slot[] }[] = [
  {
    id: "general",
    name: "General",
    description: "Tasks, deadlines, board, notes and activity.",
    slots: [
      { type: "p.next", x: 0, y: 0, w: 5, h: 8 },
      { type: "p.progress", x: 5, y: 0, w: 3, h: 4 },
      { type: "p.board", x: 8, y: 0, w: 4, h: 4 },
      { type: "p.deadlines", x: 5, y: 4, w: 3, h: 6 },
      { type: "p.milestones", x: 8, y: 4, w: 4, h: 4 },
      { type: "p.notes", x: 8, y: 8, w: 4, h: 5 },
      { type: "p.activity", x: 0, y: 8, w: 5, h: 7 },
      { type: "p.whiteboard", x: 5, y: 10, w: 3, h: 5 },
      { type: "p.about", x: 8, y: 13, w: 4, h: 7 },
    ],
  },
  {
    id: "development",
    name: "Development",
    description: "Tasks, git status, pull requests, builds and services.",
    slots: [
      { type: "p.next", x: 0, y: 0, w: 4, h: 8 },
      { type: "d.status", x: 4, y: 0, w: 4, h: 6 },
      { type: "p.health", x: 8, y: 0, w: 4, h: 4 },
      { type: "d.github", x: 4, y: 6, w: 4, h: 7 },
      { type: "d.services", x: 8, y: 4, w: 4, h: 4 },
      { type: "d.commands", x: 8, y: 8, w: 4, h: 4 },
      { type: "p.session", x: 0, y: 8, w: 4, h: 3 },
      { type: "d.worktrees", x: 0, y: 11, w: 4, h: 5 },
      { type: "p.activity", x: 8, y: 12, w: 4, h: 7 },
    ],
  },
  {
    id: "hybrid",
    name: "Hybrid",
    description: "A balance of planning and code.",
    slots: [
      { type: "p.next", x: 0, y: 0, w: 5, h: 8 },
      { type: "p.progress", x: 5, y: 0, w: 3, h: 4 },
      { type: "p.health", x: 8, y: 0, w: 4, h: 4 },
      { type: "d.status", x: 5, y: 4, w: 3, h: 6 },
      { type: "p.board", x: 8, y: 4, w: 4, h: 4 },
      { type: "p.deadlines", x: 8, y: 8, w: 4, h: 6 },
      { type: "d.github", x: 0, y: 8, w: 5, h: 7 },
      { type: "p.milestones", x: 5, y: 10, w: 3, h: 5 },
      { type: "p.activity", x: 8, y: 14, w: 4, h: 7 },
      { type: "p.about", x: 0, y: 15, w: 5, h: 7 },
    ],
  },
];

