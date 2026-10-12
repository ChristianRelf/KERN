import { Copy, Download, FolderInput, Pencil, Pin, PinOff, Presentation, Trash } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Project, Whiteboard } from "@/lib/types";
import type { MenuItems } from "@/components/ui/Menu";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { navigate, useRouter } from "@/stores/router";
import { pushUndo } from "@/stores/undo";
import { toast, toastError } from "@/stores/toast";
import { prompt } from "@/components/ui/Dialog";

const refresh = () => invalidate("whiteboards", "whiteboard", "recent", "trash");

async function patch(id: string, p: Parameters<typeof api.whiteboards.update>[1]) {
  try {
    await api.whiteboards.update(id, p);
    refresh();
  } catch (e) {
    toastError(describeError(e));
  }
}

export async function renameWhiteboard(w: Whiteboard) {
  const name = await prompt({ title: "Rename whiteboard", initial: w.name });
  if (name && name !== w.name) await patch(w.id, { name });
}

export async function deleteWhiteboard(w: Whiteboard) {
  try {
    await api.whiteboards.delete(w.id);
    refresh();
    const r = useRouter.getState().route;
    if (r.name === "whiteboard" && r.id === w.id) navigate({ name: "whiteboards" }, { replace: true });
    pushUndo("Whiteboard moved to trash", async () => {
      await api.whiteboards.restore(w.id);
      refresh();
    });
  } catch (e) {
    toastError(describeError(e));
  }
}

export async function exportWhiteboardJson(w: Whiteboard) {
  const scene = await api.whiteboards.get(w.id);
  const path = await saveDialog({ defaultPath: `${w.name.replace(/[<>:"/\\|?*]/g, "_")}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path) return;
  await api.system.writeText(path, JSON.stringify({ format: "kern-whiteboard", formatVersion: 1, ...scene }, null, 2));
  toast("Exported JSON");
}

export function whiteboardMenu(w: Whiteboard, projects: Project[]): MenuItems {
  return [
    { label: "Open", icon: Presentation, onSelect: () => navigate({ name: "whiteboard", id: w.id }) },
    { label: "Rename", icon: Pencil, onSelect: () => void renameWhiteboard(w) },
    { label: w.pinned ? "Unpin" : "Pin", icon: w.pinned ? PinOff : Pin, onSelect: () => void patch(w.id, { pinned: !w.pinned }) },
    {
      label: "Duplicate",
      icon: Copy,
      onSelect: async () => {
        try {
          await api.whiteboards.duplicate(w.id);
          refresh();
        } catch (e) {
          toastError(describeError(e));
        }
      },
    },
    {
      type: "submenu",
      label: "Move to project",
      icon: FolderInput,
      items: [
        { label: "No project", checked: !w.projectId, onSelect: () => void patch(w.id, { projectId: null }) },
        ...(projects.length ? [{ type: "separator" as const }] : []),
        ...projects.map((p) => ({ label: p.name, checked: w.projectId === p.id, onSelect: () => void patch(w.id, { projectId: p.id }) })),
      ],
    },
    { label: "Export JSON…", icon: Download, onSelect: () => void exportWhiteboardJson(w).catch((e) => toastError(describeError(e))) },
    { type: "separator" },
    { label: "Move to trash", icon: Trash, danger: true, onSelect: () => void deleteWhiteboard(w) },
  ];
}
