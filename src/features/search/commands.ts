import {
  Archive,
  CalendarDays,
  Columns3,
  DatabaseBackup,
  FolderPlus,
  Inbox,
  Keyboard,
  LayoutGrid,
  ListTodo,
  Moon,
  NotebookPen,
  PanelLeft,
  Pause,
  Pencil,
  Play,
  Plus,
  Presentation,
  Rows3,
  Search,
  Settings,
  SquareCheckBig,
  StickyNote,
  Sun,
  Sunrise,
  Sunset,
  Timer,
  Trash,
  FolderKanban,
  CalendarRange,
  MonitorCog,
  History,
  Hourglass,
  CircleStop,
  SquareTerminal,
  Sparkles,
  Flag,
  Radio,
  type LucideIcon,
  Minimize2,
  CalendarClock,
  ClipboardCheck,
  Repeat2,
  LayoutTemplate,
  Upload,
  Globe,
} from "lucide-react";
import { askAboutProject } from "@/features/projects/actions";
import { openTemplatePicker } from "@/features/templates/open";
import { openShare } from "@/features/share/open";
import { switchMode } from "@/app/mode";
import { navigate, useRouter } from "@/stores/router";
import { useUi } from "@/stores/ui";
import { getSetting, setSetting } from "@/stores/settings";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { prompt } from "@/components/ui/Dialog";
import { useFocus } from "@/features/focus/store";
import { useDashboardUi } from "@/features/dashboard/store";
import { openNewTask } from "@/features/tasks/creation";
import { useSessions } from "@/features/sessions/store";
import { startSession } from "@/features/sessions/SessionUi";
import { resumeWork } from "@/features/workspace/store";
import { openCatchup } from "@/features/catchup/open";
import { createMilestone } from "@/features/milestones/actions";

export interface Command {
  id: string;
  title: string;
  icon: LucideIcon;
  keywords?: string;
  shortcut?: string;
  section: "Create" | "Go to" | "Actions" | "Appearance";
  run: () => void | Promise<void>;
  /** Hidden from the empty-query suggestions. */
  hidden?: boolean;
}

export async function createNote(projectId?: string | null) {
  try {
    const n = await api.notes.create({ projectId: projectId ?? null });
    invalidate("notes");
    navigate({ name: "notes", id: n.id });
  } catch (e) {
    toastError(describeError(e, "Couldn't create the note."));
  }
}

export async function createWhiteboard(projectId?: string | null) {
  const name = await prompt({ title: "New whiteboard", placeholder: "Whiteboard name", confirmLabel: "Create" });
  if (!name) return;
  try {
    const w = await api.whiteboards.create(name, projectId ?? null);
    invalidate("whiteboards");
    navigate({ name: "whiteboard", id: w.id });
  } catch (e) {
    toastError(describeError(e, "Couldn't create the whiteboard."));
  }
}

/** The project currently open, if any. */
function currentProjectId(): string | null {
  const r = useRouter.getState().route;
  return r.name === "project" ? r.id : null;
}

export function getCommands(): Command[] {
  const ui = useUi.getState();
  const focus = useFocus.getState();
  const projectId = currentProjectId();
  const session = useSessions.getState().active;
  const cmds = [
    { id: "resumeWork", title: "Resume work", icon: History, section: "Go to", shortcut: "resumeWork", keywords: "continue last project workspace", run: () => void resumeWork() },
    session
      ? { id: "stopSession", title: `Stop session${session.taskTitle ? ` (${session.taskTitle})` : ""}`, icon: CircleStop, section: "Actions", keywords: "work timer time tracking", run: () => void useSessions.getState().stop() }
      : { id: "startSession", title: "Start work session", icon: Hourglass, section: "Actions", keywords: "work timer time tracking", run: () => void startSession({ projectId }) },
    { id: "sessions", title: "Open time reports", icon: Hourglass, section: "Go to", keywords: "sessions tracked hours", run: () => navigate({ name: "sessions" }) },
    { id: "toggleTerminal", title: "Toggle terminal", icon: SquareTerminal, section: "Actions", shortcut: "toggleTerminal", keywords: "shell console command line", run: () => void import("@/features/terminal/store").then((m) => m.toggleTerminal(projectId)) },
    projectId && { id: "catchup", title: "Catch up on this project", icon: Sparkles, section: "Actions", keywords: "summary what changed ai", run: () => openCatchup(projectId) },
    projectId && { id: "newMilestone", title: "Create milestone", icon: Flag, section: "Create", keywords: "release goal deadline", run: () => void createMilestone({ projectId }) },
    projectId && { id: "askProject", title: "Ask about this project", icon: Sparkles, section: "Actions", keywords: "ai question answer what why blocked", run: () => void api.projects.get(projectId).then((p) => askAboutProject(p)) },
    projectId && { id: "shareProject", title: "Share this project…", icon: Globe, section: "Actions", keywords: "link public roadmap read only", run: () => void api.projects.get(projectId).then((p) => openShare({ kind: "project", refId: p.id, title: p.name })) },
    { id: "newTaskTemplate", title: "Create task from template…", icon: LayoutTemplate, section: "Create", keywords: "checklist template", run: () => openTemplatePicker("task", projectId) },
    { id: "newNoteTemplate", title: "Create note from template…", icon: LayoutTemplate, section: "Create", keywords: "meeting notes template weekly plan", run: () => openTemplatePicker("note", projectId) },
    { id: "goPlanner", title: "Open day planner", icon: CalendarClock, section: "Go to", keywords: "time blocking schedule plan my day calendar", run: () => navigate({ name: "tasks", view: "plan" }) },
    { id: "goHabits", title: "Open habits", icon: Repeat2, section: "Go to", keywords: "streak routine daily", run: () => navigate({ name: "habits" }) },
    { id: "goReview", title: "Open weekly review", icon: ClipboardCheck, section: "Go to", keywords: "reflect week plan retrospective", run: () => navigate({ name: "review" }) },
    { id: "goCalendars", title: "Calendar subscriptions", icon: CalendarDays, section: "Go to", keywords: "google outlook ics ical", hidden: true, run: () => navigate({ name: "settings", section: "calendars" }) },
    { id: "importApps", title: "Import from Todoist, Trello, Linear or Notion", icon: Upload, section: "Actions", keywords: "migrate csv import", hidden: true, run: () => navigate({ name: "settings", section: "data" }) },
    { id: "newTask", title: "Create task", icon: Plus, section: "Create", shortcut: "newTask", keywords: "add new todo", run: () => openNewTask() },
    { id: "newNote", title: "Create note", icon: NotebookPen, section: "Create", shortcut: "newNote", keywords: "write", run: () => void createNote() },
    { id: "newProject", title: "Create project", icon: FolderPlus, section: "Create", shortcut: "newProject", run: () => ui.set({ createProjectOpen: true }) },
    { id: "newWhiteboard", title: "Create whiteboard", icon: Presentation, section: "Create", keywords: "canvas board", run: () => void createWhiteboard() },
    { id: "capture", title: "Quick capture", icon: StickyNote, section: "Create", shortcut: "quickCapture", keywords: "idea inbox", run: () => ui.openCapture() },

    { id: "goDashboard", title: "Open dashboard", icon: LayoutGrid, section: "Go to", shortcut: "goDashboard", keywords: "home", run: () => navigate({ name: "dashboard" }) },
    { id: "goTasks", title: "Open My Tasks", icon: SquareCheckBig, section: "Go to", shortcut: "goTasks", keywords: "list todo", run: () => navigate({ name: "tasks", view: "list" }) },
    { id: "goToday", title: "Open Today", icon: Sun, section: "Go to", run: () => navigate({ name: "tasks", view: "today" }) },
    { id: "goUpcoming", title: "Open Upcoming", icon: CalendarRange, section: "Go to", run: () => navigate({ name: "tasks", view: "upcoming" }) },
    { id: "goCalendar", title: "Open calendar", icon: CalendarDays, section: "Go to", keywords: "month schedule", run: () => navigate({ name: "tasks", view: "calendar" }) },
    { id: "goBoard", title: "Open task board", icon: Columns3, section: "Go to", keywords: "kanban status", run: () => navigate({ name: "tasks", view: "board" }) },
    { id: "goInbox", title: "Open Inbox", icon: Inbox, section: "Go to", shortcut: "goInbox", keywords: "capture unsorted", run: () => navigate({ name: "inbox" }) },
    { id: "goProjects", title: "Open projects", icon: FolderKanban, section: "Go to", shortcut: "goProjects", run: () => navigate({ name: "projects" }) },
    { id: "goWhiteboards", title: "Open whiteboards", icon: Presentation, section: "Go to", shortcut: "goWhiteboards", run: () => navigate({ name: "whiteboards" }) },
    { id: "goNotes", title: "Open notes", icon: StickyNote, section: "Go to", shortcut: "goNotes", run: () => navigate({ name: "notes" }) },
    { id: "searchNotes", title: "Search notes", icon: Search, section: "Go to", keywords: "find", run: () => navigate({ name: "search", q: "" }) },
    { id: "rundown", title: "Open today's rundown", icon: Sunrise, section: "Go to", shortcut: "rundown", keywords: "briefing morning daily summary", run: () => navigate({ name: "rundown" }) },
    { id: "evening", title: "Open evening review", icon: Sunset, section: "Go to", keywords: "review end of day", run: () => navigate({ name: "rundown", mode: "evening" }) },
    { id: "goTrash", title: "Open trash", icon: Trash, section: "Go to", keywords: "deleted restore", run: () => navigate({ name: "trash" }) },
    { id: "goStreams", title: "Open streams", icon: Radio, section: "Go to", keywords: "webhook form bug report endpoint cloud", run: () => navigate({ name: "streams" }) },
    { id: "goSettings", title: "Open settings", icon: Settings, section: "Go to", shortcut: "goSettings", keywords: "preferences options", run: () => navigate({ name: "settings" }) },

    focus.phase === "running"
      ? { id: "pauseFocus", title: "Pause focus session", icon: Pause, section: "Actions", run: () => focus.pause() }
      : focus.phase === "paused"
        ? { id: "resumeFocus", title: "Resume focus session", icon: Play, section: "Actions", run: () => focus.resume() }
        : { id: "startFocus", title: "Start focus session", icon: Timer, section: "Actions", keywords: "pomodoro timer", run: () => { focus.start({ kind: "focus" }); navigate({ name: "focus" }); } },
    { id: "focusMode", title: "Open focus mode", icon: Timer, section: "Actions", shortcut: "focusMode", run: () => navigate({ name: "focus" }) },
    { id: "kernLite", title: "Switch to Kern Lite", icon: Minimize2, section: "Actions", keywords: "lite mini compact simple task tracker small window", run: () => void switchMode("lite") },
    { id: "toggleSidebar", title: "Toggle sidebar", icon: PanelLeft, section: "Actions", shortcut: "toggleSidebar", run: () => void setSetting("appearance.sidebarCollapsed", !getSetting("appearance.sidebarCollapsed")) },
    {
      id: "editDashboard",
      title: "Edit dashboard layout",
      icon: Pencil,
      section: "Actions",
      keywords: "widgets customise",
      run: () => {
        navigate({ name: "dashboard" });
        useDashboardUi.getState().setEditing(true);
      },
    },
    {
      id: "backup",
      title: "Back up now",
      icon: DatabaseBackup,
      section: "Actions",
      keywords: "save export",
      run: async () => {
        try {
          const b = await api.data.backupCreate();
          invalidate("backups");
          toast(`Backed up to ${b.fileName}`);
        } catch (e) {
          toastError(describeError(e, "Backup failed."));
        }
      },
    },
    { id: "shortcuts", title: "Keyboard shortcuts", icon: Keyboard, section: "Actions", shortcut: "shortcuts", run: () => ui.set({ shortcutsOpen: true }) },
    { id: "archived", title: "Show archived projects", icon: Archive, section: "Go to", hidden: true, run: () => navigate({ name: "projects" }) },

    { id: "themeDark", title: "Theme: Dark", icon: Moon, section: "Appearance", keywords: "change theme", hidden: true, run: () => void setSetting("appearance.theme", "dark") },
    { id: "themeLight", title: "Theme: Light", icon: Sun, section: "Appearance", keywords: "change theme", hidden: true, run: () => void setSetting("appearance.theme", "light") },
    { id: "themeSystem", title: "Theme: Match system", icon: MonitorCog, section: "Appearance", keywords: "change theme", hidden: true, run: () => void setSetting("appearance.theme", "system") },
    { id: "densityCompact", title: "Density: Compact", icon: Rows3, section: "Appearance", hidden: true, run: () => void setSetting("appearance.density", "compact") },
    { id: "densityComfortable", title: "Density: Comfortable", icon: Rows3, section: "Appearance", hidden: true, run: () => void setSetting("appearance.density", "comfortable") },
    { id: "densityRelaxed", title: "Density: Relaxed", icon: Rows3, section: "Appearance", hidden: true, run: () => void setSetting("appearance.density", "relaxed") },
    { id: "listStyle", title: "Toggle task descriptions in lists", icon: ListTodo, section: "Appearance", hidden: true, run: () => void setSetting("appearance.taskRowStyle", getSetting("appearance.taskRowStyle") === "compact" ? "expanded" : "compact") },
  ].filter(Boolean) as Command[];
  return cmds;
}
