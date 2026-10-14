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
  Globe,
  Flag as FlagIcon,
  Play,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import type { Attachment, Task, TaskPatch } from "@/lib/types";
import { useAttachments, useLabelMap, useProjectMap, useSubtasks, useTask } from "@/hooks/data";
import { TaskCheck, EmptyState, Skeleton } from "@/components/ui/Controls";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { DuePopover, LabelPicker, ProjectPicker, RecurrencePicker, describeRecurrence } from "./pickers";
import { PRIORITY_LABELS, PriorityIcon, StatusIcon, statusChoices, statusKey, statusLabel } from "./meta";
import { createTask, deleteTasks, duplicateTask, reorderTasks, setCompleted, updateTask } from "./actions";
import { formatBytes, formatDue, formatDuration, relativeTime, todayStr } from "@/lib/dates";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { getSetting, useSetting } from "@/stores/settings";
import { openTask, startFocusOn } from "./menu";
import { onBeforeNavigate } from "@/stores/router";
import { LINK_MIME } from "@/lib/types";
import { RichLink, extractUrls, normalizeUrl } from "@/features/links/links";
import { GithubMark } from "@/features/github/shared";
import { confirmDelete, prompt } from "@/components/ui/Dialog";
import { clearDraft, setDraft, useDrafts } from "@/stores/drafts";
import { MilestonePicker } from "@/features/milestones/MilestonesTab";
import { openMilestone } from "@/features/milestones/actions";
import { useMilestones } from "@/features/dev/hooks";
import { TaskDevSection } from "@/features/dev/TaskDevSection";
import { startWork } from "@/features/sessions/StartWork";
import { NoteEditor, getMarkdown } from "@/features/notes/NoteEditor";
import type { Editor } from "@tiptap/react";
import { Relations } from "./Relations";
import { LabelChip } from "./labels";

function useAutosize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

/**
 * Text that autosaves (debounced) and flushes on blur, unmount and
 * navigation. A failed save keeps the text as a draft (see stores/drafts),
 * which is restored here instead of the stale remote value.
 */
function useAutosaveText(remote: string, save: (v: string) => void, draft?: string, delay = 600) {
  const [value, setValue] = useState(draft ?? remote);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ value, save });
  latest.current = { value, save };

  useEffect(() => {
    if (!dirty.current) setValue(draft ?? remote);
  }, [remote, draft]);

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

  const drafts = useDrafts((s) => s.drafts[task.id]);
  // Saves outlive this component (the panel may already be closed).
  const saveText = (field: "title" | "description", value: string, p: TaskPatch) =>
    void updateTask(task.id, p, { undoable: true }).then((res) => (res ? clearDraft(task.id, field) : setDraft(task.id, field, value)));
  const title = useAutosaveText(
    task.title,
    (v) => {
      if (v.trim() && v.trim() !== task.title) saveText("title", v, { title: v.trim() });
      else clearDraft(task.id, "title");
    },
    drafts?.title,
  );
  const desc = useAutosaveText(
    task.description,
    (v) => {
      if (v !== task.description) saveText("description", v, { description: v });
      else clearDraft(task.id, "description");
    },
    drafts?.description,
  );
  useAutosize(titleRef, title.value);
  const [editor, setEditor] = useState<Editor | null>(null);
  // Show edits made elsewhere (another window or device) unless typing here.
  useEffect(() => {
    if (!editor || editor.isFocused || drafts?.description !== undefined) return;
    if (getMarkdown(editor) !== task.description) editor.commands.setContent(task.description, false);
  }, [editor, task.description]); // eslint-disable-line react-hooks/exhaustive-deps

  const parent = useTask(task.parentId);

  return (
    <div className="task-detail">
      {task.parentId && parent.data && (
        <button type="button" className="prop-btn faint" style={{ marginLeft: -8 }} onClick={() => openTask(parent.data!.id)}>
          <ChevronRight style={{ transform: "rotate(180deg)" }} />
          <span className="truncate">{parent.data.title}</span>
        </button>
      )}
      {drafts && (
        <div className="draft-banner" role="alert">
          <span className="grow">Some changes haven't been saved yet.</span>
          <Button
            size="sm"
            onClick={() => {
              if (drafts.title !== undefined) saveText("title", drafts.title, { title: drafts.title.trim() || task.title });
              if (drafts.description !== undefined) saveText("description", drafts.description, { description: drafts.description });
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <div className="task-detail__title">
        <TaskCheck checked={done} onToggle={() => void setCompleted(task, !done)} priority={task.priority} blocked={!!task.blockedBy} cancelled={!!task.resolution} size={18} />
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
              editor?.commands.focus("start");
            }
          }}
        />
      </div>

      {task.issue && (
        <button type="button" className="issue-link" onClick={() => void api.system.open(task.issue!.url)} title="Open on GitHub">
          <GithubMark size={13} />
          {task.issue.repo}#{task.issue.number}
          <span className="faint">· synced with GitHub</span>
        </button>
      )}
      <div className="props">
        <span className="props__label">
          <CircleDashed /> Status
        </span>
        <div>
          <Dropdown
            items={statusChoices({ inbox: true }).map((c) => ({
              label: c.label,
              checked: statusKey(task) === c.key,
              onSelect: () => patch(c.patch, c.label),
            }))}
          >
            <button type="button" className="prop-btn">
              <StatusIcon status={statusKey(task)} />
              {statusLabel(task)}
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

        {task.projectId && !task.parentId && <MilestoneProp task={task} onChange={(m) => patch({ milestoneId: m }, m ? "Added to milestone" : "Removed from milestone")} />}

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
                  ? task.labelIds.map((l) => {
                      const label = labelMap.get(l);
                      return label ? <LabelChip key={l} label={label} /> : <span key={l} className="chip">…</span>;
                    })
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

      <div className="desc-editor" aria-label="Notes" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), editor?.commands.focus("end"))}>
        <NoteEditor
          compact
          initial={desc.value}
          onChange={desc.onChange}
          onBlur={desc.flush}
          onEditor={setEditor}
          placeholder="Add notes… Type / for headings, lists and checklists"
        />
      </div>
      <DescriptionLinks text={desc.value} />

      <Subtasks task={task} depth={0} />
      <Relations task={task} />
      <Attachments task={task} />
      <TaskDevSection task={task} />

      <div className="detail-meta">
        <span>Created {relativeTime(task.createdAt)}</span>
        {task.completedAt && <span>Completed {relativeTime(task.completedAt)}</span>}
        {task.updatedAt !== task.createdAt && <span>Updated {relativeTime(task.updatedAt)}</span>}
      </div>

      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {!done && (
          <Button size="sm" icon={Play} onClick={() => void startWork(task)}>
            Start work
          </Button>
        )}
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
        <TaskCheck checked={done} onToggle={() => void setCompleted(task, !done)} cancelled={!!task.resolution} size={14} />
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

// ------------------------------------------------------------- links

/** Links written in the task's notes, shown with their site icons. */
function DescriptionLinks({ text }: { text: string }) {
  const urls = useMemo(() => extractUrls(text).slice(0, 12), [text]);
  if (!urls.length) return null;
  return (
    <div className="rich-link-list">
      {urls.map((u) => (
        <RichLink key={u} url={u} size="sm" />
      ))}
    </div>
  );
}

/** Attaches a web link; fetches its title when allowed in Privacy settings. */
export async function addLinkAttachment(target: { taskId?: string; projectId?: string }) {
  const raw = await prompt({ title: "Add link", placeholder: "https://…", confirmLabel: "Add" });
  if (!raw) return;
  try {
    const a = await api.attachments.addLink(normalizeUrl(raw), target);
    invalidate("attachments", "tasks", "task");
    if (getSetting("privacy.network") && getSetting("data.linkPreviews")) {
      const meta = await api.system.linkMetadata(a.path).catch(() => null);
      if (meta?.title) {
        await api.attachments.rename(a.id, meta.title.slice(0, 200));
        invalidate("attachments");
      }
    }
  } catch (e) {
    toastError(describeError(e, "Couldn't add the link."));
  }
}

// ------------------------------------------------------------- attachments

async function removeAttachment(a: Attachment) {
  const message = !a.managed ? "Only the link is removed; the original file stays where it is." : "Kern's stored copy of the file is deleted.";
  if (!(await confirmDelete(`Remove “${a.name}”?`, message, "Remove"))) return;
  await api.attachments.delete(a.id);
  invalidate("attachments", "tasks", "task");
}

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
            { type: "separator" },
            { label: "Add web link…", icon: Globe, onSelect: () => void addLinkAttachment({ taskId: task.id }) },
          ]}
        >
          <IconButton icon={Plus} label="Attach file" size="sm" noTooltip />
        </Dropdown>
      </div>
      {atts?.map((a) =>
        a.mime === LINK_MIME ? (
          <RichLink
            key={a.id}
            url={a.path}
            title={a.name}
            onRename={(name) => void api.attachments.rename(a.id, name).then(() => invalidate("attachments"))}
            onRemove={() => void removeAttachment(a)}
            trailing={
              <IconButton
                icon={X}
                label="Remove link"
                size="sm"
                onClick={() => void removeAttachment(a)}
              />
            }
          />
        ) : (
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
            onClick={() => void removeAttachment(a)}
          />
        </div>
        ),
      )}
    </div>
  );
}

function MilestoneProp({ task, onChange }: { task: Task; onChange: (id: string | null) => void }) {
  const { data: milestones } = useMilestones(task.projectId);
  const m = milestones?.find((x) => x.id === task.milestoneId);
  if (!m && !milestones?.length) return null;
  return (
    <>
      <span className="props__label">
        <FlagIcon /> Milestone
      </span>
      <div className="row" style={{ gap: 0 }}>
        <MilestonePicker
          projectId={task.projectId!}
          value={task.milestoneId ?? null}
          onChange={onChange}
          trigger={
            <button type="button" className="prop-btn" data-empty={!m}>
              <span className="truncate">{m ? m.title : "None"}</span>
            </button>
          }
        />
        {m && <IconButton icon={ChevronRight} label="Open milestone" size="sm" onClick={() => openMilestone(m.id)} />}
      </div>
    </>
  );
}
