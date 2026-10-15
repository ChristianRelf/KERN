/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { useRef } from "react";
import type { Task } from "@/lib/types";
import { useFlip } from "@/hooks/useFlip";
import { TaskCheck, TaskTitle } from "@/components/ui/Controls";
import { ContextMenu } from "@/components/ui/Menu";
import { toggleComplete } from "@/features/tasks/actions";
import { openTask, taskMenu } from "@/features/tasks/menu";
import { DueLabel } from "@/features/tasks/TaskRow";
import { PriorityIcon } from "@/features/tasks/meta";
import { useLabels, useProjectMap, useProjects } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";

export function MiniTask({
  task,
  showDue = true,
  showProject = false,
  trailing,
}: {
  task: Task;
  showDue?: boolean;
  showProject?: boolean;
  trailing?: React.ReactNode;
}) {
  const today = useToday();
  const { data: projects } = useProjects();
  const { data: labels } = useLabels();
  const projectMap = useProjectMap();
  const done = task.status === "completed";
  const project = showProject && task.projectId ? projectMap.get(task.projectId) : undefined;
  return (
    <ContextMenu items={() => taskMenu(task, { projects: projects ?? [], labels: labels ?? [] })}>
      <div className="mini-task" data-done={done} data-flip-id={task.id} onClick={() => openTask(task.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && openTask(task.id)}>
        <TaskCheck checked={done} onToggle={() => void toggleComplete(task)} priority={task.priority} blocked={task.status === "blocked" || !!task.blockedBy} cancelled={!!task.resolution} />
        <span className="mini-task__title">
          <TaskTitle title={task.title} done={done} />
        </span>
        <span className="mini-task__meta">
          {project && (
            <span className="row truncate" style={{ gap: 4, maxWidth: 110 }}>
              <ProjectGlyph project={project} size={12} />
              <span className="truncate">{project.name}</span>
            </span>
          )}
          {showDue && <DueLabel date={task.dueDate} time={task.dueTime} done={done} today={today} />}
          {task.priority > 0 && !done && <PriorityIcon priority={task.priority} size={12} />}
          {trailing}
        </span>
      </div>
    </ContextMenu>
  );
}

export function MiniTaskList({
  tasks,
  max,
  showDue,
  showProject,
  onMore,
}: {
  tasks: Task[];
  max?: number;
  showDue?: boolean;
  showProject?: boolean;
  onMore?: () => void;
}) {
  const visible = max ? tasks.slice(0, max) : tasks;
  const more = tasks.length - visible.length;
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, tasks);
  return (
    <div className="mini-list" ref={ref}>
      {visible.map((t) => (
        <MiniTask key={t.id} task={t} showDue={showDue} showProject={showProject} />
      ))}
      {more > 0 && (
        <button type="button" className="mini-more" onClick={onMore}>
          +{more} more
        </button>
      )}
    </div>
  );
}
