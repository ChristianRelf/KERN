import { Dialog as D } from "radix-ui";
import { CircleCheck, Circle, FileText, FolderKanban, ListFilter, Presentation, Search, SquareKanban, Tag, Type, CornerDownLeft } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "@/stores/ui";
import { useProjects, useRecent, useViews, useWhiteboards } from "@/hooks/data";
import { api } from "@/lib/ipc";
import type { SearchHit } from "@/lib/types";
import { fuzzyFilter } from "@/lib/fuzzy";
import { navigate } from "@/stores/router";
import { getCommands, type Command } from "./commands";
import { openTask } from "@/features/tasks/menu";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { Kbd } from "@/components/ui/Button";
import { resolveBindings } from "@/lib/shortcuts";
import { useSetting } from "@/stores/settings";

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
  }
}

export function openHit(h: SearchHit) {
  switch (h.kind) {
    case "task":
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
      if (h.parentId) navigate({ name: "whiteboard", id: h.parentId });
      break;
    case "label":
      navigate({ name: "label", id: h.id });
      break;
    case "view":
      navigate({ name: "view", id: h.id });
      break;
  }
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
};

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
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: projects } = useProjects();
  const { data: views } = useViews();
  const { data: whiteboards } = useWhiteboards();
  const { data: recent } = useRecent(6);
  const bindings = resolveBindings(useSetting("keyboard.shortcuts"));
  const commands = useMemo(() => getCommands(), []);

  // Full-text search, lightly debounced; commands filter instantly.
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void api
        .search(query, 24)
        .then((r) => !cancelled && setHits(r))
        .catch(() => !cancelled && setHits([]));
    }, 70);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q]);

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
    if (!query) {
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
      return out;
    }
    const cmds = fuzzyFilter(commands, query, (c) => c.title, (c) => c.keywords ?? "").slice(0, 6);
    for (const c of cmds) out.push(cmd(c));
    const seen = new Set<string>();
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
    for (const v of fuzzyFilter(views ?? [], query, (v) => v.name).slice(0, 3)) {
      seen.add(`view:${v.id}`);
      out.push({ key: `view:${v.id}`, section: "Saved views", icon: <ListFilter />, title: v.name, run: run(() => navigate({ name: "view", id: v.id })) });
    }
    for (const w of fuzzyFilter(whiteboards ?? [], query, (w) => w.name).slice(0, 3)) {
      seen.add(`whiteboard:${w.id}`);
      out.push({ key: `whiteboard:${w.id}`, section: "Whiteboards", icon: <Presentation />, title: w.name, run: run(() => navigate({ name: "whiteboard", id: w.id })) });
    }
    const order = ["task", "note", "project", "board", "whiteboard", "wb_node", "label", "view"];
    for (const h of [...hits].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
      const key = `${h.kind}:${h.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        key,
        section: KIND_SECTION[h.kind],
        icon: hitIcon(h),
        title: h.title || h.snippet || "Untitled",
        subtitle: h.kind === "wb_node" ? h.meta ?? undefined : h.snippet && h.snippet !== h.title ? h.snippet : undefined,
        run: run(() => openHit(h)),
      });
    }
    out.push({
      key: "search-all",
      section: "Search",
      icon: <Search />,
      title: `Search everything for “${query}”`,
      run: run(() => navigate({ name: "search", q: query })),
    });
    return out;
  }, [q, commands, projects, views, whiteboards, recent, hits, bindings, close]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let lastSection = "";
  return (
    <>
      <div className="palette__input">
        <Search />
        <input
          autoFocus
          value={q}
          placeholder="Search or type a command…"
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
            } else if (e.key === "Home" && e.ctrlKey) {
              setActive(0);
            }
          }}
        />
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
        {!items.length && <div className="empty empty--compact">No results</div>}
      </div>
    </>
  );
}

