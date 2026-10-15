/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { CalendarDays, Clock, Flag, FolderKanban, Plus, Repeat, Tag } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { Label, TaskInput } from "@/lib/types";
import { useLabels, useProjects } from "@/hooks/data";
import { parseQuickTask, type ParsedTask } from "./parse";
import { createTask } from "./actions";
import { createLabel } from "./labels";
import { invalidate } from "@/lib/query";
import { formatDue, formatTime } from "@/lib/dates";
import { PRIORITY_LABELS } from "./meta";
import { describeRecurrence } from "./pickers";
import { getSetting } from "@/stores/settings";

export async function resolveLabelIds(names: string[]): Promise<string[]> {
  if (!names.length) return [];
  const made: Label[] = [];
  for (const n of names) made.push(await createLabel(n, made)); // returns the existing label if present
  const ids = made.map((l) => l.id);
  invalidate("labels");
  return ids;
}

/** Merges parsed quick-add tokens over contextual defaults. */
export async function inputFromParsed(parsed: ParsedTask, defaults: Partial<TaskInput>): Promise<TaskInput> {
  const labelIds = [...(defaults.labelIds ?? []), ...(await resolveLabelIds(parsed.labelNames))];
  const input: TaskInput = {
    priority: getSetting("tasks.defaultPriority"),
    ...defaults,
    title: parsed.title,
    labelIds,
  };
  if (parsed.dueDate) input.dueDate = parsed.dueDate;
  if (parsed.dueTime) input.dueTime = parsed.dueTime;
  if (parsed.priority !== undefined) input.priority = parsed.priority;
  if (parsed.projectId) {
    input.projectId = parsed.projectId;
    input.columnId = null;
    if (input.status === "inbox") input.status = "todo";
  }
  if (parsed.recurrence) {
    input.recurrence = { ...parsed.recurrence, fromCompletion: getSetting("tasks.recurrenceFromCompletion") };
  }
  return input;
}

export function ParsedTokens({ parsed }: { parsed: ParsedTask }) {
  if (!parsed.tokens.length) return null;
  return (
    <div className="quick-add__tokens">
      {parsed.dueDate && (
        <span className="chip chip--strong">
          <CalendarDays />
          {formatDue(parsed.dueDate)}
        </span>
      )}
      {parsed.dueTime && (
        <span className="chip chip--strong">
          <Clock />
          {formatTime(parsed.dueTime)}
        </span>
      )}
      {parsed.priority !== undefined && (
        <span className="chip chip--strong">
          <Flag />
          {PRIORITY_LABELS[parsed.priority]}
        </span>
      )}
      {parsed.projectName && (
        <span className="chip chip--strong">
          <FolderKanban />
          {parsed.projectName}
        </span>
      )}
      {parsed.labelNames.map((l) => (
        <span key={l} className="chip chip--strong">
          <Tag />
          {l}
        </span>
      ))}
      {parsed.recurrence && (
        <span className="chip chip--strong">
          <Repeat />
          {describeRecurrence(parsed.recurrence)}
        </span>
      )}
    </div>
  );
}

export function QuickAdd({
  defaults,
  placeholder = "Add task",
  autoFocus,
  onCreated,
}: {
  defaults: Partial<TaskInput>;
  placeholder?: string;
  autoFocus?: boolean;
  onCreated?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: projects } = useProjects();
  useLabels();
  const ref = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseQuickTask(text, { projects: projects ?? [] }), [text, projects]);

  const submit = async () => {
    if (!parsed.title.trim() || busy) return;
    setBusy(true);
    const input = await inputFromParsed(parsed, defaults);
    const t = await createTask(input, { quiet: true });
    setBusy(false);
    if (t) {
      setText("");
      onCreated?.();
      ref.current?.focus();
    }
  };

  return (
    <div className="quick-add" onClick={() => ref.current?.focus()}>
      <div className="quick-add__line">
        <Plus strokeWidth={1.75} />
        <input
          ref={ref}
          value={text}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            } else if (e.key === "Escape") {
              setText("");
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </div>
      <ParsedTokens parsed={parsed} />
    </div>
  );
}
