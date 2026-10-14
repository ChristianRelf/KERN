// Rebuilding the interface after the data underneath it was swapped (a
// different cloud space, signing out, or signing in as another account).
// Everything cached or on screen from the old data is thrown away and the
// shell remounts, so nothing waits for a click to catch up.

import { create } from "zustand";
import { queryClient } from "@/lib/query";
import { useRouter, type Route } from "@/stores/router";
import { useUndo } from "@/stores/undo";
import { useUi } from "@/stores/ui";
import { useSessions } from "@/features/sessions/store";
import { useFocus } from "@/features/focus/store";

/** Bumped on every reset; the shell is keyed on it. */
export const useEpoch = create<{ epoch: number }>(() => ({ epoch: 0 }));

/** Pages that don't show records from the open space, so they can stay open. */
const NEUTRAL: Route["name"][] = ["settings", "api", "dashboard", "tasks", "inbox", "projects", "whiteboards", "focus", "sessions", "search"];

let shownSpace: string | null | undefined;

/** Remembers which data the interface is showing (set once at startup). */
export function markShownSpace(id: string | null) {
  shownSpace = id;
}

/**
 * Discards everything from the previous data and remounts the shell. A
 * repeat call for the space already shown does nothing, so the switch
 * itself and the backend's change event don't reset twice.
 */
export function resetInterface(spaceId: string | null) {
  if (shownSpace === spaceId) return;
  shownSpace = spaceId;
  void queryClient.cancelQueries();
  queryClient.clear();
  const route = useRouter.getState().route;
  useRouter.setState({ route: NEUTRAL.includes(route.name) && !("id" in route && route.id) ? route : { name: "dashboard" }, back: [], forward: [] });
  useUndo.setState({ stack: [] });
  useUi.setState({ inspector: null, inspectorPinned: false, modalTaskId: null, openFile: null, startWorkTaskId: null, catchupProjectId: null, selectedTaskIds: [], selectionAnchor: null, composer: { open: false, ctx: {} } });
  void useSessions.getState().hydrate();
  void useFocus.getState().hydrate();
  useEpoch.setState((s) => ({ epoch: s.epoch + 1 }));
}
