import {
  Archive,
  ArchiveRestore,
  Copy,
  FolderInput,
  LayoutDashboard,
  Pencil,
  Pin,
  PinOff,
  Plus,
  SquareKanban,
  Trash,
  Presentation,
  Settings2,
  FolderOpen,
} from "lucide-react";
import { linkFolder } from "./folders";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import type { Project, ProjectGroup, ProjectInput, ProjectPatch } from "@/lib/types";
import { pushUndo } from "@/stores/undo";
import { toast, toastError } from "@/stores/toast";
import { navigate, useRouter } from "@/stores/router";
import { confirmDelete, prompt } from "@/components/ui/Dialog";
import type { MenuItems } from "@/components/ui/Menu";
import { openNewTask } from "@/features/tasks/creation";

const PROJECT_DOMAINS = ["projects", "project", "groups", "tasks", "board", "boards", "rundown", "stats", "recent", "whiteboards", "notes"] as const;
const refresh = () => invalidate(...PROJECT_DOMAINS);

export async function createProject(input: ProjectInput, open = true) {
  try {
    const p = await api.projects.create(input);
    refresh();
    if (open) navigate({ name: "project", id: p.id });
    return p;
  } catch (e) {
    toastError(describeError(e, "Couldn't create the project."));
    return null;
  }
}

export async function updateProject(id: string, patch: ProjectPatch, undo?: { label: string; inverse: ProjectPatch }) {
  try {
    const p = await api.projects.update(id, patch);
    refresh();
    if (undo)
      pushUndo(undo.label, async () => {
        await api.projects.update(id, undo.inverse);
        refresh();
      });
    return p;
  } catch (e) {
    toastError(describeError(e), () => void updateProject(id, patch, undo));
    return null;
  }
}

export async function renameProject(p: Project) {
  const name = await prompt({ title: "Rename project", initial: p.name, confirmLabel: "Rename" });
  if (name && name !== p.name) await updateProject(p.id, { name }, { label: "Renamed", inverse: { name: p.name } });
}

export async function archiveProject(p: Project, archived: boolean) {
  await updateProject(
    p.id,
    { archived },
    { label: archived ? `Archived ${p.name}` : `Restored ${p.name}`, inverse: { archived: !archived } },
  );
}

export async function duplicateProject(p: Project) {
  try {
    const copy = await api.projects.duplicate(p.id);
    refresh();
    pushUndo("Project duplicated", async () => {
      await api.projects.delete(copy.id);
      refresh();
    });
  } catch (e) {
    toastError(describeError(e, "Couldn't duplicate the project."));
  }
}

export async function deleteProject(p: Project) {
  const ok = await confirmDelete(
    `Delete “${p.name}”?`,
    `The project and its tasks move to the trash, where you can restore them.${p.folderPath ? " Its folder on disk is untouched." : ""}`,
  );
  if (!ok) return;
  try {
    await api.projects.delete(p.id);
    refresh();
    invalidate("trash");
    const r = useRouter.getState().route;
    if (r.name === "project" && r.id === p.id) navigate({ name: "projects" }, { replace: true });
    // A linked folder is never touched by deleting the project.
    pushUndo(`Moved ${p.name} to trash${p.folderPath ? " - its folder on disk is untouched" : ""}`, async () => {
      await api.projects.restore(p.id);
      refresh();
      invalidate("trash");
    });
  } catch (e) {
    toastError(describeError(e, "Couldn't delete the project."));
  }
}

export async function moveProjectToGroup(p: Project, groupId: string | null) {
  await updateProject(p.id, { groupId }, { label: "Moved", inverse: { groupId: p.groupId } });
}

export async function newGroup(projectToMove?: Project) {
  const name = await prompt({ title: "New project group", placeholder: "Group name", confirmLabel: "Create" });
  if (!name) return;
  try {
    const g = await api.groups.create(name);
    invalidate("groups");
    if (projectToMove) await moveProjectToGroup(projectToMove, g.id);
    else toast(`Created ${name}`);
  } catch (e) {
    toastError(describeError(e));
  }
}

export function projectMenu(p: Project, groups: ProjectGroup[]): MenuItems {
  return [
    { label: "Open", icon: LayoutDashboard, onSelect: () => navigate({ name: "project", id: p.id }) },
    { label: "Open board", icon: SquareKanban, onSelect: () => navigate({ name: "project", id: p.id, tab: "board" }) },
    { label: "Open whiteboard", icon: Presentation, onSelect: () => navigate({ name: "project", id: p.id, tab: "whiteboard" }) },
    { type: "separator" },
    {
      label: "New task",
      icon: Plus,
      onSelect: () => openNewTask({ projectId: p.id }),
    },
    { type: "separator" },
    { label: "Rename", icon: Pencil, onSelect: () => void renameProject(p) },
    {
      label: p.pinned ? "Unpin" : "Pin to sidebar",
      icon: p.pinned ? PinOff : Pin,
      onSelect: () => void updateProject(p.id, { pinned: !p.pinned }),
    },
    {
      type: "submenu",
      label: "Move to group",
      icon: FolderInput,
      items: [
        { label: "No group", checked: !p.groupId, onSelect: () => void moveProjectToGroup(p, null) },
        ...(groups.length ? [{ type: "separator" as const }] : []),
        ...groups.map((g) => ({
          label: g.name,
          checked: p.groupId === g.id,
          onSelect: () => void moveProjectToGroup(p, g.id),
        })),
        { type: "separator" },
        { label: "New group…", icon: Plus, onSelect: () => void newGroup(p) },
      ],
    },
    {
      label: p.folderPath ? "Change linked folder…" : "Link a folder…",
      icon: FolderOpen,
      onSelect: () => void linkFolder(p),
    },
    { label: "Project settings", icon: Settings2, onSelect: () => navigate({ name: "project", id: p.id, tab: "overview" }) },
    { label: "Duplicate", icon: Copy, onSelect: () => void duplicateProject(p) },
    {
      label: p.archivedAt ? "Unarchive" : "Archive",
      icon: p.archivedAt ? ArchiveRestore : Archive,
      onSelect: () => void archiveProject(p, !p.archivedAt),
    },
    { type: "separator" },
    { label: "Move to trash", icon: Trash, danger: true, onSelect: () => void deleteProject(p) },
  ];
}
