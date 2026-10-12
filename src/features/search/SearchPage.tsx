import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SearchHit } from "@/lib/types";
import { api } from "@/lib/ipc";
import { hitIcon, openHit } from "./CommandPalette";
import { EmptyState, Segmented } from "@/components/ui/Controls";
import { useProjectMap } from "@/hooks/data";

type Filter = "all" | "task" | "note" | "project" | "whiteboard";

const KIND_LABEL: Record<SearchHit["kind"], string> = {
  task: "Task",
  project: "Project",
  note: "Note",
  board: "Board",
  whiteboard: "Whiteboard",
  wb_node: "Whiteboard card",
  label: "Label",
  view: "Saved view",
  milestone: "Milestone",
  command: "Command",
  snapshot: "Workspace",
  issue: "GitHub issue",
  pull: "Pull request",
  commit: "Commit",
};

export default function SearchPage({ initial }: { initial?: string }) {
  const [q, setQ] = useState(initial ?? "");
  const [debounced, setDebounced] = useState(q);
  const [filter, setFilter] = useState<Filter>("all");
  const projects = useProjectMap();
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q), 120);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data: hits, isFetching } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.search(debounced, 200),
    enabled: debounced.trim().length > 0,
  });
  const shown = useMemo(
    () =>
      (hits ?? []).filter((h) =>
        filter === "all" ? true : filter === "whiteboard" ? h.kind === "whiteboard" || h.kind === "wb_node" : h.kind === filter,
      ),
    [hits, filter],
  );
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <Search /> Search
        </h1>
      </header>
      <div className="toolbar">
        <div className="input-wrap" style={{ flex: 1, maxWidth: 520 }}>
          <Search />
          <input className="input" autoFocus placeholder="Search tasks, notes, projects, whiteboards…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </div>
        <Segmented<Filter>
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "task", label: "Tasks" },
            { value: "note", label: "Notes" },
            { value: "project", label: "Projects" },
            { value: "whiteboard", label: "Whiteboards" },
          ]}
        />
      </div>
      <div className="page-body page-body--pad">
        <div style={{ maxWidth: 860 }}>
          {!debounced.trim() && <EmptyState icon={Search}>Search across everything stored on this computer.</EmptyState>}
          {debounced.trim() && !isFetching && !shown.length && <EmptyState icon={Search}>No results for “{debounced}”.</EmptyState>}
          {shown.map((h) => {
            const project = h.parentId && h.kind !== "wb_node" ? projects.get(h.parentId) : undefined;
            return (
              <div key={`${h.kind}:${h.id}`} className="list-row" role="button" tabIndex={0} onClick={() => openHit(h)} onKeyDown={(e) => e.key === "Enter" && openHit(h)}>
                {hitIcon(h)}
                <div className="col grow" style={{ minWidth: 0 }}>
                  <span className="truncate" style={h.meta === "completed" ? { color: "var(--text-3)", textDecoration: "line-through" } : undefined}>
                    {h.title || "Untitled"}
                  </span>
                  {h.snippet && h.snippet !== h.title && <span className="list-row__sub truncate selectable">{h.snippet}</span>}
                </div>
                <span className="list-row__sub">
                  {KIND_LABEL[h.kind]}
                  {project ? ` · ${project.name}` : h.kind === "wb_node" && h.meta ? ` · ${h.meta}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
