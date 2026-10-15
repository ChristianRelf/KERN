/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ArchiveRestore, Circle, FileText, FolderKanban, Presentation, Trash, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { TrashItem } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, invalidateTasks } from "@/lib/query";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Controls";
import { confirm } from "@/components/ui/Dialog";
import { relativeTime } from "@/lib/dates";
import { toast, toastError } from "@/stores/toast";
import { getSetting, useSetting } from "@/stores/settings";
import { useProjectMap } from "@/hooks/data";

const ICONS = { project: FolderKanban, task: Circle, note: FileText, whiteboard: Presentation };

const refresh = () => {
  invalidate("trash", "projects", "notes", "whiteboards", "recent", "groups");
  invalidateTasks();
};

async function restore(i: TrashItem) {
  try {
    if (i.kind === "task") await api.tasks.restore([i.id]);
    else if (i.kind === "note") await api.notes.restore([i.id]);
    else if (i.kind === "project") await api.projects.restore(i.id);
    else await api.whiteboards.restore(i.id);
    refresh();
    toast(`Restored “${i.title}”`);
  } catch (e) {
    toastError(describeError(e, "Couldn't restore."));
  }
}

async function purge(i: TrashItem) {
  if (getSetting("general.confirmPermanentDelete")) {
    const ok = await confirm({ title: `Delete “${i.title}” forever?`, message: "This can't be undone.", confirmLabel: "Delete forever", danger: true });
    if (!ok) return;
  }
  try {
    await api.trash.purge(i.kind, i.id);
    refresh();
  } catch (e) {
    toastError(describeError(e));
  }
}

export default function TrashPage() {
  const { data: items } = useQuery({ queryKey: ["trash"], queryFn: api.trash.list });
  const retention = useSetting("data.trashRetentionDays");
  const projects = useProjectMap();
  const empty = async () => {
    if (!(await confirm({ title: "Empty the trash?", message: `${items?.length ?? 0} items will be permanently deleted.`, confirmLabel: "Empty trash", danger: true }))) return;
    try {
      const n = await api.trash.empty();
      refresh();
      toast(`Deleted ${n} item${n === 1 ? "" : "s"}`);
    } catch (e) {
      toastError(describeError(e));
    }
  };
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <Trash /> Trash
        </h1>
        <span className="page-header__sub">{retention > 0 ? `Items are deleted after ${retention} days` : "Items are kept until you empty the trash"}</span>
        <div className="page-header__actions">
          {!!items?.length && (
            <Button size="sm" variant="danger" onClick={() => void empty()}>
              Empty trash
            </Button>
          )}
        </div>
      </header>
      <div className="page-body page-body--pad">
        <div style={{ maxWidth: 860 }}>
          {!items?.length && <EmptyState icon={Trash}>Trash is empty.</EmptyState>}
          {items?.map((i) => {
            const Icon = ICONS[i.kind];
            const project = i.projectId ? projects.get(i.projectId) : undefined;
            return (
              <div key={`${i.kind}:${i.id}`} className="list-row">
                <Icon strokeWidth={1.75} />
                <div className="col grow" style={{ minWidth: 0 }}>
                  <span className="truncate">{i.title}</span>
                  <span className="list-row__sub">
                    {i.kind[0].toUpperCase() + i.kind.slice(1)}
                    {project ? ` · ${project.name}` : ""} · deleted {relativeTime(i.deletedAt)}
                  </span>
                </div>
                <div className="list-row__actions">
                  <Button size="sm" icon={ArchiveRestore} onClick={() => void restore(i)}>
                    Restore
                  </Button>
                  <IconButton icon={X} label="Delete forever" size="sm" onClick={() => void purge(i)} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
