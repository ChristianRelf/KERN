import {
  ExternalLink,
  GitBranch,
  Plus,
  RefreshCw,
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  CalendarDays,
  CircleCheck,
  CircleDashed,
  Copy,
  CopyPlus,
  Flag,
  FolderInput,
  Inbox,
  Pin,
  PinOff,
  Tag,
  Timer,
  Trash,
  Sun,
  Sunrise,
  CalendarClock,
  CalendarX,
  CircleDot,
  CircleSlash,
  Circle,
} from "lucide-react";
import type { MenuEntry, MenuItems } from "@/components/ui/Menu";
import { api, describeError } from "@/lib/ipc";
import { invalidate, invalidateTasks } from "@/lib/query";
import { slug } from "@/features/github/push";
import type { Label, Project, Task, TaskStatus } from "@/lib/types";
import { deleteTasks, duplicateTask, quickDates, rescheduleTasks, setCompleted, updateTask, updateTasks } from "./actions";
import { PRIORITY_LABELS, STATUS_LABELS } from "./meta";
import { useUi } from "@/stores/ui";
import { getSetting } from "@/stores/settings";
import { navigate } from "@/stores/router";
import { useFocus } from "@/features/focus/store";
import { nextWeekdayStr } from "@/lib/dates";
import { toast, toastError } from "@/stores/toast";

/** Opens task details according to the user's detail-mode preference. */
export function openTask(id: string) {
  const mode = getSetting("general.detailMode");
  if (mode === "modal") useUi.getState().set({ modalTaskId: id });
  else if (mode === "page") navigate({ name: "task", id });
  else useUi.getState().openInspector({ kind: "task", id });
}

export function startFocusOn(task: Pick<Task, "id" | "title">) {
  useFocus.getState().start({ kind: "focus", taskId: task.id, taskTitle: task.title });
  toast(`Focusing on “${task.title}”`);
}

const STATUS_ICONS = { inbox: Inbox, todo: Circle, in_progress: CircleDot, blocked: CircleSlash, completed: CircleCheck };

export function taskMenu(
  task: Task,
  ctx: { projects: Project[]; labels: Label[]; selection?: string[]; hideProject?: boolean },
): MenuItems {
  const ids = ctx.selection && ctx.selection.length > 1 && ctx.selection.includes(task.id) ? ctx.selection : [task.id];
  const multi = ids.length > 1;
  const d = quickDates();
  const done = task.status === "completed";
  return [
    !multi && { label: "Open", icon: ArrowUpRight, shortcut: "Enter", onSelect: () => openTask(task.id) },
    multi
      ? { label: `Complete ${ids.length} tasks`, icon: CircleCheck, onSelect: () => void updateTasks(ids, { status: "completed" }, `Completed ${ids.length} tasks`) }
      : { label: done ? "Mark incomplete" : "Complete", icon: CircleCheck, shortcut: "Space", onSelect: () => void setCompleted(task, !done) },
    { type: "separator" },
    {
      type: "submenu",
      label: "Due date",
      icon: CalendarDays,
      items: [
        { label: "Today", icon: Sun, shortcut: "T", onSelect: () => void rescheduleTasks(ids, d.today) },
        { label: "Tomorrow", icon: Sunrise, shortcut: "M", onSelect: () => void rescheduleTasks(ids, d.tomorrow) },
        { label: "Next week", icon: CalendarClock, onSelect: () => void rescheduleTasks(ids, nextWeekdayStr(d.today, 1)) },
        { label: "No date", icon: CalendarX, onSelect: () => void rescheduleTasks(ids, null) },
      ],
    },
    {
      type: "submenu",
      label: "Priority",
      icon: Flag,
      items: [4, 3, 2, 1, 0].map((p) => ({
        label: PRIORITY_LABELS[p],
        shortcut: String(p),
        checked: !multi && task.priority === p,
        onSelect: () => void updateTasks(ids, { priority: p }, multi ? "Priority changed" : undefined),
      })),
    },
    !multi && {
      type: "submenu",
      label: "Status",
      icon: CircleDashed,
      items: (["todo", "in_progress", "blocked", "completed"] as TaskStatus[]).map((s) => ({
        label: STATUS_LABELS[s],
        icon: STATUS_ICONS[s],
        checked: task.status === s,
        onSelect: () => void updateTask(task.id, { status: s }, { undoLabel: STATUS_LABELS[s] }),
      })),
    },
    !ctx.hideProject && {
      type: "submenu",
      label: "Move to project",
      icon: FolderInput,
      items: [
        { label: "Inbox (no project)", icon: Inbox, checked: !multi && !task.projectId, onSelect: () => void updateTasks(ids, { projectId: null }, "Moved to Inbox") },
        ...(ctx.projects.length ? [{ type: "separator" as const }] : []),
        ...ctx.projects.map((p) => ({
          label: p.name,
          checked: !multi && task.projectId === p.id,
          onSelect: () => void updateTasks(ids, { projectId: p.id }, `Moved to ${p.name}`),
        })),
      ],
    },
    ctx.labels.length > 0 && {
      type: "submenu",
      label: "Labels",
      icon: Tag,
      items: ctx.labels.map((l) => {
        const on = task.labelIds.includes(l.id);
        return {
          label: l.name,
          checked: !multi && on,
          onSelect: () =>
            void updateTasks(ids, multi || !on ? { addLabelIds: [l.id] } : { removeLabelIds: [l.id] }, multi ? `Labelled ${l.name}` : undefined),
        };
      }),
    },
    { type: "separator" },
    !multi && {
      label: task.pinned ? "Unpin" : "Pin",
      icon: task.pinned ? PinOff : Pin,
      onSelect: () => void updateTask(task.id, { pinned: !task.pinned }),
    },
    !multi && !done && { label: "Start focus session", icon: Timer, onSelect: () => startFocusOn(task) },
    !multi && { label: "Duplicate", icon: CopyPlus, shortcut: "Mod+D", onSelect: () => void duplicateTask(task.id) },
    !multi && githubSubmenu(task, ctx.projects.find((p) => p.id === task.projectId)),
    !multi && {
      label: "Copy title",
      icon: Copy,
      onSelect: () => void navigator.clipboard.writeText(task.title).then(() => toast("Copied")),
    },
    {
      label: task.archivedAt ? "Unarchive" : "Archive",
      icon: task.archivedAt ? ArchiveRestore : Archive,
      onSelect: () => void updateTasks(ids, { archived: !task.archivedAt }, task.archivedAt ? "Unarchived" : multi ? `Archived ${ids.length} tasks` : "Archived"),
    },
    { type: "separator" },
    {
      label: multi ? `Move ${ids.length} tasks to trash` : "Move to trash",
      icon: Trash,
      danger: true,
      shortcut: "Delete",
      onSelect: () => void deleteTasks(ids),
    },
  ];
}

/** GitHub issue and branch actions for a task in a connected / linked project. */
function githubSubmenu(task: Task, project: Project | undefined): MenuEntry | false {
  const items: MenuEntry[] = [];
  if (task.issue) {
    const issue = task.issue;
    items.push(
      { label: `Open issue #${issue.number}`, icon: ExternalLink, onSelect: () => void api.system.open(issue.url) },
      {
        label: "Sync with GitHub now",
        icon: RefreshCw,
        onSelect: () =>
          void api.github
            .syncTask(task.id)
            .then(() => (invalidateTasks(), toast("Synced with GitHub")))
            .catch((e) => toastError(describeError(e, "Couldn't sync."))),
      },
    );
  } else if (project?.githubRepo) {
    items.push({
      label: `Create issue in ${project.githubRepo}`,
      icon: Plus,
      onSelect: async () => {
        try {
          const url = await api.github.createIssue(task.id);
          invalidateTasks();
          toast("Issue created", { action: { label: "Open", run: () => void api.system.open(url) } });
        } catch (e) {
          toastError(describeError(e, "Couldn't create the issue."));
        }
      },
    });
  }
  if (project?.folderPath && project.folderTrust === "trusted") {
    const name = task.issue ? `${task.issue.number}-${slug(task.title)}` : `task/${slug(task.title) || "work"}`;
    items.push({
      label: "Create branch for this task",
      icon: GitBranch,
      onSelect: async () => {
        try {
          await api.git.switch(project.id, name, true);
          invalidate("git");
          toast(`Created and switched to ${name}`);
        } catch (e) {
          toastError(describeError(e, "Couldn't create the branch."));
        }
      },
    });
  }
  return items.length ? { type: "submenu", label: "GitHub & git", icon: GitBranch, items } : false;
}
