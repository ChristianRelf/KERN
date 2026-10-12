import {
  Archive,
  ArchiveRestore,
  Bell,
  CalendarDays,
  CalendarRange,
  ChevronRight,
  CircleDashed,
  CopyPlus,
  File,
  FileWarning,
  Flag,
  FolderKanban,
  GripVertical,
  Link2,
  Paperclip,
  Plus,
  Repeat,
  Tag,
  Timer,
  Trash,
  X,
  Hourglass,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import type { Task, TaskPatch, TaskStatus } from "@/lib/types";
import { useAttachments, useLabelMap, useProjectMap, useSubtasks, useTask } from "@/hooks/data";
import { TaskCheck, EmptyState, Skeleton } from "@/components/ui/Controls";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { DuePopover, LabelPicker, ProjectPicker, RecurrencePicker, describeRecurrence } from "./pickers";
import { PRIORITY_LABELS, PriorityIcon, STATUS_LABELS, StatusIcon } from "./meta";
import { createTask, deleteTasks, duplicateTask, reorderTasks, setCompleted, updateTask } from "./actions";
import { formatBytes, formatDue, formatDuration, relativeTime, todayStr } from "@/lib/dates";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { getSetting, useSetting } from "@/stores/settings";
import { openTask, startFocusOn } from "./menu";
import { onBeforeNavigate } from "@/stores/router";

function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

/** Text that autosaves (debounced) and flushes on blur, unmount and navigation. */
function useAutosaveText(remote: string, save: (v: string) => void, delay = 600) {
  const [value, setValue] = useState(remote);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ value, save });
  latest.current = { value, save };

  useEffect(() => {
    if (!dirty.current) setValue(remote);
  }, [remote]);

  const flush = () => {
    window.clearTimeout(timer.current);
    if (dirty.current) {
      dirty.current = false;
      latest.current.save(latest.current.value);
    }
  };
  useEffect(() => {
    const off = onBeforeNavigate(flush);
    return () => {
      off();
      flush();
    };
  }, []);
  const onChange = (v: string) => {
    setValue(v);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, delay);
  };
  return { value, onChange, flush };
}

export function TaskDetail({ id, onClose }: { id: string; onClose?: () => void }) {
  const { data: task, isLoading, isError } = useTask(id);
  if (isLoading)
    return (
      <div className="col" style={{ gap: 10 }}>
        <Skeleton height={22} width="70%" />
        <Skeleton height={14} width="40%" />
        <Skeleton height={80} />
      </div>
    );
  if (isError || !task || task.deletedAt)
    return (
      <EmptyState icon={FileWarning} title="This task is no longer available" action={onClose && <Button size="sm" onClick={onClose}>Close</Button>}>
        It may have been deleted.
      </EmptyState>
    );
  return <TaskDetailBody key={task.id} task={task} />;
}

function TaskDetailBody({ task }: { task: Task }) {
  const projectMap = useProjectMap();
  const labelMap = useLabelMap();
  const project = task.projectId ? projectMap.get(task.projectId) : undefined;
  const done = task.status === "completed";
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const patch = (p: TaskPatch, undoLabel?: string) => void updateTask(task.id, p, { undoLabel, undoable: true });

  const title = useAutosaveText(task.title, (v) => {
    if (v.trim() && v.trim() !== task.title) patch({ title: v.trim() });
  });
  const desc = useAutosaveText(task.description, (v) => {
    if (v !== task.description) patch({ description: v });
  });
  useAutosize(titleRef, title.value);
  const descRef = useRef<HTMLTextAreaElement>(null);
  useAutosize(descRef, desc.value);

  const parent = useTask(task.parentId);

  return (
    <div className="task-detail">
      {task.parentId && parent.data && (
        <button type="button" className="prop-btn faint" style={{ marginLeft: -8 }} onClick={() => openTask(parent.data!.id)}>
          <ChevronRight style={{ transform: "rotate(180deg)" }} />
          <span className="truncate">{parent.data.title}</span>
        </button>
      )}
      <div className="task-detail__title">
        <TaskCheck checked={done} onToggle={() => void setCompleted(task, !done)} priority={task.priority} size={18} />
        <textarea
          ref={titleRef}
          rows={1}
          value={title.value}
          aria-label="Task title"
          onChange={(e) => title.onChange(e.target.value.replace(/\n/g, " "))}
          onBlur={title.flush}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              title.flush();
              descRef.current?.focus();
            }
          }}
        />
      </div>

      <div className="props">
        <span className="props__label">
          <CircleDashed /> Status
        </span>
        <div>
          <Dropdown
            items={(["inbox", "todo", "in_progress", "blocked", "completed"] as TaskStatus[]).map((s) => ({
              label: STATUS_LABELS[s],
              checked: task.status === s,
              onSelect: () => patch({ status: s }, STATUS_LABELS[s]),
            }))}
          >
            <button type="button" className="prop-btn">
              <StatusIcon status={task.status} />
              {STATUS_LABELS[task.status]}
            </button>
          </Dropdown>
        </div>

        <span className="props__label">
          <Flag /> Priority
        </span>
        <div>
          <Dropdown
            items={[4, 3, 2, 1, 0].map((p) => ({
              label: PRIORITY_LABELS[p],
              shortcut: String(p),
              checked: task.priority === p,
              onSelect: () => patch({ priority: p }),
            }))}
          >
            <button type="button" className="prop-btn" data-empty={task.priority === 0}>
              {task.priority > 0 && <PriorityIcon priority={task.priority} />}
              {PRIORITY_LABELS[task.priority]}
            </button>
          </Dropdown>
        </div>

        <span className="props__label">
          <FolderKanban /> Project
        </span>
        <div>
          <ProjectPicker
            value={task.projectId}
            onChange={(pid) => patch({ projectId: pid }, pid ? `Moved to ${projectMap.get(pid)?.name ?? "project"}` : "Moved to Inbox")}
            trigger={
              <button type="button" className="prop-btn" data-empty={!project}>
                {project ? <ProjectGlyph project={project} size={14} /> : null}
                <span className="truncate">{project?.name ?? "No project"}</span>
              </button>
            }
          />
        </div>

        <span className="props__label">
          <CalendarDays /> Due
        </span>
        <div className="row" style={{ gap: 0 }}>
          <DuePopover
            date={task.dueDate}
            time={task.dueTime}
            onChange={(d, t) => patch({ dueDate: d, dueTime: t }, d ? `Due ${formatDue(d)}` : "Date removed")}
            trigger={
              <button type="button" className="prop-btn" data-empty={!task.dueDate}>
                {task.dueDate ? formatDue(task.dueDate, task.dueTime) : "Set date"}
              </button>
            }
          />
          {task.dueDate && (
            <IconButton icon={X} label="Remove due date" size="sm" onClick={() => patch({ dueDate: null, dueTime: null }, "Date removed")} />
          )}
        </div>

        <span className="props__label">
          <CalendarRange /> Start
        </span>
        <div className="row" style={{ gap: 0 }}>
          <DuePopover
            date={task.startDate}
            withTime={false}
            onChange={(d) => patch({ startDate: d })}
            trigger={
              <button type="button" className="prop-btn" data-empty={!task.startDate}>
                {task.startDate ? formatDue(task.startDate) : "None"}
              </button>
            }
          />
          {task.startDate && <IconButton icon={X} label="Remove start date" size="sm" onClick={() => patch({ startDate: null })} />}
        </div>

        <span className="props__label">
          <Repeat /> Repeat
        </span>
        <div>
          <RecurrencePicker
            value={task.recurrence}
            dueDate={task.dueDate}
            onChange={(r) => patch({ recurrence: r, ...(r && !task.dueDate ? { dueDate: todayStr() } : {}) }, r ? "Repeat set" : "Repeat removed")}
            trigger={
              <button type="button" className="prop-btn" data-empty={!task.recurrence}>
                {task.recurrence ? describeRecurrence(task.recurrence) : "Never"}
              </button>
            }
          />
        </div>

        <span className="props__label">
          <Tag /> Labels
        </span>
        <div>
          <LabelPicker
            value={task.labelIds}
            onToggle={(lid, on) => patch(on ? { addLabelIds: [lid] } : { removeLabelIds: [lid] })}
            trigger={
              <button type="button" className="prop-btn" data-empty={!task.labelIds.length}>
                {task.labelIds.length
                  ? task.labelIds.map((l) => (
                      <span key={l} className="chip">
                        {labelMap.get(l)?.name ?? "…"}
                      </span>
                    ))
                  : "Add labels"}
              </button>
            }
          />
        </div>

        <span className="props__label">
          <Hourglass /> Estimate
        </span>
        <div>
          <Dropdown
            items={[null, 15, 30, 45, 60, 90, 120, 180, 240, 480].map((m) => ({
              label: m ? formatDuration(m * 60) : "None",
              checked: task.estimateMinutes === m,
              onSelect: () => patch({ estimateMinutes: m }),
            }))}
          >
            <button type="button" className="prop-btn" data-empty={!task.estimateMinutes}>
              {task.estimateMinutes ? formatDuration(task.estimateMinutes * 60) : "None"}
              {task.trackedSeconds > 0 && <span className="faint">· {formatDuration(task.trackedSeconds)} tracked</span>}
            </button>
          </Dropdown>
        </div>

        {task.dueTime && (
          <>
            <span className="props__label">
              <Bell /> Reminder
            </span>
            <div>
              <Dropdown
                items={[null, 0, 5, 15, 30, 60, 120].map((m) => ({
                  label: m === null ? `Default (${getSetting("notifications.dueLeadMinutes")} min before)` : m === 0 ? "At due time" : `${formatDuration(m * 60)} before`,
                  checked: task.reminderMinutes === m,
                  onSelect: () => patch({ reminderMinutes: m }),
                }))}
              >
                <button type="button" className="prop-btn">
                  {task.reminderMinutes === null
                    ? "Default"
                    : task.reminderMinutes === 0
                      ? "At due time"
                      : `${formatDuration(task.reminderMinutes * 60)} before`}
                </button>
              </Dropdown>
            </div>
          </>
        )}
      </div>

      <textarea
        ref={descRef}
        className="textarea desc-area"
        placeholder="Notes"
        value={desc.value}
        onChange={(e) => desc.onChange(e.target.value)}
        onBlur={desc.flush}
        aria-label="Notes"
      />

      <Subtasks task={task} depth={0} />
      <Attachments task={task} />

      <div className="detail-meta">
        <span>Created {relativeTime(task.createdAt)}</span>
        {task.completedAt && <span>Completed {relativeTime(task.completedAt)}</span>}
        {task.updatedAt !== task.createdAt && <span>Updated {relativeTime(task.updatedAt)}</span>}
      </div>

      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {!done && (
          <Button size="sm" icon={Timer} onClick={() => startFocusOn(task)}>
            Focus
          </Button>
        )}
        <Button size="sm" icon={CopyPlus} onClick={() => void duplicateTask(task.id)}>
          Duplicate
        </Button>
        <Button
          size="sm"
          icon={task.archivedAt ? ArchiveRestore : Archive}
          onClick={() => patch({ archived: !task.archivedAt }, task.archivedAt ? "Unarchived" : "Archived")}
        >
          {task.archivedAt ? "Unarchive" : "Archive"}
        </Button>
        <Button size="sm" variant="ghost" icon={Trash} onClick={() => void deleteTasks([task.id])}>
          Delete
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- subtasks

function Subtasks({ task, depth }: { task: Task; depth: number }) {
  const { data: subs } = useSubtasks(task.id);
  const maxDepth = useSetting("tasks.maxSubtaskDepth");
  const [adding, setAdding] = useState("");
  const [order, setOrder] = useState<string[] | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  useEffect(() => setOrder(null), [subs]);

  const list = subs ?? [];
  const ordered = order ? (order.map((id) => list.find((s) => s.id === id)).filter(Boolean) as Task[]) : list;
  const done = list.filter((s) => s.status === "completed").length;

  const add = async () => {
    const title = adding.trim();
    if (!title) return;
    setAdding("");
    await createTask({ title, parentId: task.id, status: "todo" }, { quiet: true });
    invalidate("tasks", "task");
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const ids = ordered.map((s) => s.id);
    const next = arrayMove(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
    setOrder(next);
    void reorderTasks(next, ids, "list");
  };

  return (
    <div className="col" style={{ gap: 2, marginLeft: depth ? 18 : 0 }}>
      {depth === 0 && (
        <div className="section-title" style={{ marginBottom: 4 }}>
          Subtasks
          {list.length > 0 && (
            <span className="count">
              {done}/{list.length}
            </span>
          )}
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ordered.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {ordered.map((s) => (
            <SubtaskRow key={s.id} task={s} depth={depth} canNest={depth + 1 < maxDepth} />
          ))}
        </SortableContext>
      </DndContext>
      {depth === 0 && (
        <div className="subtask-row">
          <Plus size={14} className="faint" style={{ margin: "0 1px" }} />
          <input
            placeholder="Add subtask"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
            }}
            aria-label="Add subtask"
          />
        </div>
      )}
    </div>
  );
}

function SubtaskRow({ task, depth, canNest }: { task: Task; depth: number; canNest: boolean }) {
  const [title, setTitle] = useState(task.title);
  const [expanded, setExpanded] = useState(depth === 0 && task.subtaskCount > 0);
  const [addingChild, setAddingChild] = useState(false);
  useEffect(() => setTitle(task.title), [task.title]);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: task.id });
  const done = task.status === "completed";
  const commit = () => {
    const v = title.trim();
    if (!v) setTitle(task.title);
    else if (v !== task.title) void updateTask(task.id, { title: v });
  };
  return (
    <div ref={setNodeRef} style={{ transform: DndCSS.Translate.toString(transform), transition }}>
      <div className="subtask-row" data-done={done}>
        <span {...attributes} {...listeners} style={{ cursor: "grab", color: "var(--text-4)", display: "flex" }} aria-label="Drag to reorder">
          <GripVertical size={12} />
        </span>
        <TaskCheck checked={done} onToggle={() => void setCompleted(task, !done)} size={14} />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setTitle(task.title);
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Subtask title"
        />
        {task.subtaskCount > 0 && (
          <button type="button" className="chip chip-btn" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {task.subtaskDone}/{task.subtaskCount}
          </button>
        )}
        <span className="subtask-actions">
          {canNest && <IconButton icon={Plus} label="Add nested subtask" size="sm" onClick={() => { setExpanded(true); setAddingChild(true); }} />}
          <IconButton icon={ChevronRight} label="Open" size="sm" onClick={() => openTask(task.id)} />
          <IconButton icon={X} label="Delete subtask" size="sm" onClick={() => void deleteTasks([task.id])} />
        </span>
      </div>
      {expanded && (task.subtaskCount > 0 || addingChild) && (
        <div style={{ marginLeft: 18 }}>
          {task.subtaskCount > 0 && <Subtasks task={task} depth={depth + 1} />}
          {addingChild && <NestedAdd parentId={task.id} onDone={() => setAddingChild(false)} />}
        </div>
      )}
    </div>
  );
}

function NestedAdd({ parentId, onDone }: { parentId: string; onDone: () => void }) {
  const [v, setV] = useState("");
  return (
    <div className="subtask-row">
      <Plus size={14} className="faint" />
      <input
        autoFocus
        placeholder="Nested subtask"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => !v.trim() && onDone()}
        onKeyDown={async (e) => {
          if (e.key === "Enter" && v.trim()) {
            e.preventDefault();
            const title = v.trim();
            setV("");
            await createTask({ title, parentId, status: "todo" }, { quiet: true });
          } else if (e.key === "Escape") onDone();
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------- attachments

function Attachments({ task }: { task: Task }) {
  const { data: atts } = useAttachments({ taskId: task.id });
  const add = async (managed: boolean) => {
    const picked = await openDialog({ multiple: true, directory: false, title: managed ? "Attach files" : "Link files" });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const p of paths) {
      try {
        await api.attachments.add(p, { taskId: task.id }, managed);
      } catch (e) {
        toastError(describeError(e, "Couldn't attach the file."));
      }
    }
    invalidate("attachments", "tasks", "task");
  };
  return (
    <div className="col" style={{ gap: 2 }}>
      <div className="section-title" style={{ marginBottom: 2 }}>
        Attachments
        {!!atts?.length && <span className="count">{atts.length}</span>}
        <span className="spacer" />
        <Dropdown
          align="end"
          items={[
            { label: "Attach a copy…", icon: Paperclip, onSelect: () => void add(true) },
            { label: "Link to original…", icon: Link2, onSelect: () => void add(false) },
          ]}
        >
          <IconButton icon={Plus} label="Attach file" size="sm" noTooltip />
        </Dropdown>
      </div>
      {atts?.map((a) => (
        <div key={a.id} className="attachment" data-missing={!a.exists}>
          {a.exists ? a.managed ? <File /> : <Link2 /> : <FileWarning />}
          <button
            type="button"
            className="truncate grow"
            style={{ textAlign: "left" }}
            title={a.exists ? a.absPath : "This file has moved or was deleted"}
            onClick={() => a.exists && void api.system.open(a.absPath).catch((e) => toastError(describeError(e, "Couldn't open the file.")))}
          >
            {a.name}
          </button>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {a.exists ? formatBytes(a.size) : "Unavailable"}
          </span>
          <IconButton
            icon={X}
            label="Remove attachment"
            size="sm"
            onClick={async () => {
              await api.attachments.delete(a.id);
              invalidate("attachments", "tasks", "task");
            }}
          />
        </div>
      ))}
    </div>
  );
}
