// Task relations in the detail panel: blocked by / blocking, related, and
// duplicates. Closing a task's last blocker reopens it if it was marked
// Blocked (handled by the backend).

import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Task, TaskRelation, TaskRelationKind } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidateTasks } from "@/lib/query";
import { useProjectMap, useTasks } from "@/hooks/data";
import { IconButton } from "@/components/ui/Button";
import { Popover, Segmented } from "@/components/ui/Controls";
import { pushUndo } from "@/stores/undo";
import { toastError } from "@/stores/toast";
import { FilterList } from "./pickers";
import { StatusIcon, statusKey } from "./meta";
import { openTask } from "./menu";
import { updateTask } from "./actions";

type SetKind = "blocked_by" | "blocks" | "related" | "duplicate_of";

const GROUPS: { kind: TaskRelationKind; title: string }[] = [
  { kind: "blocked_by", title: "Blocked by" },
  { kind: "blocks", title: "Blocking" },
  { kind: "related", title: "Related" },
  { kind: "duplicate_of", title: "Duplicate of" },
  { kind: "duplicated_by", title: "Duplicates" },
];

const PICK_KINDS: { value: SetKind; label: string }[] = [
  { value: "blocked_by", label: "Blocked by" },
  { value: "blocks", label: "Blocking" },
  { value: "related", label: "Related" },
  { value: "duplicate_of", label: "Duplicate of" },
];

export function useRelations(taskId: string) {
  return useQuery({ queryKey: ["relations", taskId], queryFn: () => api.relations.list(taskId) });
}

/** Re-creates a relation as it was, from `taskId`'s side. */
function restore(taskId: string, r: TaskRelation) {
  return r.kind === "duplicated_by" ? api.relations.set(r.task.id, taskId, "duplicate_of") : api.relations.set(taskId, r.task.id, r.kind);
}

export async function addRelation(task: Task, otherId: string, kind: SetKind) {
  try {
    await api.relations.set(task.id, otherId, kind);
    invalidateTasks();
    pushUndo(
      "Relation added",
      async () => {
        await api.relations.remove(task.id, otherId);
        invalidateTasks();
      },
      { silent: true },
    );
    // A duplicate is closed in favour of the original, as in most trackers.
    if (kind === "duplicate_of" && task.status !== "completed")
      await updateTask(task.id, { status: "completed", resolution: "duplicate" }, { undoLabel: "Closed as duplicate" });
  } catch (e) {
    toastError(describeError(e, "Couldn't add the relation."));
  }
}

async function removeRelation(taskId: string, r: TaskRelation) {
  try {
    await api.relations.remove(taskId, r.task.id);
    invalidateTasks();
    pushUndo("Relation removed", async () => {
      await restore(taskId, r);
      invalidateTasks();
    });
  } catch (e) {
    toastError(describeError(e, "Couldn't remove the relation."));
  }
}

export function Relations({ task }: { task: Task }) {
  const { data: relations } = useRelations(task.id);
  const projectMap = useProjectMap();
  const list = relations ?? [];
  return (
    <div className="col" style={{ gap: 2 }}>
      <div className="section-title" style={{ marginBottom: 2 }}>
        Relations
        {list.length > 0 && <span className="count">{list.length}</span>}
        <span className="spacer" />
        <RelationPicker task={task} exclude={list.map((r) => r.task.id)} />
      </div>
      {GROUPS.map((g) => {
        const rows = list.filter((r) => r.kind === g.kind);
        if (!rows.length) return null;
        return (
          <div key={g.kind} className="col" style={{ gap: 0 }}>
            <span className="relation-group">{g.title}</span>
            {rows.map((r) => {
              const project = r.task.projectId ? projectMap.get(r.task.projectId) : undefined;
              return (
                <div key={r.task.id} className="attachment relation-row" data-done={r.task.status === "completed"}>
                  <StatusIcon status={statusKey(r.task)} />
                  <button type="button" className="truncate grow" style={{ textAlign: "left" }} onClick={() => openTask(r.task.id)}>
                    {r.task.title}
                  </button>
                  {project && project.id !== task.projectId && (
                    <span className="faint truncate" style={{ fontSize: "var(--fs-xs)", maxWidth: 120 }}>
                      {project.name}
                    </span>
                  )}
                  <IconButton icon={X} label="Remove relation" size="sm" onClick={() => void removeRelation(task.id, r)} />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

/** "+" button: choose the kind of relation, then search for the other task. */
export function RelationPicker({ task, exclude, trigger }: { task: Task; exclude: string[]; trigger?: React.ReactElement }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<SetKind>("blocked_by");
  const { data: tasks } = useTasks({ limit: 500, order: "updated" }, { enabled: open });
  const projectMap = useProjectMap();
  const candidates = useMemo(() => {
    const skip = new Set([task.id, ...exclude]);
    return (tasks ?? []).filter((t) => !skip.has(t.id));
  }, [tasks, exclude, task.id]);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={trigger ?? <IconButton icon={Plus} label="Add relation" size="sm" noTooltip />}
    >
      <div className="col" style={{ gap: 0 }}>
        <div style={{ padding: "8px 8px 0" }}>
          <Segmented size="sm" value={kind} onChange={setKind} ariaLabel="Relation" options={PICK_KINDS} />
        </div>
        <FilterList<Task>
          items={candidates}
          placeholder="Find a task…"
          width={330}
          getKey={(t) => t.id}
          getText={(t) => `${t.title} ${t.projectId ? (projectMap.get(t.projectId)?.name ?? "") : ""}`}
          onPick={(t) => {
            setOpen(false);
            void addRelation(task, t.id, kind);
          }}
          render={(t) => (
            <>
              <StatusIcon status={statusKey(t)} />
              <span className="truncate grow">{t.title}</span>
              {t.projectId && (
                <span className="faint truncate" style={{ fontSize: "var(--fs-xs)", maxWidth: 90 }}>
                  {projectMap.get(t.projectId)?.name}
                </span>
              )}
            </>
          )}
        />
      </div>
    </Popover>
  );
}
