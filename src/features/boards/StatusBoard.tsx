// "Board" view in My Tasks: all tasks arranged in status columns.

import { useMemo } from "react";
import type { TaskStatus } from "@/lib/types";
import { useTasks } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { useSetting } from "@/stores/settings";
import { Kanban, type KanbanColumn } from "./Kanban";
import { useCardContext } from "./ProjectBoard";
import { createTask, updateTask } from "@/features/tasks/actions";
import { STATUS_LABELS } from "@/features/tasks/meta";
import { parseQuickTask } from "@/features/tasks/parse";
import { inputFromParsed } from "@/features/tasks/QuickAdd";
import { openNewTask } from "@/features/tasks/creation";
import { dayStartMs, addDaysStr } from "@/lib/dates";

const COLUMNS: KanbanColumn[] = (["inbox", "todo", "in_progress", "blocked", "completed"] as TaskStatus[]).map((s) => ({
  id: s,
  title: s === "completed" ? "Done (7 days)" : STATUS_LABELS[s],
  status: s,
}));

export default function StatusBoard() {
  const today = useToday();
  const ctx = useCardContext(true);
  const width = useSetting("boards.columnWidth");
  const density = useSetting("boards.defaultCardDensity");
  const open = useTasks({ topLevelOnly: true, order: "manual" });
  const done = useTasks({ topLevelOnly: true, statuses: ["completed"], completedFrom: dayStartMs(addDaysStr(today, -7)), order: "completed" });
  const tasks = useMemo(() => [...(open.data ?? []), ...(done.data ?? [])], [open.data, done.data]);
  if (!open.data) return <div className="page-loading" />;
  return (
    <Kanban
      columns={COLUMNS}
      tasks={tasks}
      columnOf={(t) => t.status}
      orderOf={(t) => t.sortOrder}
      ctx={ctx}
      density={density}
      defaultWidth={width}
      onMove={(task, col, order) => {
        const moved = task.status !== col.status;
        void updateTask(
          task.id,
          { status: col.status!, sortOrder: order },
          { undoLabel: moved ? `Moved to ${col.title}` : undefined, undoable: true, refreshDelay: 0 },
        );
      }}
      onComposeCard={(col, title) => openNewTask({ status: col.status ?? "todo", title })}
      onAddCard={async (col, title) => {
        const parsed = parseQuickTask(title, { projects: ctx.projects });
        await createTask(await inputFromParsed(parsed, { status: col.status ?? "todo" }), { quiet: true });
      }}
    />
  );
}
