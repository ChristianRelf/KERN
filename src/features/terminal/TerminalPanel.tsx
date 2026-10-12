// Bottom terminal drawer: tabs, new terminal in a project folder,
// repository or the default location, shell choice, search, copy/paste,
// clear, stop, resize and maximise within Kern. Lazy-loaded.

import { ChevronDown, Ellipsis, Eraser, Maximize2, Minimize2, Pencil, Plus, Search, Square, SquareTerminal, X, ClipboardCopy, ClipboardPaste, FolderOpen, GitBranch, House } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@/lib/types";
import { api } from "@/lib/ipc";
import { useRouter } from "@/stores/router";
import { useSetting, setSetting } from "@/stores/settings";
import { useProject } from "@/hooks/data";
import { IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { prompt } from "@/components/ui/Dialog";
import { useRepos } from "@/features/dev/hooks";
import { recordWorkspace } from "@/features/workspace/store";
import { applyTerminalTheme, closeTab, live, openTerminal, useTerminal } from "./store";

export default function TerminalPanel() {
  const { tabs, activeId, open, maximized, height, set } = useTerminal();
  const route = useRouter((s) => s.route);
  const scope = useSetting("terminal.scope");
  const themeSetting = useSetting("appearance.theme");
  const projectId = route.name === "project" ? route.id : null;
  const { data: project } = useProject(projectId);
  const shown = useMemo(() => (scope === "project" && projectId ? tabs.filter((t) => !t.projectId || t.projectId === projectId) : tabs), [tabs, scope, projectId]);
  const active = shown.find((t) => t.id === activeId) ?? shown[shown.length - 1];
  const viewport = useRef<HTMLDivElement>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [liveHeight, setLiveHeight] = useState<number | null>(null);

  useEffect(() => applyTerminalTheme(), [themeSetting]);

  // Attach the active terminal's renderer and keep it sized to the panel.
  useEffect(() => {
    const el = viewport.current;
    if (!el || !open || !active) return;
    const l = live.get(active.id);
    if (!l) return;
    if (l.host.parentElement !== el) {
      el.replaceChildren(l.host);
    }
    const fit = () => {
      try {
        l.fit.fit();
      } catch {
        /* not visible yet */
      }
    };
    requestAnimationFrame(fit);
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    l.term.focus();
    return () => {
      ro.disconnect();
      // Hidden terminals must not keep keyboard focus.
      l.term.blur();
    };
  }, [active?.id, open, maximized]);

  useEffect(() => {
    if (projectId) recordWorkspace(projectId, { terminalOpen: open, terminalHeight: height, terminals: tabs.filter((t) => t.projectId === projectId && !t.command).map((t) => ({ title: t.title, cwd: t.cwd, shell: t.shell })) });
  }, [projectId, open, height, tabs]);

  if (!open || !shown.length) return null;

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    let h = height;
    const move = (ev: PointerEvent) => {
      h = Math.max(120, Math.min(window.innerHeight - 160, height - (ev.clientY - startY)));
      setLiveHeight(h);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLiveHeight(null);
      set({ height: Math.round(h) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const l = active ? live.get(active.id) : undefined;
  const actionMenu: MenuItems = [
    { label: "Copy selection", icon: ClipboardCopy, shortcut: "Mod+Shift+C", disabled: !l?.term.hasSelection(), onSelect: () => l && void navigator.clipboard.writeText(l.term.getSelection()) },
    { label: "Paste", icon: ClipboardPaste, shortcut: "Mod+Shift+V", onSelect: () => active && void navigator.clipboard.readText().then((t) => t && void api.pty.write(active.id, t)) },
    { label: "Clear", icon: Eraser, onSelect: () => l?.term.clear() },
    { type: "separator" },
    {
      label: "Rename…",
      icon: Pencil,
      onSelect: async () => {
        if (!active) return;
        const t = await prompt({ title: "Rename terminal", initial: active.title });
        if (!t) return;
        await api.pty.rename(active.id, t).catch(() => undefined);
        set({ tabs: tabs.map((x) => (x.id === active.id ? { ...x, title: t } : x)) });
      },
    },
    active?.running && { label: "Stop process", icon: Square, danger: true, onSelect: () => void api.pty.kill(active.id) },
    { type: "separator" },
    { label: scope === "project" ? "Show all terminals" : "Show only this project's terminals", onSelect: () => void setSetting("terminal.scope", scope === "project" ? "all" : "project") },
  ];

  return (
    <section className="terminal-panel" data-maximized={maximized || undefined} style={{ "--term-h": `${liveHeight ?? height}px` } as CSSProperties} aria-label="Terminal">
      {!maximized && <div className="resize-handle terminal-resize" onPointerDown={startResize} role="separator" aria-label="Resize terminal" />}
      <div className="terminal-bar">
        <div className="terminal-tabs" role="tablist">
          {shown.map((t) => (
            <div key={t.id} role="tab" aria-selected={t.id === active?.id} className="terminal-tab" data-active={t.id === active?.id || undefined} onClick={() => set({ activeId: t.id })} onAuxClick={(e) => e.button === 1 && void closeTab(t.id)} title={`${t.command ?? t.shell} - ${t.cwd}`}>
              <span className="terminal-tab__dot" data-running={t.running || undefined} aria-hidden />
              <span className="truncate">{t.title}</span>
              <button type="button" className="terminal-tab__close" aria-label={`Close ${t.title}`} onClick={(e) => (e.stopPropagation(), void closeTab(t.id))}>
                <X size={12} />
              </button>
            </div>
          ))}
          <NewTerminalMenu project={project ?? null} />
        </div>
        <span className="spacer" />
        {searching && (
          <input
            className="input input--sm terminal-search"
            autoFocus
            placeholder="Find"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              l?.search.findNext(e.target.value, { incremental: true });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.shiftKey ? l?.search.findPrevious(query) : l?.search.findNext(query));
              if (e.key === "Escape") (setSearching(false), l?.term.focus());
            }}
            aria-label="Find in terminal"
          />
        )}
        <IconButton icon={Search} label="Find" size="sm" active={searching} onClick={() => setSearching(!searching)} />
        <Dropdown items={actionMenu} align="end">
          <IconButton icon={Ellipsis} label="Terminal actions" size="sm" noTooltip />
        </Dropdown>
        <IconButton icon={maximized ? Minimize2 : Maximize2} label={maximized ? "Restore" : "Maximise"} size="sm" onClick={() => set({ maximized: !maximized })} />
        <IconButton icon={ChevronDown} label="Hide terminal" shortcut="Mod+`" size="sm" onClick={() => set({ open: false, maximized: false })} />
      </div>
      <div className="terminal-viewport" ref={viewport} />
    </section>
  );
}

function NewTerminalMenu({ project }: { project: Project | null }) {
  const { data: repos } = useRepos(project?.id, !!project);
  const { data: shells } = useQuery({ queryKey: ["pty", "shells"], queryFn: api.pty.shells, staleTime: Infinity });
  const preferred = useSetting("terminal.shell");
  const local = (repos ?? []).filter((r) => r.localPath && r.localStatus !== "missing" && r.localPath.toLowerCase() !== project?.folderPath?.toLowerCase());
  const items: MenuItems = [
    !!project?.folderPath && { label: `${project.name} folder`, icon: FolderOpen, onSelect: () => void openTerminal({ projectId: project.id }) },
    ...local.map((r) => ({ label: r.name, icon: GitBranch, onSelect: () => void openTerminal({ projectId: project!.id, cwd: { kind: "repository", repositoryId: r.id } }) })),
    { label: "Default location", icon: House, onSelect: () => void openTerminal({ projectId: project?.id ?? null, cwd: { kind: "default" } }) },
    { type: "separator" },
    {
      type: "submenu",
      label: "Shell",
      icon: SquareTerminal,
      items: (shells ?? []).map((s, i) => ({ label: s.name, checked: preferred ? preferred === s.id : i === 0, onSelect: () => void setSetting("terminal.shell", s.id) })),
    },
  ];
  return (
    <Dropdown items={items} align="start">
      <IconButton icon={Plus} label="New terminal" size="sm" noTooltip />
    </Dropdown>
  );
}
