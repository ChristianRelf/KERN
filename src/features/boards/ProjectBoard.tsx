import {
  ArrowUpDown,
  ChevronDown,
  ChevronsLeftRight,
  CircleDashed,
  Gauge,
  Pencil,
  Plus,
  Search,
  Star,
  Trash,
  SlidersHorizontal,
  SquareKanban,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Board, BoardSettings, Column, Task, TaskStatus } from "@/lib/types";
import { useBoard, useBoards, useLabelMap, useLabels, useProjectMap, useProjects } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { useSetting } from "@/stores/settings";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { Button } from "@/components/ui/Button";
import { confirm, prompt } from "@/components/ui/Dialog";
import { EmptyState, Segmented } from "@/components/ui/Controls";
import { Kanban, type CardContext, type KanbanColumn } from "./Kanban";
import { createTask, updateTask } from "@/features/tasks/actions";
import { STATUS_LABELS } from "@/features/tasks/meta";
import { parseQuickTask } from "@/features/tasks/parse";
import { inputFromParsed } from "@/features/tasks/QuickAdd";
import { openNewTask } from "@/features/tasks/creation";
import { navigate } from "@/stores/router";

export function useCardContext(showProject: boolean, hidden: string[] = []): CardContext {
  const { data: projects } = useProjects();
  const { data: labels } = useLabels();
  const projectMap = useProjectMap();
  const labelMap = useLabelMap();
  const today = useToday();
  const hiddenKey = hidden.join(",");
  return useMemo(
    () => ({
      projects: projects ?? [],
      projectMap,
      labels: labels ?? [],
      labelMap,
      hidden: new Set(hiddenKey ? hiddenKey.split(",") : []),
      showProject,
      today,
    }),
    [projects, projectMap, labels, labelMap, hiddenKey, showProject, today],
  );
}

const META_KEYS: { key: string; label: string }[] = [
  { key: "due", label: "Due date" },
  { key: "priority", label: "Priority" },
  { key: "labels", label: "Labels" },
  { key: "subtasks", label: "Subtask progress" },
  { key: "description", label: "Description preview" },
];

const refreshBoard = () => invalidate("board", "boards", "tasks", "projects", "project");

export function ProjectBoard({ projectId, boardId }: { projectId: string; boardId?: string }) {
  const { data: boards } = useBoards(projectId);
  const current: Board | undefined = useMemo(
    () => boards?.find((b) => b.id === boardId) ?? boards?.find((b) => b.isDefault) ?? boards?.[0],
    [boards, boardId],
  );
  const { data } = useBoard(current?.id);
  if (!boards) return <div className="page-loading" />;
  if (!current)
    return (
      <EmptyState icon={SquareKanban} title="No board yet" action={<Button onClick={() => void api.boards.create(projectId, "Board").then(refreshBoard)}>Create board</Button>} />
    );
  return <BoardInner key={current.id} projectId={projectId} boards={boards} board={data?.board ?? current} columns={data?.columns} tasks={data?.tasks} />;
}

function BoardInner({
  projectId,
  boards,
  board,
  columns,
  tasks,
}: {
  projectId: string;
  boards: Board[];
  board: Board;
  columns?: Column[];
  tasks?: Task[];
}) {
  const s = board.settings ?? {};
  const defaultDensity = useSetting("boards.defaultCardDensity");
  const defaultWidth = useSetting("boards.columnWidth");
  const density = s.cardDensity ?? defaultDensity;
  const [search, setSearch] = useState(s.filter?.search ?? "");
  const ctx = useCardContext(false, s.hiddenMeta ?? []);

  const saveSettings = (patch: BoardSettings) =>
    void api.boards.update(board.id, { settings: patch }).then(refreshBoard).catch((e) => toastError(describeError(e)));

  const cols: KanbanColumn[] = useMemo(
    () =>
      (columns ?? []).map((c) => ({ id: c.id, title: c.name, status: c.status, wipLimit: c.wipLimit, collapsed: c.collapsed, width: c.width })),
    [columns],
  );
  const colIds = useMemo(() => new Set(cols.map((c) => c.id)), [cols]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (tasks ?? []).filter(
      (t) =>
        (s.showCompleted !== false || t.status !== "completed") &&
        (!q || t.title.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)) &&
        (!s.filter?.priorities?.length || s.filter.priorities.includes(t.priority)),
    );
  }, [tasks, search, s.showCompleted, s.filter?.priorities]);

  const columnOf = (t: Task) => {
    if (t.columnId && colIds.has(t.columnId)) return t.columnId;
    return cols.find((c) => c.status === t.status)?.id ?? cols[0]?.id ?? "";
  };

  const updateColumn = (id: string, patch: Parameters<typeof api.boards.updateColumn>[1]) =>
    void api.boards.updateColumn(id, patch).then(refreshBoard).catch((e) => toastError(describeError(e)));

  const columnMenu = (c: KanbanColumn): MenuItems => [
    {
      label: "Rename",
      icon: Pencil,
      onSelect: async () => {
        const name = await prompt({ title: "Rename column", initial: c.title });
        if (name) updateColumn(c.id, { name });
      },
    },
    {
      type: "submenu",
      label: "Sets status to",
      icon: CircleDashed,
      items: [
        { label: "Nothing (keep status)", checked: !c.status, onSelect: () => updateColumn(c.id, { status: null }) },
        { type: "separator" },
        ...(["todo", "in_progress", "blocked", "completed"] as TaskStatus[]).map((st) => ({
          label: STATUS_LABELS[st],
          checked: c.status === st,
          onSelect: () => updateColumn(c.id, { status: st }),
        })),
      ],
    },
    {
      label: c.wipLimit ? `WIP limit: ${c.wipLimit}` : "Set WIP limit",
      icon: Gauge,
      onSelect: async () => {
        const v = await prompt({ title: "Work-in-progress limit", label: "Maximum open cards (0 for none)", initial: String(c.wipLimit ?? "") });
        if (v === null) return;
        const n = Math.max(0, Math.floor(Number(v)));
        if (!Number.isNaN(n)) updateColumn(c.id, { wipLimit: n || null });
      },
    },
    { label: "Collapse", icon: ChevronsLeftRight, onSelect: () => updateColumn(c.id, { collapsed: true }) },
    { type: "separator" },
    {
      label: "Delete column",
      icon: Trash,
      danger: true,
      disabled: cols.length <= 1,
      onSelect: async () => {
        const idx = cols.findIndex((x) => x.id === c.id);
        const target = cols[idx - 1] ?? cols[idx + 1];
        const count = visible.filter((t) => columnOf(t) === c.id).length;
        const ok = await confirm({
          title: `Delete “${c.title}”?`,
          message: count ? `Its ${count} card${count === 1 ? "" : "s"} will move to “${target.title}”.` : "The column is empty.",
          confirmLabel: "Delete column",
          danger: true,
        });
        if (!ok) return;
        try {
          await api.boards.deleteColumn(c.id, target.id);
          refreshBoard();
        } catch (e) {
          toastError(describeError(e));
        }
      },
    },
  ];

  const boardMenu: MenuItems = [
    ...boards.map((b) => ({
      label: b.name,
      checked: b.id === board.id,
      onSelect: () => navigate({ name: "project", id: projectId, tab: "board", boardId: b.id }, { replace: true }),
    })),
    { type: "separator" },
    {
      label: "New board",
      icon: Plus,
      onSelect: async () => {
        const name = await prompt({ title: "New board", placeholder: "Board name", confirmLabel: "Create" });
        if (!name) return;
        try {
          const b = await api.boards.create(projectId, name);
          refreshBoard();
          navigate({ name: "project", id: projectId, tab: "board", boardId: b.id }, { replace: true });
        } catch (e) {
          toastError(describeError(e));
        }
      },
    },
    {
      label: "Rename board",
      icon: Pencil,
      onSelect: async () => {
        const name = await prompt({ title: "Rename board", initial: board.name });
        if (name) void api.boards.update(board.id, { name }).then(refreshBoard);
      },
    },
    !board.isDefault && {
      label: "Make default board",
      icon: Star,
      onSelect: () => void api.boards.update(board.id, { makeDefault: true }).then(refreshBoard),
    },
    boards.length > 1 && {
      label: "Delete board",
      icon: Trash,
      danger: true,
      onSelect: async () => {
        const ok = await confirm({
          title: `Delete board “${board.name}”?`,
          message: "Cards keep their tasks; they just lose their placement on this board.",
          confirmLabel: "Delete board",
          danger: true,
        });
        if (!ok) return;
        await api.boards.delete(board.id).catch((e) => toastError(describeError(e)));
        refreshBoard();
        navigate({ name: "project", id: projectId, tab: "board" }, { replace: true });
      },
    },
  ];

  const displayMenu: MenuItems = [
    { type: "label", label: "Sort cards" },
    ...(["manual", "due", "priority", "created", "title"] as const).map((v) => ({
      label: { manual: "Manual", due: "Due date", priority: "Priority", created: "Newest first", title: "Title" }[v],
      checked: (s.sort ?? "manual") === v,
      onSelect: () => saveSettings({ sort: v }),
    })),
    { type: "separator" },
    { type: "label", label: "Group" },
    { label: "No grouping", checked: (s.groupBy ?? "none") === "none", onSelect: () => saveSettings({ groupBy: "none" }) },
    { label: "Priority lanes", checked: s.groupBy === "priority", onSelect: () => saveSettings({ groupBy: "priority" }) },
    { type: "separator" },
    { type: "label", label: "Show on cards" },
    ...META_KEYS.map((m) => {
      const hidden = new Set(s.hiddenMeta ?? []);
      const on = !hidden.has(m.key);
      return {
        label: m.label,
        checked: on,
        onSelect: () => {
          if (on) hidden.add(m.key);
          else hidden.delete(m.key);
          saveSettings({ hiddenMeta: [...hidden] });
        },
      };
    }),
    { label: "Completed cards", checked: s.showCompleted !== false, onSelect: () => saveSettings({ showCompleted: s.showCompleted === false }) },
    { type: "separator" },
    {
      type: "submenu",
      label: "Background",
      items: (["plain", "dots", "lines", "sunken"] as const).map((b) => ({
        label: b[0].toUpperCase() + b.slice(1),
        checked: (s.background ?? "plain") === b,
        onSelect: () => saveSettings({ background: b }),
      })),
    },
    { type: "separator" },
    ...cols
      .filter((c) => c.collapsed)
      .map((c) => ({ label: `Expand “${c.title}”`, icon: ChevronsLeftRight, onSelect: () => updateColumn(c.id, { collapsed: false }) })),
  ];

  if (!columns || !tasks) return <div className="page-loading" />;

  return (
    <>
      <div className="toolbar">
        <Dropdown items={boardMenu}>
          <button type="button" className="board-select">
            <SquareKanban />
            {board.name}
            <ChevronDown />
          </button>
        </Dropdown>
        <div className="input-wrap" style={{ width: 200 }}>
          <Search />
          <input
            className="input"
            style={{ height: "var(--control-h-sm)" }}
            placeholder="Filter cards"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Filter cards"
          />
        </div>
        <span className="spacer" />
        <Segmented
          size="sm"
          value={density}
          onChange={(v) => saveSettings({ cardDensity: v })}
          options={[
            { value: "compact", label: "Compact" },
            { value: "expanded", label: "Expanded" },
          ]}
          ariaLabel="Card density"
        />
        <Dropdown items={displayMenu} align="end">
          <button type="button" className="btn btn--ghost btn--sm">
            {(s.sort ?? "manual") !== "manual" ? <ArrowUpDown /> : <SlidersHorizontal />}
            Display
          </button>
        </Dropdown>
      </div>
      <Kanban
        columns={cols}
        tasks={visible}
        columnOf={columnOf}
        orderOf={(t) => t.boardOrder}
        ctx={ctx}
        sortMode={s.sort ?? "manual"}
        groupBy={s.groupBy === "priority" ? "priority" : "none"}
        density={density}
        background={s.background ?? "plain"}
        defaultWidth={defaultWidth}
        onMove={(task, col, order) => {
          const moved = columnOf(task) !== col.id;
          const status = col.status ?? (task.status === "completed" && moved ? "todo" : undefined);
          void updateTask(
            task.id,
            { columnId: col.id, boardOrder: order, ...(status && moved ? { status } : {}) },
            { undoLabel: moved ? `Moved to ${col.title}` : undefined, undoable: true },
          );
        }}
        onReorderColumns={(ids) => void api.boards.reorderColumns(ids).then(refreshBoard).catch((e) => toastError(describeError(e)))}
        columnMenu={columnMenu}
        onToggleCollapse={(c) => updateColumn(c.id, { collapsed: !c.collapsed })}
        onRenameColumn={(c, name) => updateColumn(c.id, { name })}
        onResizeColumn={(c, width) => updateColumn(c.id, { width })}
        onComposeCard={(col, title) => openNewTask({ projectId, columnId: col.id, status: col.status ?? "todo", title })}
        onAddCard={async (col, title) => {
          const parsed = parseQuickTask(title, { projects: ctx.projects });
          const input = await inputFromParsed(parsed, { projectId, columnId: col.id, status: col.status ?? "todo" });
          input.projectId = projectId;
          input.columnId = col.id;
          await createTask(input, { quiet: true });
          invalidate("board");
        }}
        trailing={
          <div className="kanban__add-col">
            <Button
              variant="ghost"
              icon={Plus}
              block
              onClick={async () => {
                const name = await prompt({ title: "New column", placeholder: "Column name", confirmLabel: "Add" });
                if (!name) return;
                await api.boards.createColumn(board.id, name).catch((e) => toastError(describeError(e)));
                refreshBoard();
              }}
            >
              Add column
            </Button>
          </div>
        }
      />
    </>
  );
}

