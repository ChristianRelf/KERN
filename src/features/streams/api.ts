// Streams in Kern Cloud: requests for the open space's streams, query keys,
// and small helpers shared by the Streams page.

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import type { GithubRepoCheck, Stream, StreamConfig, StreamDetail, StreamEvent, StreamEventStatus, StreamList, StreamOutcome, StreamPreview } from "@/lib/types";

const base = (space: string) => `/spaces/${space}/streams`;

export const streamKeys = {
  all: (space: string) => ["cloud", "streams", space] as const,
  detail: (space: string, id: string) => ["cloud", "streams", space, id] as const,
  events: (space: string, id: string, filter: string) => ["cloud", "streams", space, id, "events", filter] as const,
};

/** Deep partial: settings are sent as partial updates and merged on the server. */
export type ConfigPatch = { [K in keyof StreamConfig]?: Partial<StreamConfig[K]> };

export const streamsApi = {
  list: (space: string) => api.cloud.request<StreamList>("GET", base(space)),
  get: (space: string, id: string) => api.cloud.request<StreamDetail>("GET", `${base(space)}/${id}`),
  create: (space: string, input: { name: string; description?: string; preset?: string }) =>
    api.cloud.request<{ stream: Stream; secret: string }>("POST", base(space), input),
  update: (space: string, id: string, patch: { name?: string; description?: string; enabled?: boolean; config?: ConfigPatch }) =>
    api.cloud.request<Stream>("PATCH", `${base(space)}/${id}`, patch),
  remove: (space: string, id: string) => api.cloud.request("DELETE", `${base(space)}/${id}`),
  rotate: (space: string, id: string, graceHours: number) => api.cloud.request<{ stream: Stream; secret: string }>("POST", `${base(space)}/${id}/rotate`, { graceHours }),
  reveal: (space: string, id: string) => api.cloud.request<{ secret: string }>("POST", `${base(space)}/${id}/reveal`),
  revokePrevious: (space: string, id: string) => api.cloud.request<Stream>("POST", `${base(space)}/${id}/revoke-previous`),
  setGithubToken: (space: string, id: string, token: string | null) =>
    api.cloud.request<{ stream: Stream; check: GithubRepoCheck | null }>("PUT", `${base(space)}/${id}/github`, { token }),
  checkGithub: (space: string, id: string) => api.cloud.request<{ check: GithubRepoCheck; checkedAt: string }>("POST", `${base(space)}/${id}/github/check`),
  setTurnstile: (space: string, id: string, secret: string | null) => api.cloud.request<Stream>("PUT", `${base(space)}/${id}/turnstile`, { secret }),
  preview: (space: string, id: string, payload: Record<string, unknown>, config?: StreamConfig) =>
    api.cloud.request<StreamPreview>("POST", `${base(space)}/${id}/preview`, { payload, config }),
  test: (space: string, id: string, payload: Record<string, unknown>) => api.cloud.request<StreamOutcome>("POST", `${base(space)}/${id}/test`, { payload }),
  events: (space: string, id: string, opts: { before?: number; status?: StreamEventStatus[] } = {}) => {
    const q = new URLSearchParams({ limit: "50" });
    if (opts.before) q.set("before", String(opts.before));
    if (opts.status?.length) q.set("status", opts.status.join(","));
    return api.cloud.request<{ events: StreamEvent[]; hasMore: boolean }>("GET", `${base(space)}/${id}/events?${q}`);
  },
  event: (space: string, id: string, eventId: number) => api.cloud.request<StreamEvent>("GET", `${base(space)}/${id}/events/${eventId}`),
  redeliver: (space: string, id: string, eventId: number) => api.cloud.request<StreamOutcome>("POST", `${base(space)}/${id}/events/${eventId}/redeliver`),
  block: (space: string, id: string, eventId: number) => api.cloud.request<Stream>("POST", `${base(space)}/${id}/events/${eventId}/block`),
  clearEvents: (space: string, id: string) => api.cloud.request<{ removed: number }>("DELETE", `${base(space)}/${id}/events`),
};

export function useStreamList(space: string | undefined, enabled = true) {
  return useQuery({ queryKey: streamKeys.all(space ?? "-"), queryFn: () => streamsApi.list(space!), enabled: !!space && enabled, staleTime: 15_000 });
}

export function useStreamDetail(space: string, id: string) {
  return useQuery({ queryKey: streamKeys.detail(space, id), queryFn: () => streamsApi.get(space, id), staleTime: 10_000 });
}

/** Refreshes everything shown about a space's streams. */
export function refreshStreams(space: string) {
  return queryClient.invalidateQueries({ queryKey: streamKeys.all(space) });
}

export const STATUS_TEXT: Record<StreamEventStatus, string> = {
  delivered: "Delivered",
  partial: "Partly delivered",
  rejected: "Rejected",
  duplicate: "Duplicate",
  spam: "Spam",
  failed: "Failed",
};

export const ACTION_TEXT = { task: "Task", inbox: "Inbox item", issue: "GitHub issue", task_issue: "Task + GitHub issue" } as const;
export const AUTH_TEXT = { public: "Public", token: "Secret token", signature: "Signed requests" } as const;
