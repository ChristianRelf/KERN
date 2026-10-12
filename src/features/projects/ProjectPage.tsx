import {
  Activity as ActivityIcon,
  ArrowRight,
  Bookmark,
  Ellipsis,
  Eye,
  EyeOff,
  File,
  FileWarning,
  Flag,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Globe,
  History,
  LayoutDashboard,
  ListTodo,
  Plus,
  Presentation,
  Save,
  SquareKanban,
  SquareTerminal,
  StickyNote,
  Trash,
  Upload,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Project, ProjectTab, WorkspaceState } from "@/lib/types";
import { useAttachments, useGroups, useProject, useTasks } from "@/hooks/data";
import { useSetting } from "@/stores/settings";
import { navigate } from "@/stores/router";
import { useUi } from "@/stores/ui";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { ProjectGlyph } from "./ProjectGlyph";
import { projectMenu, updateProject } from "./actions";
import { TaskList, type TaskSection } from "@/features/tasks/TaskList";
import { ProjectBoard } from "@/features/boards/ProjectBoard";
import { formatBytes, relativeTime } from "@/lib/dates";
import { PageFallback } from "@/components/layout/PageFallback";
import { openNewTask } from "@/features/tasks/creation";
import { FolderBrowser, linkFolder } from "./folders";
import { RichLink } from "@/features/links/links";
import { addLinkAttachment } from "@/features/tasks/TaskDetail";
import { LINK_MIME } from "@/lib/types";
import { confirmDelete } from "@/components/ui/Dialog";
import { ActivityList } from "./activity";
import { CommandCentre } from "@/features/command-centre/CommandCentre";
import { MilestonesTab } from "@/features/milestones/MilestonesTab";
import { HealthBadge } from "@/features/health/Health";
import { useCapabilities } from "@/features/dev/hooks";
import { linkGithubRepository, linkLocalRepository } from "@/features/dev/Repositories";
import { toggleTerminal } from "@/features/terminal/store";
import { applySnapshot, flushWorkspaces, recordWorkspace, restoreContext, saveSnapshot, takeResumeRequest, useSnapshots, useWorkspaceState } from "@/features/workspace/store";

const ProjectWhiteboard = lazy(() => import("@/features/whiteboard/ProjectWhiteboard"));
const NotesPage = lazy(() => import("@/features/notes/NotesPage"));
const CodeTab = lazy(() => import("@/features/github/CodeTab").then((m) => ({ default: m.CodeTab })));

const TABS: { id: ProjectTab; label: string; icon: typeof ListTodo }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "board", label: "Board", icon: SquareKanban },
  { id: "whiteboard", label: "Whiteboard", icon: Presentation },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "milestones", label: "Milestones", icon: Flag },
  { id: "files", label: "Files", icon: File },
  { id: "code", label: "Code", icon: GitBranch },
  { id: "activity", label: "Activity", icon: ActivityIcon },
];

export function ProjectPage({ id, tab, boardId, whiteboardId, column }: { id: string; tab?: ProjectTab; boardId?: string; whiteboardId?: string; column?: string }) {
  const { data: p, isLoading, isError } = useProject(id);
  const { data: ws, isLoading: wsLoading } = useWorkspaceState(id);
  if (isLoading || wsLoading) return <PageFallback />;
  if (isError || !p || p.deletedAt)
    return (
      <div className="page">
        <EmptyState icon={FileWarning} title="This project isn't available" action={<Button onClick={() => navigate({ name: "projects" })}>All projects</Button>}>
          It may have been deleted.
        </EmptyState>
      </div>
    );
  return <ProjectView p={p} ws={ws ?? null} tab={tab} boardId={boardId} whiteboardId={whiteboardId} column={column} />;
}

function ProjectView({ p, ws, tab, boardId, whiteboardId, column }: { p: Project; ws: WorkspaceState | null; tab?: ProjectTab; boardId?: string; whiteboardId?: string; column?: string }) {
  const id = p.id;
  const { data: groups } = useGroups();
  const { data: caps } = useCapabilities(id);
  const defaultTab = useSetting("projects.defaultTab");
  const showFilesTab = useSetting("projects.showFilesTab");
  const resumeMode = useSetting("projects.resume");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  // Decided once per visit: was this a fresh open (no tab in the route)?
  const fresh = useRef(tab === undefined);
  const forced = useRef(takeResumeRequest(id));
  const resume = forced.current || (fresh.current && resumeMode === "resume");
  const [askResume, setAskResume] = useState(fresh.current && !forced.current && resumeMode === "ask" && !!ws?.tab);

  useEffect(() => {
    void api.projects.touch(id).then(() => invalidate("recent"));
    return () => flushWorkspaces();
  }, [id]);

  // Restore the rest of the context (open task, open file) once.
  useEffect(() => {
    if (resume && ws) void restoreContext(id, ws);
  }, []);

  // Remember the open task while working in this project.
  useEffect(
    () =>
      useUi.subscribe((s, prev) => {
        if (s.inspector === prev.inspector) return;
        recordWorkspace(id, { taskId: s.inspector?.kind === "task" ? s.inspector.id : null });
      }),
    [id],
  );
  useEffect(
    () =>
      useUi.subscribe((s, prev) => {
        if (s.openFile !== prev.openFile) recordWorkspace(id, { openFile: s.openFile?.projectId === id ? { rel: s.openFile.rel, repositoryId: s.openFile.repositoryId ?? null } : null });
      }),
    [id],
  );

  const hidden = new Set(p.hiddenTabs ?? []);
  // Code only appears once the project has something to show there.
  const hasCode = !!caps && (caps.repositories > 0 || caps.hasFolder || caps.issueSync);
  const visibleTabs = TABS.filter((t) => t.id === "overview" || (!hidden.has(t.id) && (t.id !== "files" || showFilesTab) && (t.id !== "code" || hasCode || tab === "code")));
  const lastTab = resumeMode === "resume" || resumeMode === "lastTab" || forced.current ? ws?.tab : undefined;
  const wanted: ProjectTab = tab ?? (resume || resumeMode === "lastTab" ? lastTab : undefined) ?? p.defaultView ?? (resumeMode === "overview" ? "overview" : defaultTab);
  const current = visibleTabs.some((t) => t.id === wanted) ? wanted : "overview";
  const board = boardId ?? (resume ? ws?.boardId ?? undefined : undefined);
  const wb = whiteboardId ?? (resume ? ws?.whiteboardId ?? undefined : undefined);
  const go = (t: ProjectTab) => navigate({ name: "project", id, tab: t }, { replace: true });

  useEffect(() => {
    recordWorkspace(id, { tab: current, ...(current === "board" && board ? { boardId: board } : {}), ...(current === "whiteboard" && wb ? { whiteboardId: wb } : {}) });
  }, [id, current, board, wb]);

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
    {
      type: "submenu",
      label: "Link code",
      icon: FolderGit2,
      items: [
        { label: "Local repository…", icon: FolderGit2, onSelect: () => void linkLocalRepository(p).then((r) => r && go("code")) },
        { label: "GitHub repository…", icon: Plus, onSelect: () => void linkGithubRepository(p).then((r) => r && go("code")) },
        ...(p.folderPath ? [] : [{ label: "Folder…", icon: FolderOpen, onSelect: () => void linkFolder(p) }]),
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
              <span className="tab__label">{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="page-header__actions">
          <HealthBadge project={p} />
          <WorkspaceMenu project={p} />
          {(p.folderPath || (caps?.localRepositories ?? 0) > 0) && <IconButton icon={SquareTerminal} label="Terminal" shortcut="Mod+`" onClick={() => toggleTerminal(id)} />}
          <IconButton icon={Plus} label="New task in project" onClick={() => openNewTask({ projectId: id })} />
          <Dropdown items={menu} align="end">
            <IconButton icon={Ellipsis} label="Project actions" noTooltip />
          </Dropdown>
        </div>
      </header>
      {askResume && ws && (
        <div className="resume-banner">
          <History size={14} />
          <span className="grow">Pick up where you left off{ws.savedAt ? ` (${relativeTime(ws.savedAt)})` : ""}?</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setAskResume(false);
              navigate({ name: "project", id, tab: ws.tab, boardId: ws.boardId ?? undefined, whiteboardId: ws.whiteboardId ?? undefined }, { replace: true });
              void restoreContext(id, ws);
            }}
          >
            Resume
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAskResume(false)}>
            Dismiss
          </Button>
        </div>
      )}
      {current === "overview" && <CommandCentre project={p} />}
      {current === "tasks" && <ProjectTasks projectId={id} />}
      {current === "board" && <ProjectBoard projectId={id} boardId={board} column={column} />}
      {current === "whiteboard" && (
        <Suspense fallback={<PageFallback />}>
          <ProjectWhiteboard projectId={id} whiteboardId={wb} />
        </Suspense>
      )}
      {current === "notes" && (
        <Suspense fallback={<PageFallback />}>
          <NotesPage projectId={id} embedded />
        </Suspense>
      )}
      {current === "milestones" && <MilestonesTab projectId={id} />}
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

/** Resume, save and switch between named workspace snapshots. */
function WorkspaceMenu({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const { data: snaps } = useSnapshots(project.id, open);
  const { data: ws } = useWorkspaceState(project.id);
  const items: MenuItems = [
    { type: "label", label: "Workspaces" },
    ...(snaps ?? []).map((s) => ({ label: s.name, icon: Bookmark, onSelect: () => void applySnapshot(s) })),
    !snaps?.length && { label: "No saved workspaces yet", disabled: true, onSelect: () => undefined },
    { type: "separator" },
    { label: "Save current workspace…", icon: Save, onSelect: () => void saveSnapshot(project.id, ws ?? {}) },
    (snaps?.length ?? 0) > 0 && {
      type: "submenu",
      label: "Update",
      items: (snaps ?? []).map((s) => ({ label: s.name, onSelect: () => void saveSnapshot(project.id, ws ?? {}, s) })),
    },
    (snaps?.length ?? 0) > 0 && {
      type: "submenu",
      label: "Delete",
      icon: Trash,
      items: (snaps ?? []).map((s) => ({
        label: s.name,
        onSelect: async () => {
          if (!(await confirmDelete(`Delete the “${s.name}” workspace?`, "Only the saved layout is removed."))) return;
          await api.workspace.deleteSnapshot(s.id).catch((e) => toastError(describeError(e)));
          invalidate("workspace");
        },
      })),
    },
  ];
  return (
    <span onPointerDown={() => setOpen(true)} onFocus={() => setOpen(true)}>
      <Dropdown items={items} align="end">
        <IconButton icon={Bookmark} label="Workspaces" noTooltip />
      </Dropdown>
    </span>
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
              onRemove={async () => {
                if (!(await confirmDelete(`Remove “${l.name}”?`, "Only the saved link is removed.", "Remove"))) return;
                await api.attachments.delete(l.id).then(() => invalidate("attachments"));
              }}
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
                  if (!(await confirmDelete(`Remove “${f.name}”?`, "Kern's stored copy of the file is deleted.", "Remove"))) return;
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

