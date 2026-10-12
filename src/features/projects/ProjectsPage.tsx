import { ArrowUpDown, Ellipsis, FolderKanban, LayoutGrid, List, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { Project, ProjectGroup } from "@/lib/types";
import { useGroups, useProjects } from "@/hooks/data";
import { useSetting } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { navigate } from "@/stores/router";
import { Button, IconButton } from "@/components/ui/Button";
import { ContextMenu, Dropdown } from "@/components/ui/Menu";
import { EmptyState, Progress, Segmented } from "@/components/ui/Controls";
import { ProjectGlyph } from "./ProjectGlyph";
import { projectMenu } from "./actions";
import { formatDue, relativeTime } from "@/lib/dates";
import { useToday } from "@/hooks/useToday";
import { dueState } from "@/lib/dates";

type SortKey = "manual" | "name" | "recent" | "progress" | "target";

function sortProjects(list: Project[], key: SortKey) {
  const out = [...list];
  switch (key) {
    case "name":
      return out.sort((a, b) => a.name.localeCompare(b.name));
    case "recent":
      return out.sort((a, b) => (b.lastActivityAt ?? b.updatedAt) - (a.lastActivityAt ?? a.updatedAt));
    case "progress":
      return out.sort((a, b) => (b.taskTotal ? b.taskDone / b.taskTotal : 0) - (a.taskTotal ? a.taskDone / a.taskTotal : 0));
    case "target":
      return out.sort((a, b) => (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999"));
    default:
      return out.sort((a, b) => a.sortOrder - b.sortOrder);
  }
}

function ProjectCard({ p, groups }: { p: Project; groups: ProjectGroup[] }) {
  const today = useToday();
  const pct = p.taskTotal ? p.taskDone / p.taskTotal : 0;
  const ts = p.targetDate ? dueState(p.targetDate, false, today) : null;
  return (
    <ContextMenu items={() => projectMenu(p, groups)}>
      <button type="button" className="project-card" onClick={() => navigate({ name: "project", id: p.id })} style={p.archivedAt ? { opacity: 0.6 } : undefined}>
        <div className="project-card__head">
          <ProjectGlyph project={p} size={20} />
          <span className="project-card__name truncate grow">{p.name}</span>
          {p.pinned && <span className="chip">Pinned</span>}
        </div>
        {p.description && <div className="project-card__desc">{p.description}</div>}
        <div className="project-card__foot">
          <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-xs)" }}>
            <span className="faint">{p.taskTotal ? `${p.taskDone} of ${p.taskTotal} done` : "No tasks yet"}</span>
            <span className="tabular faint">{p.taskTotal ? `${Math.round(pct * 100)}%` : ""}</span>
          </div>
          <Progress value={pct} />
          <div className="project-card__stats">
            {p.taskOverdue > 0 && <span style={{ color: "var(--text)", fontWeight: 600 }}>{p.taskOverdue} overdue</span>}
            {p.targetDate && <span style={ts === "overdue" ? { color: "var(--text)" } : undefined}>Target {formatDue(p.targetDate)}</span>}
            {p.lastActivityAt && <span>Active {relativeTime(p.lastActivityAt)}</span>}
          </div>
        </div>
      </button>
    </ContextMenu>
  );
}

function ProjectRow({ p, groups }: { p: Project; groups: ProjectGroup[] }) {
  const pct = p.taskTotal ? p.taskDone / p.taskTotal : 0;
  return (
    <ContextMenu items={() => projectMenu(p, groups)}>
      <div className="project-list-row" role="button" tabIndex={0} onClick={() => navigate({ name: "project", id: p.id })} onKeyDown={(e) => e.key === "Enter" && navigate({ name: "project", id: p.id })} style={p.archivedAt ? { opacity: 0.6 } : undefined}>
        <span className="row" style={{ gap: 10 }}>
          <ProjectGlyph project={p} />
          <span className="truncate">{p.name}</span>
        </span>
        <span className="row" style={{ gap: 8 }}>
          <Progress value={pct} style={{ flex: 1 }} />
          <span className="tabular faint" style={{ width: 34, textAlign: "right", fontSize: "var(--fs-xs)" }}>
            {Math.round(pct * 100)}%
          </span>
        </span>
        <span className="faint tabular">{p.taskTotal - p.taskDone} open</span>
        <span className="tabular" style={{ color: p.taskOverdue ? "var(--text)" : "var(--text-4)" }}>
          {p.taskOverdue ? `${p.taskOverdue} overdue` : "—"}
        </span>
        <span className="faint">{p.targetDate ? formatDue(p.targetDate) : "—"}</span>
        <span onClick={(e) => e.stopPropagation()}>
          <Dropdown items={() => projectMenu(p, groups)} align="end">
            <IconButton icon={Ellipsis} label="Project actions" size="sm" noTooltip />
          </Dropdown>
        </span>
      </div>
    </ContextMenu>
  );
}

export function ProjectsPage() {
  const { data: projects, isLoading } = useProjects(true);
  const { data: groups } = useGroups();
  const archivedDisplay = useSetting("projects.archivedDisplay");
  const grouping = useSetting("projects.grouping");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sort, setSort] = useState<SortKey>("manual");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (projects ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || p.description.toLowerCase().includes(s));
  }, [projects, q]);
  const active = sortProjects(filtered.filter((p) => !p.archivedAt), sort);
  const archived = sortProjects(filtered.filter((p) => p.archivedAt), sort);

  const sections = useMemo(() => {
    if (grouping !== "groups" || !groups?.length) return [{ key: "all", title: null as string | null, items: active }];
    const out = [{ key: "none", title: groups.length ? "Ungrouped" : null, items: active.filter((p) => !p.groupId || !groups.some((g) => g.id === p.groupId)) }];
    for (const g of groups) out.push({ key: g.id, title: g.name, items: active.filter((p) => p.groupId === g.id) });
    return out.filter((s) => s.items.length);
  }, [active, groups, grouping]);

  const render = (list: Project[]) =>
    view === "grid" ? (
      <div className="project-grid">{list.map((p) => <ProjectCard key={p.id} p={p} groups={groups ?? []} />)}</div>
    ) : (
      <div className="col">{list.map((p) => <ProjectRow key={p.id} p={p} groups={groups ?? []} />)}</div>
    );

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <FolderKanban /> Projects
        </h1>
        {projects && <span className="page-header__sub">{active.length} active</span>}
        <div className="page-header__actions">
          <div className="input-wrap" style={{ width: 180 }}>
            <Search />
            <input className="input" style={{ height: "var(--control-h-sm)" }} placeholder="Find project" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find project" />
          </div>
          <Dropdown
            align="end"
            items={(
              [
                ["manual", "Custom order"],
                ["name", "Name"],
                ["recent", "Recent activity"],
                ["progress", "Progress"],
                ["target", "Target date"],
              ] as [SortKey, string][]
            ).map(([k, l]) => ({ label: l, checked: sort === k, onSelect: () => setSort(k) }))}
          >
            <IconButton icon={ArrowUpDown} label="Sort projects" noTooltip />
          </Dropdown>
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            ariaLabel="Layout"
            options={[
              { value: "grid", icon: LayoutGrid, tooltip: "Grid" },
              { value: "list", icon: List, tooltip: "List" },
            ]}
          />
          <Button size="sm" variant="primary" icon={Plus} onClick={() => useUi.getState().set({ createProjectOpen: true })}>
            New project
          </Button>
        </div>
      </header>
      <div className="page-body page-body--pad">
        {!isLoading && !projects?.length && (
          <EmptyState icon={FolderKanban} title="No projects yet" action={<Button icon={Plus} onClick={() => useUi.getState().set({ createProjectOpen: true })}>Create a project</Button>}>
            Projects keep tasks, boards, whiteboards and notes together.
          </EmptyState>
        )}
        {view === "list" && active.length > 0 && (
          <div className="project-list-row project-list-head">
            <span>Name</span>
            <span>Progress</span>
            <span>Open</span>
            <span>Overdue</span>
            <span>Target</span>
            <span />
          </div>
        )}
        {sections.map((s) => (
          <div key={s.key} style={{ marginBottom: 22 }}>
            {s.title && <div className="section-title" style={{ marginBottom: 10 }}>{s.title} <span className="count">{s.items.length}</span></div>}
            {render(s.items)}
          </div>
        ))}
        {q && !active.length && !archived.length && <EmptyState compact>No projects match “{q}”.</EmptyState>}
        {archivedDisplay === "section" && archived.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="section-title" style={{ marginBottom: 10 }}>
              Archived <span className="count">{archived.length}</span>
            </div>
            {render(archived)}
          </div>
        )}
      </div>
    </div>
  );
}
