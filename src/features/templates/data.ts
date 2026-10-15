import { useQuery } from "@tanstack/react-query";
import type { TemplateMeta } from "@/lib/types";
import { api } from "@/lib/ipc";

export function useTemplates(kind?: TemplateMeta["kind"]) {
  return useQuery({ queryKey: ["templates", kind ?? "all"], queryFn: () => api.templates.list(kind), staleTime: 60_000 });
}
