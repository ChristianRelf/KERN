import { Dialog as D } from "radix-ui";
import {
  CircleCheck,
  Circle,
  FileText,
  FolderKanban,
  ListFilter,
  Presentation,
  Search,
  SquareKanban,
  Tag,
  Type,
  CornerDownLeft,
  Flag,
  SquareTerminal,
  Bookmark,
  CircleDot,
  GitPullRequest,
  GitCommitHorizontal,
  FileCode,
  File as FileIcon,
  Loader2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "@/stores/ui";
import { useProjectMap, useProjects, useRecent, useViews, useWhiteboards } from "@/hooks/data";
import { api } from "@/lib/ipc";
import type { FileHit, SearchHit, SearchScope } from "@/lib/types";
import { fuzzyFilter } from "@/lib/fuzzy";
import { navigate } from "@/stores/router";
import { getCommands, type Command } from "./commands";
import { openTask } from "@/features/tasks/menu";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { Kbd } from "@/components/ui/Button";
import { resolveBindings } from "@/lib/shortcuts";
import { useSetting } from "@/stores/settings";
import { openLink } from "@/features/links/links";
import { confirm } from "@/components/ui/Dialog";
import { requestWhiteboardFocus } from "@/features/whiteboard/focus";

interface Item {
  key: string;
  section: string;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  shortcut?: string | null;
  run: () => void;
}

export function hitIcon(h: SearchHit) {
  switch (h.kind) {
    case "task":
      return h.meta === "completed" ? <CircleCheck /> : <Circle />;
    case "project":
      return <FolderKanban />;
    case "note":
      return <FileText />;
    case "board":
      return <SquareKanban />;
    case "whiteboard":
      return <Presentation />;
    case "wb_node":
      return <Type />;
    case "label":
      return <Tag />;
    case "view":
      return <ListFilter />;
    case "milestone":
      return <Flag />;
    case "command":
      return <SquareTerminal />;
    case "snapshot":
      return <Bookmark />;
    case "issue":
      return <CircleDot />;
    case "pull":
      return <GitPullRequest />;
    case "commit":
      return <GitCommitHorizontal />;
  }
}

export function openHit(h: SearchHit) {
  switch (h.kind) {
    case "task":
    case "issue":
      openTask(h.id);
      break;
    case "project":
      navigate({ name: "project", id: h.id });
      break;
    case "note":
      navigate({ name: "notes", id: h.id });
      break;
    case "board":
      if (h.parentId) navigate({ name: "project", id: h.parentId, tab: "board", boardId: h.id });
      break;
    case "whiteboard":
      navigate({ name: "whiteboard", id: h.id });
      break;
    case "wb_node":
      if (h.parentId) {
        requestWhiteboardFocus(h.parentId, h.id);
        navigate({ name: "whiteboard", id: h.parentId });
      }
      break;
    case "label":
      navigate({ name: "label", id: h.id });
      break;
    case "view":
      navigate({ name: "view", id: h.id });
      break;
    case "milestone":
      if (h.parentId) navigate({ name: "project", id: h.parentId, tab: "milestones" });
      useUi.getState().openInspector({ kind: "milestone", id: h.id });
      break;
    case "command":
      void (async () => {
        if (!h.parentId) return;
        if (!(await confirm({ title: `Run “${h.title}”?`, message: h.snippet, confirmLabel: "Run" }))) return;
        const { runInTerminal } = await import("@/features/terminal/store");
        void runInTerminal(h.parentId, { commandId: h.id }, undefined, h.title);
      })();
      break;
    case "snapshot":
      void (async () => {
        if (!h.parentId) return;
        const snaps = await api.workspace.snapshots(h.parentId);
        const s = snaps.find((x) => x.id === h.id);
        const { applySnapshot } = await import("@/features/workspace/store");
        if (s) void applySnapshot(s);
      })();
      break;
    case "pull":
    case "commit":
      void openLink(h.id);
      break;
  }
}

export function openFileHit(f: FileHit) {
  useUi.getState().set({ openFile: { projectId: f.projectId, rel: f.rel, repositoryId: f.repositoryId } });
}

const KIND_SECTION: Record<SearchHit["kind"], string> = {
  task: "Tasks",
  project: "Projects",
  note: "Notes",
  board: "Boards",
  whiteboard: "Whiteboards",
  wb_node: "Whiteboard text",
  label: "Labels",
  view: "Saved views",
  milestone: "Milestones",
  command: "Saved commands",
  snapshot: "Workspaces",
  issue: "GitHub issues",
  pull: "Pull requests",
  commit: "Commits",
};

const FILTERS: { value: SearchScope; label: string }[] = [
  { value: "all", label: "All" },
  { value: "tasks", label: "Tasks" },
  { value: "projects", label: "Projects" },
  { value: "notes", label: "Notes" },
  { value: "files", label: "Files" },
  { value: "code", label: "Code" },
  { value: "github", label: "GitHub" },
  { value: "commands", label: "Commands" },
];

/** Starts (or refreshes) the linked-folder index once per session, in the background. */
let indexStarted: Promise<unknown> | null = null;
function ensureIndex() {
  indexStarted ??= api.files.index().catch(() => null);
  return indexStarted;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setPalette = useUi((s) => s.setPalette);
  return (
    <D.Root open={open} onOpenChange={(o) => setPalette(o)}>
      <D.Portal>
        <D.Overlay className="dialog-overlay" style={{ background: "var(--backdrop)" }} />
        <D.Content className="palette" aria-describedby={undefined}>
          <D.Title className="sr-only">Command palette</D.Title>
          {open && <PaletteBody close={() => setPalette(false)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function PaletteBody({ close }: { close: () => void }) {
  const initial = useUi.getState().paletteQuery;
  const [q, setQ] = useState(initial);
  const [scope, setScope] = useState<SearchScope>("all");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [indexing, setIndexing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: projects } = useProjects();
  const projectMap = useProjectMap();
  const { data: views } = useViews();
  const { data: whiteboards } = useWhiteboards();
  const { data: recent } = useRecent(6);
  const bindings = resolveBindings(useSetting("keyboard.shortcuts"));
  const indexFiles = useSetting("search.indexFiles");
  const codeSearch = useSetting("search.codeSearch");
  const commands = useMemo(() => getCommands(), []);
  const wantsFiles = indexFiles && (scope === "files" || scope === "code" || scope === "all");

  // Full-text search, lightly debounced; commands filter instantly.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2 || scope === "files" || scope === "code") {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void api
        .search(query, 30, scope)
        .then((r) => !cancelled && setHits(r))
        .catch(() => !cancelled && setHits([]));
    }, 70);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, scope]);

  // Linked files and code: indexed incrementally in the background.
  useEffect(() => {
    const query = q.trim();
    if (!wantsFiles || query.length < 2 || (scope === "code" && !codeSearch)) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(async () => {
      if (!indexStarted) {
        setIndexing(true);
        await ensureIndex();
        if (!cancelled) setIndexing(false);
      }
      const r = await api.files.search(query, scope === "code", null, scope === "all" ? 5 : 30).catch(() => []);
      if (!cancelled) setFiles(r);
    }, scope === "all" ? 160 : 90);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, scope, wantsFiles, codeSearch]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const run = (fn: () => void) => () => {
      close();
      fn();
    };
    const cmd = (c: Command): Item => ({
      key: `cmd:${c.id}`,
      section: c.section === "Appearance" ? "Actions" : c.section,
      icon: <c.icon />,
      title: c.title,
      shortcut: c.shortcut ? bindings[c.shortcut] : undefined,
      run: run(() => void c.run()),
    });
    const query = q.trim();
    const show = (s: SearchScope) => scope === "all" || scope === s;
    if (!query) {
      if (scope === "all") {
        for (const r of recent ?? []) {
          out.push({
            key: `recent:${r.entityType}:${r.entityId}`,
            section: "Recent",
            icon: r.entityType === "project" ? <FolderKanban /> : r.entityType === "note" ? <FileText /> : <Presentation />,
            title: r.title,
            run: run(() =>
              r.entityType === "project"
                ? navigate({ name: "project", id: r.entityId })
                : r.entityType === "note"
                  ? navigate({ name: "notes", id: r.entityId })
                  : navigate({ name: "whiteboard", id: r.entityId }),
            ),
          });
        }
        for (const c of commands.filter((c) => !c.hidden).slice(0, 14)) out.push(cmd(c));
      } else if (scope === "commands") {
        for (const c of commands.filter((c) => !c.hidden)) out.push(cmd(c));
      }
      return out;
    }
    if (show("commands")) for (const c of fuzzyFilter(commands, query, (c) => c.title, (c) => c.keywords ?? "").slice(0, scope === "commands" ? 20 : 6)) out.push(cmd(c));
    const seen = new Set<string>();
    if (show("projects")) {
      for (const p of fuzzyFilter(projects ?? [], query, (p) => p.name).slice(0, 5)) {
        seen.add(`project:${p.id}`);
        out.push({
          key: `project:${p.id}`,
          section: "Projects",
          icon: <ProjectGlyph project={p} size={15} />,
          title: p.name,
          subtitle: p.taskTotal ? `${p.taskDone}/${p.taskTotal} done` : undefined,
          run: run(() => navigate({ name: "project", id: p.id })),
        });
      }
      for (const w of fuzzyFilter(whiteboards ?? [], query, (w) => w.name).slice(0, 3)) {
        seen.add(`whiteboard:${w.id}`);
        out.push({ key: `whiteboard:${w.id}`, section: "Whiteboards", icon: <Presentation />, title: w.name, run: run(() => navigate({ name: "whiteboard", id: w.id })) });
      }
    }
    if (show("tasks")) {
      for (const v of fuzzyFilter(views ?? [], query, (v) => v.name).slice(0, 3)) {
        seen.add(`view:${v.id}`);
        out.push({ key: `view:${v.id}`, section: "Saved views", icon: <ListFilter />, title: v.name, run: run(() => navigate({ name: "view", id: v.id })) });
      }
    }
    const order = ["task", "issue", "note", "milestone", "project", "board", "whiteboard", "wb_node", "pull", "commit", "command", "snapshot", "label", "view"];
    for (const h of [...hits].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
      const key = `${h.kind}:${h.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const project = h.parentId && ["task", "note", "milestone", "board", "whiteboard", "command", "snapshot"].includes(h.kind) ? projectMap.get(h.parentId)?.name : undefined;
      out.push({
        key,
        section: KIND_SECTION[h.kind],
        icon: hitIcon(h),
        title: h.title || h.snippet || "Untitled",
        subtitle: h.kind === "wb_node" ? (h.meta ?? undefined) : h.snippet && h.snippet !== h.title ? h.snippet : (h.meta && h.kind !== "task" && h.kind !== "issue" ? h.meta : project),
        run: run(() => openHit(h)),
      });
    }
    for (const f of files) {
      out.push({
        key: `file:${f.projectId}:${f.repositoryId ?? ""}:${f.rel}`,
        section: f.snippet ? "Code" : "Files",
        icon: f.snippet ? <FileCode /> : <FileIcon />,
        title: f.snippet ? f.rel : f.name,
        subtitle: f.snippet ?? `${projectMap.get(f.projectId)?.name ?? ""} · ${f.rel}`,
        run: run(() => openFileHit(f)),
      });
    }
    if (scope === "all" || scope === "tasks" || scope === "notes" || scope === "projects")
      out.push({
        key: "search-all",
        section: "Search",
        icon: <Search />,
        title: `Search everything for “${query}”`,
        run: run(() => navigate({ name: "search", q: query })),
      });
    return out;
  }, [q, scope, commands, projects, projectMap, views, whiteboards, recent, hits, files, bindings, close]);

  useEffect(() => setActive(0), [q, scope]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const cycle = (dir: 1 | -1) => {
    const i = FILTERS.findIndex((f) => f.value === scope);
    setScope(FILTERS[(i + dir + FILTERS.length) % FILTERS.length].value);
  };

  let lastSection = "";
  return (
    <>
      <div className="palette__input">
        <Search />
        <input
          autoFocus
          value={q}
          placeholder={scope === "all" ? "Search or type a command…" : `Search ${FILTERS.find((f) => f.value === scope)?.label.toLowerCase()}…`}
          aria-label="Search or type a command"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              items[active]?.run();
            } else if (e.key === "Tab") {
              e.preventDefault();
              cycle(e.shiftKey ? -1 : 1);
            } else if (e.key === "Home" && e.ctrlKey) {
              setActive(0);
            }
          }}
        />
        {indexing && <Loader2 size={14} className="spin faint" aria-label="Indexing linked folders" />}
      </div>
      <div className="palette__filters" role="tablist" aria-label="Search in">
        {FILTERS.filter((f) => (f.value !== "files" && f.value !== "code") || indexFiles).filter((f) => f.value !== "code" || codeSearch).map((f) => (
          <button key={f.value} type="button" role="tab" aria-selected={scope === f.value} className="palette__filter" data-on={scope === f.value || undefined} onClick={() => setScope(f.value)}>
            {f.label}
          </button>
        ))}
        <span className="spacer" />
        <span className="faint palette__hint">
          <Kbd>Tab</Kbd> filter
        </span>
      </div>
      <div className="palette__list" ref={listRef} role="listbox">
        {items.map((it, i) => {
          const head = it.section !== lastSection ? it.section : null;
          lastSection = it.section;
          return (
            <div key={it.key}>
              {head && <div className="palette__section">{head}</div>}
              <div
                className="palette__item"
                role="option"
                aria-selected={i === active}
                data-idx={i}
                data-active={i === active || undefined}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={it.run}
              >
                <span className="palette__icon">{it.icon}</span>
                <span className="truncate">{it.title}</span>
                {it.subtitle && <span className="palette__sub truncate">{it.subtitle}</span>}
                <span className="spacer" />
                {it.shortcut && <Kbd combo={it.shortcut} />}
                {i === active && !it.shortcut && <CornerDownLeft size={13} className="faint" />}
              </div>
            </div>
          );
        })}
        {!items.length && <div className="empty empty--compact">{indexing ? "Indexing linked folders…" : q.trim().length < 2 && scope !== "all" && scope !== "commands" ? "Type to search" : "No results"}</div>}
      </div>
    </>
  );
}
