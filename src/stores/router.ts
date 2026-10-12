// Minimal in-app router with back/forward history. A desktop app has no
// URL bar, so routes are plain typed objects.

import { create } from "zustand";
import type { ProjectTab } from "@/lib/types";

export type TasksView = "list" | "today" | "upcoming" | "calendar" | "board";
export type SettingsSection =
  | "general"
  | "appearance"
  | "dashboard"
  | "tasks"
  | "projects"
  | "whiteboards"
  | "notifications"
  | "rundown"
  | "focus"
  | "keyboard"
  | "data"
  | "performance"
  | "about";

export type Route =
  | { name: "dashboard"; id?: string }
  | { name: "tasks"; view?: TasksView }
  | { name: "inbox" }
  | { name: "projects" }
  | { name: "project"; id: string; tab?: ProjectTab; boardId?: string; whiteboardId?: string }
  | { name: "whiteboards" }
  | { name: "whiteboard"; id: string }
  | { name: "notes"; id?: string }
  | { name: "view"; id: string }
  | { name: "label"; id: string }
  | { name: "search"; q?: string }
  | { name: "settings"; section?: SettingsSection }
  | { name: "trash" }
  | { name: "focus" }
  | { name: "rundown"; day?: string; mode?: "morning" | "evening" }
  | { name: "task"; id: string };

interface RouterState {
  route: Route;
  back: Route[];
  forward: Route[];
  navigate: (r: Route, opts?: { replace?: boolean }) => void;
  goBack: () => void;
  goForward: () => void;
}

const same = (a: Route, b: Route) => JSON.stringify(a) === JSON.stringify(b);

/** Hooks run before navigating away (e.g. flush unsaved edits). */
const leaveHooks = new Set<() => void>();
export function onBeforeNavigate(fn: () => void) {
  leaveHooks.add(fn);
  return () => {
    leaveHooks.delete(fn);
  };
}

export const useRouter = create<RouterState>((set, get) => ({
  route: { name: "dashboard" },
  back: [],
  forward: [],
  navigate: (r, opts) => {
    const cur = get().route;
    if (same(cur, r)) return;
    leaveHooks.forEach((fn) => fn());
    if (opts?.replace) set({ route: r });
    else set({ route: r, back: [...get().back.slice(-49), cur], forward: [] });
  },
  goBack: () => {
    const { back, route, forward } = get();
    if (!back.length) return;
    leaveHooks.forEach((fn) => fn());
    set({ route: back[back.length - 1], back: back.slice(0, -1), forward: [route, ...forward].slice(0, 50) });
  },
  goForward: () => {
    const { back, route, forward } = get();
    if (!forward.length) return;
    leaveHooks.forEach((fn) => fn());
    set({ route: forward[0], forward: forward.slice(1), back: [...back, route] });
  },
}));

export const navigate = (r: Route, opts?: { replace?: boolean }) => useRouter.getState().navigate(r, opts);
