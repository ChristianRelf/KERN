import { memo, type CSSProperties } from "react";
import { CalendarDays, ClockAlert, Ellipsis, GripVertical, ListChecks, Paperclip, Pin, Repeat, Timer } from "lucide-react";
import type { Label, Project, Task } from "@/lib/types";
import { TaskCheck } from "@/components/ui/Controls";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { dueState, formatDue, formatDuration } from "@/lib/dates";
import { PriorityIcon } from "./meta";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { DuePopover } from "./pickers";
import { taskMenu } from "./menu";
import { toggleComplete, updateTask } from "./actions";
import type { Settings } from "@/features/settings/schema";

export interface RowContext {
  projects: Project[];
  projectMap: Map<string, Project>;
  labelMap: Map<string, Label>;
  labels: Label[];
  meta: Settings["appearance.taskMeta"];
  expanded: boolean;
  hideProject?: boolean;
  today: string;
  selection: string[];
}

export function DueLabel({ date, time, done, today }: { date: string | null; time?: string | null; done: boolean; today: string }) {
  if (!date) return null;
  const st = dueState(date, done, today);
  return (
    <span className="due" data-state={st ?? undefined}>
      {st === "overdue" ? <ClockAlert /> : <CalendarDays />}
      {formatDue(date, time, today)}
    </span>
  );
}

function TaskRowInner({
  task: t,
  ctx,
  focused,
  selected,
  onClick,
  dragHandle,
  dragging,
  style,
  rowRef,
}: {
  task: Task;
  ctx: RowContext;
  focused: boolean;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  dragHandle?: Record<string, unknown>;
  dragging?: boolean;
  style?: CSSProperties;
  rowRef?: (el: HTMLElement | null) => void;
}) {
  const done = t.status === "completed";
  const project = t.projectId ? ctx.projectMap.get(t.projectId) : undefined;
  const labels = ctx.meta.labels ? t.labelIds.map((id) => ctx.labelMap.get(id)).filter(Boolean) as Label[] : [];
  const firstLine = ctx.expanded && t.description ? t.description.split("\n").find((l) => l.trim())?.replace(/^[#>*\-\s[\]x]+/, "") : "";

  return (
    <div
      ref={rowRef}
      className="task-row"
      role="option"
      aria-selected={selected}
      data-task-id={t.id}
      data-focused={focused || undefined}
      data-selected={selected || undefined}
      data-done={done}
      data-dragging={dragging || undefined}
      style={style}
      onClick={onClick}
    >
      {dragHandle && (
        <span className="drag-handle" {...dragHandle} aria-label="Drag to reorder">
          <GripVertical size={12} />
        </span>
      )}
      <TaskCheck checked={done} onToggle={() => void toggleComplete(t)} priority={t.priority} blocked={t.status === "blocked"} />
      <div className="task-row__main">
        <div className="task-row__line">
          <span className="task-row__title">{t.title}</span>
          {t.pinned && <Pin size={12} className="faint" aria-label="Pinned" />}
          <div className="task-row__meta">
            {labels.slice(0, 2).map((l) => (
              <span key={l.id} className="chip">
                {l.name}
              </span>
            ))}
            {labels.length > 2 && <span className="chip">+{labels.length - 2}</span>}
            {ctx.meta.subtasks && t.subtaskCount > 0 && (
              <span aria-label={`${t.subtaskDone} of ${t.subtaskCount} subtasks`}>
                <ListChecks />
                {t.subtaskDone}/{t.subtaskCount}
              </span>
            )}
            {t.attachmentCount > 0 && (
              <span aria-label={`${t.attachmentCount} attachments`}>
                <Paperclip />
                {t.attachmentCount}
              </span>
            )}
            {t.recurrence && (
              <span aria-label="Repeats">
                <Repeat />
              </span>
            )}
            {ctx.meta.estimate && t.estimateMinutes ? (
              <span>
                <Timer />
                {formatDuration(t.estimateMinutes * 60)}
              </span>
            ) : null}
            {ctx.meta.project && !ctx.hideProject && project && (
              <span className="truncate" style={{ maxWidth: 140 }}>
                <ProjectGlyph project={project} size={13} />
                <span className="truncate">{project.name}</span>
              </span>
            )}
            {ctx.meta.due && <DueLabel date={t.dueDate} time={t.dueTime} done={done} today={ctx.today} />}
            {ctx.meta.priority && t.priority > 0 && !done && <PriorityIcon priority={t.priority} size={13} />}
          </div>
        </div>
        {firstLine && <div className="task-row__desc">{firstLine}</div>}
      </div>
      <div className="task-row__hover" onClick={(e) => e.stopPropagation()}>
        <DuePopover
          date={t.dueDate}
          time={t.dueTime}
          onChange={(d, tm) => void updateTask(t.id, { dueDate: d, dueTime: tm }, { undoLabel: d ? `Due ${formatDue(d)}` : "Date removed" })}
          trigger={<IconButton icon={CalendarDays} label="Set due date" size="sm" />}
        />
        <Dropdown items={() => taskMenu(t, ctx)} align="end">
          <IconButton icon={Ellipsis} label="More actions" size="sm" noTooltip />
        </Dropdown>
      </div>
    </div>
  );
}

export const TaskRow = memo(TaskRowInner);
