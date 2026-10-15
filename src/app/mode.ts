/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// Full Kern or Kern Lite. Both run over the same data in the same window;
// the backend resizes the window and remembers each mode's geometry.

import { create } from "zustand";
import { api, isTauri } from "@/lib/ipc";
import { setSetting } from "@/stores/settings";
import { flushWorkspaces } from "@/features/workspace/store";

export type AppMode = "kern" | "lite";

interface ModeState {
  /** null while the startup choice is showing; undefined before loading. */
  mode: AppMode | null | undefined;
}

export const useMode = create<ModeState>(() => ({ mode: undefined }));

/** Reads the mode the window opened in (and whether to ask first). */
export async function loadMode() {
  if (!isTauri) return useMode.setState({ mode: "kern" });
  const info = await api.app.mode().catch(() => ({ mode: "kern" as const, ask: false }));
  useMode.setState({ mode: info.ask ? null : info.mode });
}

let switching: Promise<void> | null = null;

/** Switches between Kern and Kern Lite (resizing the window to suit). */
export async function switchMode(next: AppMode, opts: { remember?: boolean } = {}) {
  if (opts.remember) void setSetting("general.startMode", next);
  if (useMode.getState().mode === next) {
    if (isTauri) void api.app.setMode(next);
    return;
  }
  await switching;
  flushWorkspaces();
  switching = (async () => {
    // Resize first, so the new layout never renders squeezed into the old window.
    if (isTauri) await api.app.setMode(next).catch(() => undefined);
    useMode.setState({ mode: next });
  })();
  await switching;
  switching = null;
}
