/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Task creation logic shared by the full composer, quick capture, inline
// quick-add and board columns. Each surface is only a presentation; how a
// task's properties are resolved from context, typed tokens and explicit
// choices lives here.

import type { Project, TaskInput } from "@/lib/types";
import { useUi, type ComposerContext } from "@/stores/ui";
import { useRouter } from "@/stores/router";
import { getSetting, useSettings } from "@/stores/settings";
import { api } from "@/lib/ipc";
import { todayStr } from "@/lib/dates";
import { parseQuickTask } from "./parse";
import { inputFromParsed } from "./QuickAdd";
import { defaultTaskPlacement } from "./actions";

/** Defaults implied by where the task is being created. */
export function contextDefaults(ctx: ComposerContext): Partial<TaskInput> {
  const base: Partial<TaskInput> = ctx.projectId
    ? { projectId: ctx.projectId, status: ctx.status ?? "todo" }
    : ctx.status
      ? { status: ctx.status, priority: getSetting("tasks.defaultPriority") }
      : defaultTaskPlacement();
  if (ctx.columnId) base.columnId = ctx.columnId;
  if (ctx.dueDate) base.dueDate = ctx.dueDate;
  if (ctx.labelIds?.length) base.labelIds = [...ctx.labelIds];
  if (ctx.parentId) base.parentId = ctx.parentId;
  return base;
}

/**
 * Typed tokens ("tomorrow 3pm p2 #Website") win over explicit choices, which
 * win over context defaults. A task given a project leaves the Inbox.
 */
export async function buildTaskInput(text: string, projects: Pick<Project, "id" | "name">[], defaults: Partial<TaskInput>): Promise<TaskInput> {
  const parsed = parseQuickTask(text, { projects });
  const input = await inputFromParsed(parsed, defaults);
  if (!input.title.trim()) input.title = text.trim();
  if (input.projectId && input.status === "inbox") input.status = "todo";
  return input;
}

/** Context for "New task" from wherever the user currently is. */
export function contextFromRoute(): ComposerContext {
  const r = useRouter.getState().route;
  switch (r.name) {
    case "project":
      return { projectId: r.id };
    case "inbox":
      return { status: "inbox" };
    case "label":
      return { labelIds: [r.id] };
    case "tasks":
      return r.view === "today" ? { dueDate: todayStr() } : {};
    default:
      return {};
  }
}

/** Opens the user's preferred creation interface with the given context. */
export function openNewTask(ctx: ComposerContext = contextFromRoute()) {
  const ui = useUi.getState();
  // Quick capture can't carry board placement, so columns always use the composer.
  if (getSetting("interaction.createInterface") === "quick" && !ctx.columnId && !ctx.parentId) {
    ui.openCapture("task", { projectId: ctx.projectId ?? null, dueDate: ctx.dueDate ?? null });
  } else {
    ui.openComposer(ctx);
  }
}

export interface RememberedTaskProps {
  priority?: number;
  labelIds?: string[];
  createMore?: boolean;
}

export function rememberedProps(): RememberedTaskProps {
  if (!getSetting("interaction.rememberTaskProps")) return {};
  const raw = useSettings.getState().raw["internal.lastTaskProps"];
  return raw && typeof raw === "object" ? (raw as RememberedTaskProps) : {};
}

export function rememberProps(p: RememberedTaskProps) {
  if (!getSetting("interaction.rememberTaskProps")) return;
  const next = { ...rememberedProps(), ...p };
  useSettings.setState((s) => ({ raw: { ...s.raw, "internal.lastTaskProps": next } }));
  void api.settings.set({ "internal.lastTaskProps": next }).catch(() => undefined);
}
