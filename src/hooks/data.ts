// Query hooks for persisted data. Keys start with a domain name so
// mutations can invalidate whole domains (see lib/query.ts).

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/lib/ipc";
import type { Project, TaskQuery } from "@/lib/types";
import { dayBounds } from "@/lib/dates";
import { useToday } from "./useToday";

export function useProjects(includeArchived = false) {
  return useQuery({
    queryKey: ["projects", { includeArchived }],
    queryFn: () => api.projects.list(includeArchived),
    staleTime: 60_000,
  });
}

export function useProjectMap(): Map<string, Project> {
  const { data } = useProjects(true);
  return useMemo(() => new Map((data ?? []).map((p) => [p.id, p])), [data]);
}

export function useProject(id: string | null | undefined) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => api.projects.get(id!),
    enabled: !!id,
  });
}

export function useGroups() {
  return useQuery({ queryKey: ["groups"], queryFn: api.groups.list, staleTime: 5 * 60_000 });
}

export function useLabels() {
  return useQuery({ queryKey: ["labels"], queryFn: api.labels.list, staleTime: 60_000 });
}

export function useLabelMap() {
  const { data } = useLabels();
  return useMemo(() => new Map((data ?? []).map((l) => [l.id, l])), [data]);
}

export function useTasks(query: TaskQuery, opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["tasks", query],
    queryFn: () => api.tasks.query(query),
    enabled: opts?.enabled ?? true,
    placeholderData: keepPreviousData,
  });
}

export function useTask(id: string | null | undefined) {
  return useQuery({ queryKey: ["task", id], queryFn: () => api.tasks.get(id!), enabled: !!id });
}

export function useSubtasks(parentId: string | null | undefined) {
  return useTasks({ parentId: parentId ?? undefined, includeCompleted: true, order: "manual" }, { enabled: !!parentId });
}

export function useViews() {
  return useQuery({ queryKey: ["views"], queryFn: api.views.list, staleTime: 5 * 60_000 });
}

export function useBoards(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["boards", projectId],
    queryFn: () => api.boards.list(projectId!),
    enabled: !!projectId,
  });
}

export function useBoard(id: string | null | undefined) {
  return useQuery({ queryKey: ["board", id], queryFn: () => api.boards.get(id!), enabled: !!id });
}

export function useNotes(projectId?: string | null, includeArchived = false) {
  return useQuery({
    queryKey: ["notes", { projectId: projectId ?? null, includeArchived }],
    queryFn: () => api.notes.list(projectId, includeArchived),
  });
}

export function useInbox() {
  return useQuery({ queryKey: ["inbox"], queryFn: api.inbox.list });
}

export function useWhiteboards(projectId?: string | null) {
  return useQuery({
    queryKey: ["whiteboards", projectId ?? null],
    queryFn: () => api.whiteboards.list(projectId),
  });
}

export function useRecent(limit = 12) {
  return useQuery({ queryKey: ["recent", limit], queryFn: () => api.recent.list(limit) });
}

export function useActivity(projectId?: string | null, limit = 40) {
  return useQuery({
    queryKey: ["activity", projectId ?? null, limit],
    queryFn: () => api.activity.list(projectId, limit),
  });
}

export function useAttachments(target: { taskId?: string; projectId?: string }) {
  return useQuery({
    queryKey: ["attachments", target],
    queryFn: () => api.attachments.list(target),
    enabled: !!(target.taskId || target.projectId),
  });
}

export function useOverview() {
  const today = useToday();
  return useQuery({
    queryKey: ["stats", "overview", today],
    queryFn: () => {
      const b = dayBounds(today);
      return api.stats.overview(today, b.dayStart, b.weekStart);
    },
  });
}

export function useDashboards() {
  return useQuery({ queryKey: ["dashboards"], queryFn: api.dashboards.list, staleTime: Infinity });
}

/**
 * Polls GitHub releases for a newer version every minute while Kern is
 * visible (unchanged lists are answered from the backend's ETag cache).
 * Failures stay silent.
 */
export function useUpdateCheck() {
  return useQuery({
    queryKey: ["updateCheck"],
    queryFn: api.system.checkForUpdate,
    staleTime: 55 * 1000,
    refetchInterval: 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useAppInfo() {
  return useQuery({ queryKey: ["appInfo"], queryFn: api.system.info, staleTime: Infinity });
}

