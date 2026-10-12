// The full task composer: a compact modal with a roomy title, an optional
// description and metadata chips. Rarely used properties stay behind "+".
// Mounted only while open; Enter in the title creates, Mod+Enter creates
// from anywhere, Escape cancels.

import { Dialog as D } from "radix-ui";
import {
  Bell,
  CalendarDays,
  CalendarRange,
  CircleDashed,
  FolderKanban,
  Hourglass,
  Plus,
  Repeat,
  Tag,
  X,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Recurrence, TaskStatus } from "@/lib/types";
import { useUi, type ComposerContext } from "@/stores/ui";
import { useLabelMap, useProjects, useBoard } from "@/hooks/data";
import { Button, IconButton, Kbd } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { Switch } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { parseQuickTask } from "./parse";
import { ParsedTokens } from "./QuickAdd";
import { DuePopover, LabelPicker, ProjectPicker, RecurrencePicker, describeRecurrence } from "./pickers";
import { PRIORITY_LABELS, PriorityIcon, STATUS_LABELS, StatusIcon } from "./meta";
import { createTask } from "./actions";
import { buildTaskInput, contextDefaults, rememberProps, rememberedProps } from "./creation";
import { formatDue, formatDuration, formatTime } from "@/lib/dates";
import { getSetting } from "@/stores/settings";
import { toast } from "@/stores/toast";
import { openTask } from "./menu";

type Extra = "status" | "start" | "estimate" | "repeat" | "reminder";

export function TaskComposer() {
  const open = useUi((s) => s.composer.open);
  const close = useUi((s) => s.closeComposer);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <D.Root open={open} onOpenChange={(o) => !o && close()}>
      <D.Portal>
        <D.Overlay className="dialog-overlay" />
        <D.Content
          className="dialog composer"
          aria-describedby={undefined}
          // Focus the title synchronously so typing never waits for the entrance.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            ref.current?.focus();
          }}
        >
          {open && <ComposerBody ctx={useUi.getState().composer.ctx} titleRef={ref} onClose={close} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function Chip({ icon, label, tooltip, empty, onClear }: { icon: ReactNode; label: ReactNode; tooltip: string; empty?: boolean; onClear?: () => void }) {
  return (
    <Tooltip content={tooltip}>
      <button type="button" className="chip chip-btn composer__chip" data-empty={empty || undefined}>
        {icon}
        <span className="truncate">{label}</span>
        {onClear && !empty && (
          <span
            role="button"
            tabIndex={-1}
            className="composer__chip-clear"
            aria-label={`Clear ${tooltip.toLowerCase()}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
          >
            <X />
          </span>
        )}
      </button>
    </Tooltip>
  );
}

function ComposerBody({ ctx, titleRef, onClose }: { ctx: ComposerContext; titleRef: React.RefObject<HTMLInputElement | null>; onClose: () => void }) {
  const remembered = useMemo(rememberedProps, []);
  const { data: projects } = useProjects();
  const labelMap = useLabelMap();
  const [title, setTitle] = useState(ctx.title ?? "");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState<string | null>(ctx.projectId ?? null);
  const [dueDate, setDueDate] = useState<string | null>(ctx.dueDate ?? null);
  const [dueTime, setDueTime] = useState<string | null>(null);
  const [priority, setPriority] = useState<number>(remembered.priority ?? getSetting("tasks.defaultPriority"));
  const [labelIds, setLabelIds] = useState<string[]>(ctx.labelIds ?? remembered.labelIds ?? []);
  const [status, setStatus] = useState<TaskStatus | null>(ctx.status ?? null);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null);
  const [reminder, setReminder] = useState<number | null>(null);
  const [extras, setExtras] = useState<Set<Extra>>(() => new Set(ctx.status && !ctx.columnId ? ["status"] : []));
  const [createMore, setCreateMore] = useState(!!remembered.createMore);
  const [busy, setBusy] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);

  const project = projects?.find((p) => p.id === projectId);
  const parsed = useMemo(() => parseQuickTask(title, { projects: projects ?? [] }), [title, projects]);
  const { data: board } = useBoard(ctx.columnId && projectId === ctx.projectId ? (projects?.find((p) => p.id === ctx.projectId)?.defaultBoardId ?? null) : null);
  const column = board?.columns.find((c) => c.id === ctx.columnId);

  useLayoutEffect(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(240, Math.max(44, el.scrollHeight))}px`;
  }, [description]);

  const reset = () => {
    setTitle("");
    setDescription("");
    titleRef.current?.focus();
  };

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const defaults = contextDefaults({ ...ctx, projectId, dueDate, labelIds });
    // Picking a different project drops the board placement of the original.
    if (projectId !== (ctx.projectId ?? null)) defaults.columnId = null;
    defaults.priority = priority;
    if (dueTime && dueDate) defaults.dueTime = dueTime;
    if (status) defaults.status = status;
    if (startDate) defaults.startDate = startDate;
    if (estimate) defaults.estimateMinutes = estimate;
    if (recurrence) defaults.recurrence = recurrence;
    if (reminder !== null) defaults.reminderMinutes = reminder;
    const input = await buildTaskInput(title, projects ?? [], defaults);
    if (description.trim()) input.description = description;
    const t = await createTask(input, { quiet: true });
    setBusy(false);
    if (!t) return; // error toast offers retry; the form keeps its content
    rememberProps({ priority, labelIds: ctx.labelIds ? remembered.labelIds : labelIds, createMore });
    toast(t.status === "inbox" ? "Added to Inbox" : t.dueDate ? `Added for ${formatDue(t.dueDate)}` : "Task created", {
      action: { label: "Open", run: () => openTask(t.id) },
    });
    if (createMore) reset();
    else onClose();
  };

  const show = (e: Extra) => setExtras((s) => new Set(s).add(e));
  const hide = (e: Extra) =>
    setExtras((s) => {
      const n = new Set(s);
      n.delete(e);
      return n;
    });

  const labelNames = labelIds.map((id) => labelMap.get(id)?.name).filter(Boolean) as string[];
  const placement = project ? `${project.name}${column ? ` · ${column.name}` : ""}` : null;

  return (
    <div
      className="composer__body"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="composer__head">
        <D.Title className="composer__heading">New task</D.Title>
        {placement && <span className="composer__context truncate">{placement}</span>}
        <span className="spacer" />
        <D.Close asChild>
          <IconButton icon={X} label="Close" size="sm" noTooltip />
        </D.Close>
      </div>

      <input
        ref={titleRef}
        className="composer__title"
        value={title}
        placeholder="What needs doing?"
        aria-label="Task title"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
            e.preventDefault();
            void submit();
          } else if (e.key === "ArrowDown" && !title.includes("\n")) {
            descRef.current?.focus();
          }
        }}
      />
      <ParsedTokens parsed={parsed} />
      <textarea
        ref={descRef}
        className="composer__desc"
        value={description}
        placeholder="Add a description…"
        aria-label="Description"
        onChange={(e) => setDescription(e.target.value)}
      />

      <div className="composer__chips">
        <ProjectPicker
          value={projectId}
          onChange={setProjectId}
          trigger={
            <span>
              <Chip
                icon={project ? <ProjectGlyph project={project} size={12} /> : <FolderKanban />}
                label={project?.name ?? (status === "inbox" || (!ctx.status && getSetting("tasks.defaultDestination") === "inbox") ? "Inbox" : "No project")}
                tooltip="Project"
                empty={!project}
              />
            </span>
          }
        />
        <DuePopover
          date={dueDate}
          time={dueTime}
          onChange={(d, t) => {
            setDueDate(d);
            setDueTime(d ? t : null);
          }}
          trigger={
            <span>
              <Chip
                icon={<CalendarDays />}
                label={dueDate ? `${formatDue(dueDate)}${dueTime ? ` ${formatTime(dueTime)}` : ""}` : "Due date"}
                tooltip="Due date"
                empty={!dueDate}
                onClear={() => {
                  setDueDate(null);
                  setDueTime(null);
                }}
              />
            </span>
          }
        />
        <Dropdown
          items={[4, 3, 2, 1, 0].map((p) => ({ label: PRIORITY_LABELS[p], shortcut: String(p), checked: priority === p, onSelect: () => setPriority(p) }))}
        >
          <span>
            <Chip
              icon={priority > 0 ? <PriorityIcon priority={priority} size={12} /> : <PriorityIcon priority={0} size={12} />}
              label={priority > 0 ? PRIORITY_LABELS[priority] : "Priority"}
              tooltip="Priority"
              empty={priority === 0}
            />
          </span>
        </Dropdown>
        <LabelPicker
          value={labelIds}
          onToggle={(id, on) => setLabelIds((l) => (on ? [...l, id] : l.filter((x) => x !== id)))}
          trigger={
            <span>
              <Chip
                icon={<Tag />}
                label={labelNames.length ? labelNames.slice(0, 2).join(", ") + (labelNames.length > 2 ? ` +${labelNames.length - 2}` : "") : "Labels"}
                tooltip="Labels"
                empty={!labelNames.length}
                onClear={() => setLabelIds([])}
              />
            </span>
          }
        />

        {extras.has("status") && (
          <Dropdown
            items={(["inbox", "todo", "in_progress", "blocked"] as TaskStatus[]).map((s) => ({
              label: STATUS_LABELS[s],
              checked: (status ?? "todo") === s,
              onSelect: () => setStatus(s),
            }))}
          >
            <span>
              <Chip icon={<StatusIcon status={status ?? "todo"} size={12} />} label={STATUS_LABELS[status ?? "todo"]} tooltip="Status" onClear={() => (setStatus(null), hide("status"))} />
            </span>
          </Dropdown>
        )}
        {extras.has("start") && (
          <DuePopover
            date={startDate}
            withTime={false}
            onChange={(d) => setStartDate(d)}
            trigger={
              <span>
                <Chip icon={<CalendarRange />} label={startDate ? `Starts ${formatDue(startDate)}` : "Start date"} tooltip="Start date" empty={!startDate} onClear={() => (setStartDate(null), hide("start"))} />
              </span>
            }
          />
        )}
        {extras.has("estimate") && (
          <Dropdown items={[15, 30, 60, 90, 120, 240, 480].map((m) => ({ label: formatDuration(m * 60), checked: estimate === m, onSelect: () => setEstimate(m) }))}>
            <span>
              <Chip icon={<Hourglass />} label={estimate ? formatDuration(estimate * 60) : "Estimate"} tooltip="Estimate" empty={!estimate} onClear={() => (setEstimate(null), hide("estimate"))} />
            </span>
          </Dropdown>
        )}
        {extras.has("repeat") && (
          <RecurrencePicker
            value={recurrence}
            dueDate={dueDate}
            onChange={setRecurrence}
            trigger={
              <span>
                <Chip icon={<Repeat />} label={recurrence ? describeRecurrence(recurrence) : "Repeat"} tooltip="Repeat" empty={!recurrence} onClear={() => (setRecurrence(null), hide("repeat"))} />
              </span>
            }
          />
        )}
        {extras.has("reminder") && (
          <Dropdown
            items={[0, 5, 15, 30, 60, 120].map((m) => ({ label: m === 0 ? "At due time" : `${formatDuration(m * 60)} before`, checked: reminder === m, onSelect: () => setReminder(m) }))}
          >
            <span>
              <Chip
                icon={<Bell />}
                label={reminder === null ? "Reminder" : reminder === 0 ? "At due time" : `${formatDuration(reminder * 60)} before`}
                tooltip="Reminder (needs a due time)"
                empty={reminder === null}
                onClear={() => (setReminder(null), hide("reminder"))}
              />
            </span>
          </Dropdown>
        )}
        {extras.size < 5 && (
          <Dropdown
            items={[
              !extras.has("status") && { label: "Status", icon: CircleDashed, onSelect: () => show("status") },
              !extras.has("start") && { label: "Start date", icon: CalendarRange, onSelect: () => show("start") },
              !extras.has("estimate") && { label: "Estimate", icon: Hourglass, onSelect: () => show("estimate") },
              !extras.has("repeat") && { label: "Repeat", icon: Repeat, onSelect: () => show("repeat") },
              !extras.has("reminder") && { label: "Reminder", icon: Bell, onSelect: () => show("reminder") },
            ]}
          >
            <IconButton icon={Plus} label="More properties" size="sm" className="composer__more" />
          </Dropdown>
        )}
      </div>

      <div className="composer__foot">
        <label className="composer__more-toggle">
          <Switch
            checked={createMore}
            onChange={(v) => {
              setCreateMore(v);
              rememberProps({ createMore: v });
            }}
            label="Create more"
          />
          Create more
        </label>
        <span className="spacer" />
        <span className="composer__hint">
          <Kbd combo="Mod+Enter" />
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!title.trim() || busy}>
          Create
        </Button>
      </div>
    </div>
  );
}
