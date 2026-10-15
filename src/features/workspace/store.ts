/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Resume Workspace: per-project UI context (tab, board, whiteboard, open
// task, open file, selected repository, terminals, panel sizes) saved as a
// small document, so reopening a project feels like returning to it.
//
// Writes are debounced and coalesced (never per pixel), and flushed when
// leaving a project, hiding the window or closing the app. Restoring is
// best-effort: anything that no longer exists is skipped and reported once.
// Resuming never runs commands, restarts services or starts agents.

import { useQuery } from "@tanstack/react-query";
import type { WorkspaceSnapshot, WorkspaceState } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { navigate, onBeforeNavigate } from "@/stores/router";
import { useUi } from "@/stores/ui";
import { toast, toastError } from "@/stores/toast";
import { prompt } from "@/components/ui/Dialog";

const pending = new Map<string, WorkspaceState>();
const timers = new Map<string, number>();
const SAVE_DELAY = 1500;

function key(projectId: string) {
  return ["workspace", projectId] as const;
}

function persist(projectId: string) {
  window.clearTimeout(timers.get(projectId));
  timers.delete(projectId);
  const state = pending.get(projectId);
  if (!state) return;
  pending.delete(projectId);
  void api.workspace.save(projectId, { ...state, savedAt: Date.now() }).catch(() => undefined);
}

/** Saves everything pending now (navigation, hiding, quitting). */
export function flushWorkspaces() {
  for (const id of [...pending.keys()]) persist(id);
}

if (typeof window !== "undefined") {
  onBeforeNavigate(flushWorkspaces);
  window.addEventListener("beforeunload", flushWorkspaces);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushWorkspaces());
}

/** Merges a change into a project's workspace and schedules a save. */
export function recordWorkspace(projectId: string, patch: Partial<WorkspaceState>) {
  const base = pending.get(projectId) ?? queryClient.getQueryData<WorkspaceState | null>(key(projectId)) ?? {};
  const next = { ...base, ...patch };
  if (JSON.stringify(next) === JSON.stringify(base)) return;
  pending.set(projectId, next);
  queryClient.setQueryData(key(projectId), next);
  window.clearTimeout(timers.get(projectId));
  timers.set(projectId, window.setTimeout(() => persist(projectId), SAVE_DELAY));
}

export function useWorkspaceState(projectId: string) {
  return useQuery({ queryKey: key(projectId), queryFn: () => api.workspace.get(projectId), staleTime: Infinity, gcTime: 30 * 60_000 });
}

export function useSnapshots(projectId: string, enabled = true) {
  return useQuery({ queryKey: ["workspace", "snapshots", projectId], queryFn: () => api.workspace.snapshots(projectId), enabled });
}

/** One-shot request to restore context on the next project render. */
let resumeRequested: string | null = null;
export const requestResume = (projectId: string) => (resumeRequested = projectId);
export function takeResumeRequest(projectId: string) {
  if (resumeRequested !== projectId) return false;
  resumeRequested = null;
  return true;
}

/**
 * Restores the parts of a workspace that aren't encoded in the route (open
 * task, open file), skipping anything that no longer exists.
 */
export async function restoreContext(projectId: string, ws: WorkspaceState) {
  const missing: string[] = [];
  if (ws.taskId) {
    const t = await api.tasks.get(ws.taskId).catch(() => null);
    if (t && !t.deletedAt && !t.archivedAt) useUi.getState().openInspector({ kind: "task", id: t.id });
    else missing.push("a task");
  }
  if (ws.openFile) {
    const ok = await api.folders.path(projectId, ws.openFile.rel, ws.openFile.repositoryId ?? null).then(
      () => true,
      () => false,
    );
    if (ok) useUi.getState().set({ openFile: { projectId, rel: ws.openFile.rel, repositoryId: ws.openFile.repositoryId ?? null } });
    else missing.push(ws.openFile.rel.split("/").pop() ?? "a file");
  }
  if (missing.length) toast(`Resumed - ${missing.join(", ")} from last time ${missing.length === 1 ? "isn't" : "aren't"} available anymore.`);
}

/** Opens a project and restores its last context. */
export async function resumeProject(projectId: string) {
  flushWorkspaces();
  const ws = await queryClient.fetchQuery({ queryKey: key(projectId), queryFn: () => api.workspace.get(projectId), staleTime: Infinity });
  const boards = ws?.boardId ? await api.boards.list(projectId).catch(() => []) : [];
  const boardOk = !ws?.boardId || boards.some((b) => b.id === ws.boardId);
  const wbOk = !ws?.whiteboardId || (await api.whiteboards.list(projectId).catch(() => [])).some((w) => w.id === ws.whiteboardId);
  requestResume(projectId);
  navigate({
    name: "project",
    id: projectId,
    tab: ws?.tab,
    boardId: boardOk ? ws?.boardId ?? undefined : undefined,
    whiteboardId: wbOk ? ws?.whiteboardId ?? undefined : undefined,
  });
  if (!boardOk || !wbOk) toast(`Resumed - the ${!boardOk ? "board" : "whiteboard"} you had open isn't available anymore.`);
}

/** "Resume work": the most recently opened project, plus the running session. */
export async function resumeWork() {
  const projects = await api.projects.list().catch(() => []);
  const last = [...projects].filter((p) => p.lastOpenedAt).sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))[0];
  const { useSessions } = await import("@/features/sessions/store");
  const session = useSessions.getState().active;
  const target = session?.projectId ?? last?.id;
  if (!target) {
    toast("Nothing to resume yet. Open a project to start.");
    return;
  }
  await resumeProject(target);
  if (session) useSessions.getState().setPanel(true);
}

export async function saveSnapshot(projectId: string, current: WorkspaceState, existing?: WorkspaceSnapshot) {
  const name = existing?.name ?? (await prompt({ title: "Save workspace", placeholder: "e.g. Bug fixing, Planning, Review", confirmLabel: "Save" }));
  if (!name) return;
  try {
    await api.workspace.saveSnapshot(projectId, name, current, existing?.id ?? null);
    invalidate("workspace");
    toast(`Saved “${name}”`);
  } catch (e) {
    toastError(describeError(e, "Couldn't save the workspace."));
  }
}

export async function applySnapshot(s: WorkspaceSnapshot) {
  queryClient.setQueryData(key(s.projectId), s.state);
  pending.set(s.projectId, s.state);
  persist(s.projectId);
  await resumeProject(s.projectId);
}
