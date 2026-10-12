import type { Milestone, MilestoneInput, MilestonePatch } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { prompt, confirmDelete } from "@/components/ui/Dialog";

export const refreshMilestones = () => invalidate("milestones", "tasks", "task", "board", "health", "capabilities", "activity");

export const STATUS_LABEL: Record<Milestone["status"], string> = {
  planned: "Planned",
  active: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function openMilestone(id: string) {
  useUi.getState().openInspector({ kind: "milestone", id });
}

export async function createMilestone(input: Omit<MilestoneInput, "title"> & { title?: string }, open = true) {
  const title = input.title ?? (await prompt({ title: input.isRelease ? "New release" : "New milestone", placeholder: input.isRelease ? "e.g. Beta launch" : "e.g. Finish renovation", confirmLabel: "Create" }));
  if (!title) return null;
  try {
    const m = await api.milestones.create({ ...input, title });
    refreshMilestones();
    if (open) openMilestone(m.id);
    return m;
  } catch (e) {
    toastError(describeError(e, "Couldn't create the milestone."));
    return null;
  }
}

export async function updateMilestone(id: string, patch: MilestonePatch) {
  try {
    const m = await api.milestones.update(id, patch);
    refreshMilestones();
    if (patch.status === "completed") toast(`Milestone reached: ${m.title}`);
    return m;
  } catch (e) {
    toastError(describeError(e));
    return null;
  }
}

export async function deleteMilestone(m: Milestone) {
  const ok = await confirmDelete(`Delete “${m.title}”?`, m.taskTotal ? `Its ${m.taskTotal} task${m.taskTotal === 1 ? "" : "s"} stay in the project; they just leave the milestone.` : "The milestone is removed.");
  if (!ok) return false;
  try {
    await api.milestones.delete(m.id);
    refreshMilestones();
    if (useUi.getState().inspector?.kind === "milestone") useUi.getState().closeInspector();
    return true;
  } catch (e) {
    toastError(describeError(e));
    return false;
  }
}
