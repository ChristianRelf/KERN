/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Pushes a GitHub-linked task's edits to its issue shortly after they
// happen (debounced, so a burst of edits makes one request). Kept free of
// feature imports so task actions can use it without import cycles.

import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { getSetting } from "@/stores/settings";

const timers = new Map<string, number>();

export function scheduleIssuePush(taskId: string) {
  if (!getSetting("github.pushOnEdit")) return;
  window.clearTimeout(timers.get(taskId));
  timers.set(
    taskId,
    window.setTimeout(() => {
      timers.delete(taskId);
      void api.github
        .syncTask(taskId)
        .then(() => invalidate("task", "tasks"))
        .catch((e) => toastError(`GitHub: ${describeError(e, "couldn't update the issue.")}`));
    }, 1500),
  );
}

/** Lowercase slug for branch names: "Fix login bug!" → "fix-login-bug". */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}
