// Query hooks for phase-3 project resources: repositories, worktrees,
// milestones, commands, environment profiles, services, health and the
// capability summary that decides which tools a project shows.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import type { ProjectCapabilities } from "@/lib/types";

export function useCapabilities(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["capabilities", projectId],
    queryFn: () => api.projects.capabilities(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

/** True when the project has any development resource connected. */
export function isDevProject(c: ProjectCapabilities | undefined, folderPath?: string | null) {
  return !!c && (c.repositories > 0 || c.commands > 0 || c.services > 0 || (!!folderPath && c.hasFolder && c.localRepositories > 0));
}

export function useRepos(projectId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["repos", projectId],
    queryFn: () => api.repos.list(projectId!),
    enabled: !!projectId && enabled,
    staleTime: 30_000,
  });
}

/** Branch, changes and last commit of one repository (needs a trusted local copy). */
export function useRepoSummary(repoId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["git", "summary", repoId],
    queryFn: () => api.repos.summary(repoId!),
    enabled: !!repoId && enabled,
    staleTime: 20_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function useWorktrees(repoId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["worktrees", repoId],
    queryFn: () => api.worktrees.list(repoId!),
    enabled: !!repoId && enabled,
    retry: false,
    staleTime: 15_000,
  });
}

export function useMilestones(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ["milestones", projectId],
    queryFn: () => api.milestones.list(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useMilestone(id: string | null | undefined) {
  return useQuery({ queryKey: ["milestones", "one", id], queryFn: () => api.milestones.get(id!), enabled: !!id });
}

export function useCommands(projectId: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: ["commands", projectId], queryFn: () => api.commands.list(projectId!), enabled: !!projectId && enabled });
}

export function useEnvProfiles(projectId: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: ["env", projectId], queryFn: () => api.env.profiles(projectId!), enabled: !!projectId && enabled });
}

/** Configured services; re-checked on the user's interval while `poll` is on. */
export function useServices(projectId: string | null | undefined, poll = false, intervalSecs = 30) {
  return useQuery({
    queryKey: ["services", projectId, poll],
    queryFn: () => (poll ? api.services.checkProject(projectId!) : api.services.list(projectId!)),
    enabled: !!projectId,
    refetchInterval: poll ? Math.max(10, intervalSecs) * 1000 : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useHealth(projectId: string | null | undefined) {
  return useQuery({ queryKey: ["health", projectId], queryFn: () => api.health.get(projectId!), enabled: !!projectId, staleTime: 30_000 });
}

export function useTaskDevContext(taskId: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: ["devlinks", taskId], queryFn: () => api.devLinks.context(taskId!), enabled: !!taskId && enabled });
}

/** GitHub data fetched earlier (no network). */
export function useGithubCached(projectId: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: ["github", "cached", projectId], queryFn: () => api.github.cached(projectId!), enabled: !!projectId && enabled, staleTime: 60_000 });
}
