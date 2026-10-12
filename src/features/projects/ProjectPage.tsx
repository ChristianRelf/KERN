import {
  Activity as ActivityIcon,
  Archive,
  CalendarDays,
  CircleCheck,
  Ellipsis,
  Eye,
  EyeOff,
  File,
  FileText,
  FileWarning,
  FolderOpen,
  LayoutDashboard,
  ListTodo,
  Pencil,
  Plus,
  Presentation,
  SquareKanban,
  StickyNote,
  Trash,
  Upload,
  ArrowRight,
  Pin,
  Globe,
  GitBranch,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Activity, Project, ProjectTab } from "@/lib/types";
import { useActivity, useAttachments, useGroups, useNotes, useProject, useTasks, useWhiteboards } from "@/hooks/data";
import { useSetting } from "@/stores/settings";
import { navigate } from "@/stores/router";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { EmptyState, Progress, Select, Skeleton } from "@/components/ui/Controls";
import { ProjectGlyph } from "./ProjectGlyph";
import { projectMenu, updateProject } from "./actions";
import { IconAccentPicker } from "./CreateProjectDialog";
import { TaskList, type TaskSection } from "@/features/tasks/TaskList";
import { MiniTaskList } from "@/features/dashboard/MiniTaskList";
import { ProjectBoard } from "@/features/boards/ProjectBoard";
import { DuePopover } from "@/features/tasks/pickers";
import { addDaysStr, formatBytes, formatDue, relativeTime } from "@/lib/dates";
import { useToday } from "@/hooks/useToday";
import { createWhiteboard, createNote } from "@/features/search/commands";
import { Popover } from "@/components/ui/Controls";
import { PageFallback } from "@/components/layout/PageFallback";
import { openNewTask } from "@/features/tasks/creation";
import { FolderBrowser, ProjectFolderCard, linkFolder } from "./folders";

import { RichLink } from "@/features/links/links";

import { addLinkAttachment } from "@/features/tasks/TaskDetail";
import { LINK_MIME } from "@/lib/types";

const ProjectWhiteboard = lazy(() => import("@/features/whiteboard/ProjectWhiteboard"));
const NotesPage = lazy(() => import("@/features/notes/NotesPage"));
const CodeTab = lazy(() => import("@/features/github/CodeTab").then((m) => ({ default: m.CodeTab })));
const ProjectAiSettings = lazy(() => import("@/features/ai/ProjectAiSettings").then((m) => ({ default: m.ProjectAiSettings })));

const TABS: { id: ProjectTab; label: string; icon: typeof ListTodo }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "board", label: "Board", icon: SquareKanban },
  { id: "whiteboard", label: "Whiteboard", icon: Presentation },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "files", label: "Files", icon: File },
  { id: "code", label: "Code", icon: GitBranch },
  { id: "activity", label: "Activity", icon: ActivityIcon },
];

export function ProjectPage({ id, tab, boardId, whiteboardId }: { id: string; tab?: ProjectTab; boardId?: string; whiteboardId?: string }) {
  const { data: p, isLoading, isError } = useProject(id);
  const { data: groups } = useGroups();
  const defaultTab = useSetting("projects.defaultTab");
  const showFilesTab = useSetting("projects.showFilesTab");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    void api.projects.touch(id).then(() => invalidate("recent"));
  }, [id]);

  if (isLoading) return <PageFallback />;
  if (isError || !p || p.deletedAt)
    return (
      <div className="page">
        <EmptyState icon={FileWarning} title="This project isn't available" action={<Button onClick={() => navigate({ name: "projects" })}>All projects</Button>}>
          It may have been deleted.
        </EmptyState>
      </div>
    );

  const hidden = new Set(p.hiddenTabs ?? []);
  const visibleTabs = TABS.filter((t) => t.id === "overview" || (!hidden.has(t.id) && (t.id !== "files" || showFilesTab)));
  const active: ProjectTab = tab && visibleTabs.some((t) => t.id === tab) ? tab : (p.defaultView ?? defaultTab);
  const current = visibleTabs.some((t) => t.id === active) ? active : "overview";
  const go = (t: ProjectTab) => navigate({ name: "project", id, tab: t }, { replace: true });

  const toggleTab = (t: ProjectTab) => {
    const next = new Set(hidden);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    void updateProject(id, { hiddenTabs: [...next] });
  };

  const menu: MenuItems = [
    {
      type: "submenu",
      label: "Tabs",
      icon: Eye,
      items: TABS.filter((t) => t.id !== "overview").map((t) => ({
        label: t.label,
        checked: !hidden.has(t.id),
        onSelect: () => toggleTab(t.id),
      })),
    },
    {
      type: "submenu",
      label: "Open project on",
      icon: ArrowRight,
      items: [
        { label: `Default (${TABS.find((t) => t.id === defaultTab)?.label})`, checked: !p.defaultView, onSelect: () => void updateProject(id, { defaultView: null }) },
        ...TABS.map((t) => ({ label: t.label, checked: p.defaultView === t.id, onSelect: () => void updateProject(id, { defaultView: t.id }) })),
      ],
    },
    { type: "separator" },
    ...projectMenu(p, groups ?? []).slice(4),
  ];

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title" style={{ minWidth: 0 }}>
          <ProjectGlyph project={p} size={18} />
          {renaming ? (
            <input
              className="input input--bare"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setRenaming(false);
                if (name.trim() && name.trim() !== p.name) void updateProject(id, { name: name.trim() }, { label: "Renamed", inverse: { name: p.name } });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
              aria-label="Project name"
            />
          ) : (
            <span
              className="truncate"
              onDoubleClick={() => {
                setName(p.name);
                setRenaming(true);
              }}
              title="Double-click to rename"
            >
              {p.name}
            </span>
          )}
          {p.archivedAt && <span className="chip">Archived</span>}
        </h1>
        <nav className="page-header__nav tabs" aria-label="Project sections">
          {visibleTabs.map((t) => (
            <button key={t.id} type="button" className="tab" data-active={current === t.id} onClick={() => go(t.id)}>
              <t.icon strokeWidth={1.75} />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="page-header__actions">
          <IconButton icon={Plus} label="New task in project" onClick={() => openNewTask({ projectId: id })} />
          <Dropdown items={menu} align="end">
            <IconButton icon={Ellipsis} label="Project actions" noTooltip />
          </Dropdown>
        </div>
      </header>
      {current === "overview" && <Overview p={p} />}
      {current === "tasks" && <ProjectTasks projectId={id} />}
      {current === "board" && <ProjectBoard projectId={id} boardId={boardId} />}
      {current === "whiteboard" && (
        <Suspense fallback={<PageFallback />}>
          <ProjectWhiteboard projectId={id} whiteboardId={whiteboardId} />
        </Suspense>
      )}
      {current === "notes" && (
        <Suspense fallback={<PageFallback />}>
          <NotesPage projectId={id} embedded />
        </Suspense>
      )}
      {current === "files" && <Files project={p} />}
      {current === "code" && (
        <Suspense fallback={<PageFallback />}>
          <CodeTab project={p} />
        </Suspense>
      )}
      {current === "activity" && <ActivityList projectId={id} full />}
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ p }: { p: Project }) {
  const today = useToday();
  const [desc, setDesc] = useState(p.description);
  useEffect(() => setDesc(p.description), [p.description]);
  const { data: upcoming } = useTasks({ projectIds: [p.id], hasDue: true, dueTo: addDaysStr(today, 14), topLevelOnly: true, order: "due", limit: 12 });
  const { data: outstanding } = useTasks({ projectIds: [p.id], topLevelOnly: true, order: "priority", limit: 10 });
  const { data: notes } = useNotes(p.id);
  const { data: whiteboards } = useWhiteboards(p.id);
  const pinnedNotes = (notes ?? []).filter((n) => n.pinned);
  const pct = p.taskTotal ? p.taskDone / p.taskTotal : 0;
  const open = p.taskTotal - p.taskDone;
  const { data: groups } = useGroups();
  const showFolder = useSetting("projects.showFolderInOverview");

  return (
    <div className="page-body">
      <div className="overview">
        <div className="col" style={{ gap: 16 }}>
          {showFolder && p.folderPath && <ProjectFolderCard project={p} />}
          <div className="panel">
            <textarea
              className="overview-desc"
              placeholder="Add a description…"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onBlur={() => desc !== p.description && void updateProject(p.id, { description: desc })}
              rows={Math.max(2, desc.split("\n").length)}
              aria-label="Project description"
            />
            <div className="col" style={{ gap: 6, marginTop: 6 }}>
              <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
                <span className="muted">
                  {p.taskTotal ? `${p.taskDone} of ${p.taskTotal} tasks completed` : "No tasks yet"}
                  {p.taskOverdue > 0 && ` · ${p.taskOverdue} overdue`}
                </span>
                <span className="tabular" style={{ fontWeight: 600 }}>
                  {Math.round(pct * 100)}%
                </span>
              </div>
              <Progress value={pct} />
            </div>
          </div>

          <div className="panel">
            <div className="panel__title">
              <CircleCheck size={14} /> Outstanding <span className="faint tabular">{open}</span>
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => navigate({ name: "project", id: p.id, tab: "tasks" }, { replace: true })}>
                All tasks
              </Button>
            </div>
            {outstanding?.length ? (
              <MiniTaskList tasks={outstanding} max={8} />
            ) : (
              <EmptyState compact>
                Nothing outstanding.{" "}
                <button type="button" className="mini-more" onClick={() => openNewTask({ projectId: p.id })}>
                  Add a task
                </button>
              </EmptyState>
            )}
          </div>

          <div className="panel">
            <div className="panel__title">
              <CalendarDays size={14} /> Upcoming deadlines
            </div>
            {upcoming?.length ? <MiniTaskList tasks={upcoming} /> : <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No deadlines in the next two weeks.</span>}
          </div>

          <div className="panel">
            <div className="panel__title">
              <ActivityIcon size={14} /> Recent activity
              <span className="spacer" />
              <Button size="sm" variant="ghost" onClick={() => navigate({ name: "project", id: p.id, tab: "activity" }, { replace: true })}>
                View all
              </Button>
            </div>
            <ActivityList projectId={p.id} limit={6} />
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="panel">
            <div className="panel__title">Shortcuts</div>
            <button type="button" className="shortcut-tile" onClick={() => navigate({ name: "project", id: p.id, tab: "board" }, { replace: true })}>
              <SquareKanban />
              <span className="grow">Board</span>
              <ArrowRight size={14} />
            </button>
            <button
              type="button"
              className="shortcut-tile"
              onClick={() => (whiteboards?.length ? navigate({ name: "project", id: p.id, tab: "whiteboard" }, { replace: true }) : void createWhiteboard(p.id))}
            >
              <Presentation />
              <span className="grow">{whiteboards?.length ? `Whiteboard${whiteboards.length > 1 ? `s (${whiteboards.length})` : ""}` : "Create a whiteboard"}</span>
              <ArrowRight size={14} />
            </button>
          </div>

          <div className="panel">
            <div className="panel__title">
              <Pin size={14} /> Pinned notes
              <span className="spacer" />
              <IconButton icon={Plus} label="New note" size="sm" onClick={() => void createNote(p.id)} />
            </div>
            {pinnedNotes.length ? (
              pinnedNotes.map((n) => (
                <button key={n.id} type="button" className="shortcut-tile" onClick={() => navigate({ name: "notes", id: n.id })}>
                  <FileText />
                  <span className="col grow" style={{ minWidth: 0 }}>
                    <span className="truncate">{n.title || "Untitled"}</span>
                    {n.excerpt && <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>{n.excerpt}</span>}
                  </span>
                </button>
              ))
            ) : (
              <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Pin a note in this project to keep it here.</span>
            )}
          </div>

          <div className="panel">
            <div className="panel__title">Details</div>
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
                <Select
                  value={p.groupId ?? "none"}
                  onChange={(v) => void updateProject(p.id, { groupId: v === "none" ? null : v })}
                  options={[{ value: "none", label: "No group" }, ...(groups ?? []).map((g) => ({ value: g.id, label: g.name }))]}
                />
              </div>
              <span className="props__label">Folder</span>
              <div style={{ minWidth: 0 }}>
                <button type="button" className="prop-btn" data-empty={!p.folderPath} onClick={() => (p.folderPath ? navigate({ name: "project", id: p.id, tab: "files" }, { replace: true }) : void linkFolder(p))}>
                  <FolderOpen size={14} />
                  <span className="truncate">{p.folderPath ? folderName(p.folderPath) : "Link a folder…"}</span>
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
                  <div style={{ width: 280 }}>
                    <IconAccentPicker icon={p.icon} accent={p.accent} name={p.name} onChange={(c) => void updateProject(p.id, c)} />
                  </div>
                </Popover>
              </div>
              <span className="props__label">Created</span>
              <span className="faint">{relativeTime(p.createdAt)}</span>
            </div>
            {p.archivedAt && (
              <Button size="sm" icon={Archive} onClick={() => void updateProject(p.id, { archived: false })}>
                Unarchive project
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- tasks tab

function ProjectTasks({ projectId }: { projectId: string }) {
  const [showDone, setShowDone] = useState(false);
  const { data: open } = useTasks({ projectIds: [projectId], topLevelOnly: true, order: "manual" });
  const { data: done } = useTasks({ projectIds: [projectId], topLevelOnly: true, statuses: ["completed"], order: "completed", limit: 200 }, { enabled: showDone });
  const sections: TaskSection[] = [{ key: "open", tasks: open ?? [], addDefaults: { projectId, status: "todo" }, collapsible: false }];
  if (showDone && done?.length) sections.push({ key: "done", title: "Completed", tasks: done });
  return (
    <>
      <div className="toolbar">
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          {open?.length ?? 0} open
        </span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon={showDone ? EyeOff : Eye} onClick={() => setShowDone(!showDone)}>
          {showDone ? "Hide completed" : "Show completed"}
        </Button>
      </div>
      <TaskList sections={sections} sortable hideProject quickAddPosition="top" />
    </>
  );
}

// ---------------------------------------------------------------- files tab

function Files({ project }: { project: Project }) {
  const projectId = project.id;
  const { data: all } = useAttachments({ projectId });
  const files = all?.filter((a) => a.mime !== LINK_MIME);
  const links = all?.filter((a) => a.mime === LINK_MIME) ?? [];
  const add = async () => {
    const picked = await openDialog({ multiple: true, title: "Add files to project" });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const p of paths) {
      try {
        await api.attachments.add(p, { projectId }, true);
      } catch (e) {
        toastError(describeError(e, "Couldn't add the file."));
      }
    }
    invalidate("attachments");
  };
  return (
    <div className="page-body page-body--pad">
      {project.folderPath ? (
        <section style={{ marginBottom: 28 }}>
          <FolderBrowser project={project} />
        </section>
      ) : (
        <button type="button" className="folder-field folder-field--empty" style={{ marginBottom: 24 }} onClick={() => void linkFolder(project)}>
          <FolderOpen size={15} strokeWidth={1.75} />
          <span className="grow">Link a folder on this computer to browse its files here…</span>
        </button>
      )}
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="section-title">
          Links <span className="count">{links.length}</span>
        </span>
        <span className="spacer" />
        <Button size="sm" icon={Globe} onClick={() => void addLinkAttachment({ projectId })}>
          Add link
        </Button>
      </div>
      <div className="rich-link-list" style={{ marginBottom: 24 }}>
        {links.length ? (
          links.map((l) => (
            <RichLink
              key={l.id}
              url={l.path}
              title={l.name}
              size="lg"
              onRename={(name) => void api.attachments.rename(l.id, name).then(() => invalidate("attachments"))}
              onRemove={() => void api.attachments.delete(l.id).then(() => invalidate("attachments"))}
            />
          ))
        ) : (
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            Keep the project's important web pages here — docs, repositories, designs.
          </span>
        )}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="section-title">
          Attached files <span className="count">{files?.length ?? 0}</span>
        </span>
        <span className="spacer" />
        <Button size="sm" icon={Upload} onClick={() => void add()}>
          Add files
        </Button>
      </div>
      {!files ? (
        <Skeleton height={40} />
      ) : files.length === 0 ? (
        <div className="drop-zone">Files you add are copied into {"the app's"} storage and included in backups.</div>
      ) : (
        files.map((f) => (
          <div key={f.id} className="file-row" style={!f.exists ? { color: "var(--text-3)" } : undefined}>
            {f.exists ? <File size={15} className="faint" /> : <FileWarning size={15} className="faint" />}
            <button type="button" className="truncate" style={{ textAlign: "left" }} onClick={() => f.exists && void api.system.open(f.absPath)}>
              {f.name}
            </button>
            <span className="faint">{relativeTime(f.createdAt)}</span>
            <span className="faint tabular">{f.exists ? formatBytes(f.size) : "Missing"}</span>
            <span className="row" style={{ gap: 0, justifyContent: "flex-end" }}>
              {f.exists && <IconButton icon={FolderOpen} label="Show in folder" size="sm" onClick={() => void api.system.reveal(f.absPath)} />}
              <IconButton
                icon={Trash}
                label="Remove file"
                size="sm"
                onClick={async () => {
                  await api.attachments.delete(f.id);
                  invalidate("attachments");
                }}
              />
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------- activity

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

const ACTION_ICONS: Record<string, typeof Pencil> = {
  linked: FolderOpen,
  completed: CircleCheck,
  reopened: CircleCheck,
  moved: ArrowRight,
  rescheduled: CalendarDays,
  created: Plus,
  archived: Archive,
  unarchived: Archive,
  renamed: Pencil,
  deleted: Trash,
};

const ACTION_TEXT: Record<string, string> = {
  linked: "Linked folder",
  completed: "Completed",
  reopened: "Reopened",
  moved: "Moved",
  rescheduled: "Rescheduled",
  created: "Created",
  archived: "Archived",
  unarchived: "Unarchived",
  renamed: "Renamed",
  deleted: "Deleted",
};

function ActivityRow({ a }: { a: Activity }) {
  const Icon = ACTION_ICONS[a.action] ?? ActivityIcon;
  const kind = a.entityType === "task" || a.action === "linked" ? "" : ` ${a.entityType}`;
  return (
    <div className="activity-item">
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

function ActivityList({ projectId, limit = 100, full }: { projectId: string; limit?: number; full?: boolean }) {
  const { data } = useActivity(projectId, limit);
  const grouped = useMemo(() => data ?? [], [data]);
  const body = grouped.length ? (
    grouped.map((a) => <ActivityRow key={a.id} a={a} />)
  ) : (
    <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No activity yet.</span>
  );
  return full ? (
    <div className="page-body page-body--pad">
      <div style={{ maxWidth: 760 }}>{body}</div>
    </div>
  ) : (
    <div className="col">{body}</div>
  );
}
