// Integrated terminal state. Each tab is a real pseudoterminal in the Rust
// backend; its xterm.js renderer is created when the tab is (so output is
// never lost while the panel is closed) and xterm itself is only loaded the
// first time a terminal opens. Nothing is typed into a terminal by Kern:
// shells start empty and commands run only when the user starts them.

import { create } from "zustand";
import type { CwdTarget, PtyInfo, RunSpec } from "@/lib/types";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import { api, describeError, isTauri } from "@/lib/ipc";
import { getSetting } from "@/stores/settings";
import { comboFromEvent, resolveBindings, SHORTCUTS } from "@/lib/shortcuts";
import { toastError } from "@/stores/toast";
import { confirm } from "@/components/ui/Dialog";

export interface TermTab extends PtyInfo {}

interface Live {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  host: HTMLDivElement;
}

/** xterm instances by terminal id (kept outside React so they survive re-renders). */
export const live = new Map<string, Live>();
const early = new Map<string, string[]>();

interface TermState {
  tabs: TermTab[];
  activeId: string | null;
  open: boolean;
  maximized: boolean;
  height: number;
  set: (p: Partial<TermState>) => void;
}

export const useTerminal = create<TermState>((set) => ({
  tabs: [],
  activeId: null,
  open: false,
  maximized: false,
  height: 260,
  set: (p) => set(p),
}));

let xtermModules: Promise<{
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
  SearchAddon: typeof import("@xterm/addon-search").SearchAddon;
  WebLinksAddon: typeof import("@xterm/addon-web-links").WebLinksAddon;
}> | null = null;

function loadXterm() {
  xtermModules ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-search"), import("@xterm/addon-web-links"), import("@xterm/xterm/css/xterm.css")]).then(
    ([x, f, s, w]) => ({ Terminal: x.Terminal, FitAddon: f.FitAddon, SearchAddon: s.SearchAddon, WebLinksAddon: w.WebLinksAddon }),
  );
  return xtermModules;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function theme() {
  const light = document.documentElement.dataset.theme === "light";
  return {
    background: css("--bg-sunken") || (light ? "#efefef" : "#0d0d0d"),
    foreground: css("--text") || (light ? "#1a1a1a" : "#ededed"),
    cursor: css("--text-2") || "#a9a9a9",
    selectionBackground: light ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.2)",
    black: light ? "#1f1f1f" : "#2a2a2a",
    brightBlack: "#6b6b6b",
    red: "#d27a78",
    green: "#8bb795",
    yellow: "#cfae74",
    blue: "#7f9fd6",
    magenta: "#b98fc9",
    cyan: "#6fb2b0",
    white: light ? "#4a4a4a" : "#d4d4d4",
  };
}

export function applyTerminalTheme() {
  for (const l of live.values()) l.term.options.theme = theme();
}

async function createRenderer(id: string) {
  const { Terminal, FitAddon, SearchAddon, WebLinksAddon } = await loadXterm();
  const term = new Terminal({
    fontFamily: css("--font-mono") || "Consolas, monospace",
    fontSize: getSetting("terminal.fontSize"),
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: theme(),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => {
      void import("@/features/links/links").then((m) => m.openLink(uri));
    }),
  );
  // Ctrl/Cmd+Shift+C / V copy and paste; plain Ctrl+C stays an interrupt.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.code === "KeyC") {
      const sel = term.getSelection();
      if (sel) void navigator.clipboard.writeText(sel);
      return false;
    }
    if (mod && e.shiftKey && e.code === "KeyV") {
      void navigator.clipboard.readText().then((t) => t && void api.pty.write(id, t));
      return false;
    }
    // Kern's own global shortcuts (palette, capture, new task, terminal) stay Kern's.
    const combo = comboFromEvent(e);
    if (combo && globalCombos().has(combo)) return false;
    return true;
  });
  term.onData((d) => void api.pty.write(id, d).catch(() => undefined));
  term.onResize(({ cols, rows }) => void api.pty.resize(id, cols, rows).catch(() => undefined));
  const host = document.createElement("div");
  host.className = "term-host";
  term.open(host);
  live.set(id, { term, fit, search, host });
  for (const chunk of early.get(id) ?? []) term.write(chunk);
  early.delete(id);
  return live.get(id)!;
}

function globalCombos(): Set<string> {
  const bindings = resolveBindings(getSetting("keyboard.shortcuts"));
  return new Set(SHORTCUTS.filter((d) => d.global && bindings[d.id]).map((d) => bindings[d.id]!));
}

let listening = false;
/** Subscribes to backend terminal output once. */
export function startTerminalEvents() {
  if (listening || !isTauri) return;
  listening = true;
  void import("@tauri-apps/api/event").then(({ listen }) => {
    void listen<{ id: string; data: string }>("kern://pty-data", (e) => {
      const l = live.get(e.payload.id);
      if (l) l.term.write(e.payload.data);
      else early.set(e.payload.id, [...(early.get(e.payload.id) ?? []), e.payload.data]);
    });
    void listen<{ id: string; code: number | null }>("kern://pty-exit", (e) => {
      const { id, code } = e.payload;
      live.get(id)?.term.write(`\r\n\x1b[2m[process exited${code !== null ? ` with code ${code}` : ""}]\x1b[0m\r\n`);
      useTerminal.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, running: false, exitCode: code } : t)) }));
    });
  });
}

/** Where a project's terminal starts: its folder, else its primary local repository. */
async function projectStart(projectId: string): Promise<CwdTarget> {
  const p = await api.projects.get(projectId).catch(() => null);
  if (p?.folderPath) return { kind: "project", projectId };
  const repos = await api.repos.list(projectId).catch(() => []);
  const local = repos.find((r) => r.localPath && r.localStatus === "ok");
  return local ? { kind: "repository", repositoryId: local.id } : { kind: "default" };
}

/**
 * The size a new shell starts at, close to what the panel will fit, so the
 * first prompt isn't drawn at one width and re-wrapped at another.
 */
function initialSize(): { cols: number; rows: number } {
  const first = live.values().next().value;
  if (first) return { cols: first.term.cols, rows: first.term.rows };
  const fontSize = getSetting("terminal.fontSize");
  let cell = fontSize * 0.6;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      ctx.font = `${fontSize}px ${css("--font-mono") || "Consolas, monospace"}`;
      cell = ctx.measureText("W").width || cell;
    }
  } catch {
    /* estimate */
  }
  const width = (document.querySelector(".workspace__main")?.clientWidth ?? window.innerWidth) - 24;
  const height = useTerminal.getState().height - 44;
  return { cols: Math.max(40, Math.floor(width / cell)), rows: Math.max(8, Math.floor(height / Math.ceil(fontSize * 1.2))) };
}

export interface OpenOptions {
  cwd?: CwdTarget;
  projectId?: string | null;
  shell?: string | null;
  run?: RunSpec | null;
  title?: string | null;
}

/** Opens a new terminal tab (and the panel). */
export async function openTerminal(opts: OpenOptions = {}) {
  startTerminalEvents();
  const projectId = opts.projectId ?? null;
  const cwd: CwdTarget = opts.cwd ?? (projectId ? await projectStart(projectId) : { kind: "default" });
  try {
    await loadXterm();
    const info = await api.pty.spawn({ cwd, shell: opts.shell ?? (getSetting("terminal.shell") || null), run: opts.run ?? null, projectId, title: opts.title ?? null, ...initialSize() });
    await createRenderer(info.id);
    useTerminal.setState((s) => ({ tabs: [...s.tabs, info], activeId: info.id, open: true }));
    return info;
  } catch (e) {
    // A project without a folder falls back to the default location.
    if (cwd.kind === "project" && !opts.run) {
      const msg = describeError(e, "");
      if (/isn't linked to a folder/.test(msg)) return openTerminal({ ...opts, cwd: { kind: "default" } });
    }
    toastError(describeError(e, "Couldn't open a terminal."));
    return null;
  }
}

/** Runs a saved command (or a detected script) in a new tab. */
export async function runInTerminal(projectId: string, run: RunSpec, cwd?: CwdTarget, title?: string) {
  return openTerminal({ projectId, run, cwd: cwd ?? { kind: "project", projectId }, title });
}

export async function closeTab(id: string, ask = true) {
  const tab = useTerminal.getState().tabs.find((t) => t.id === id);
  if (ask && tab?.running && tab.command) {
    const ok = await confirm({ title: `Stop “${tab.title}”?`, message: "The process (and anything it started) is stopped.", confirmLabel: "Stop and close", danger: true });
    if (!ok) return;
  }
  void api.pty.close(id).catch(() => undefined);
  live.get(id)?.term.dispose();
  live.delete(id);
  useTerminal.setState((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id);
    const idx = s.tabs.findIndex((t) => t.id === id);
    return { tabs, activeId: s.activeId === id ? (tabs[Math.max(0, idx - 1)]?.id ?? null) : s.activeId, open: tabs.length ? s.open : false };
  });
}

export function toggleTerminal(projectId?: string | null) {
  const s = useTerminal.getState();
  if (!s.tabs.length) {
    void openTerminal({ projectId: projectId ?? null });
    return;
  }
  s.set({ open: !s.open });
}

/** Re-attaches to terminals still running in the backend after a reload. */
export async function reattachTerminals() {
  if (!isTauri) return;
  startTerminalEvents();
  const list = await api.pty.list().catch(() => [] as PtyInfo[]);
  if (!list.length) return;
  await loadXterm();
  for (const t of list) if (!live.has(t.id)) await createRenderer(t.id);
  useTerminal.setState({ tabs: list, activeId: list[list.length - 1].id });
}

export function ensureRenderer(id: string) {
  return live.get(id) ?? null;
}
