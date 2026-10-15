/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Work sessions. The backend is the source of truth (timestamps); this
// store mirrors the active session for display and sends a heartbeat once a
// minute while it runs. A long silence before a heartbeat (sleep, crash, the
// app being closed) is surfaced as a gap the user can keep or exclude, so
// the gap is always checked before the heartbeat moves `lastSeenAt` on.

import { create } from "zustand";
import type { SessionInput, WorkSession } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { getSetting } from "@/stores/settings";

interface SessionState {
  active: WorkSession | null;
  /** Client clock when `active` was fetched, for live elapsed time. */
  fetchedAt: number;
  hydrated: boolean;
  /** A session whose gap is awaiting the user's decision. */
  gap: WorkSession | null;
  panelOpen: boolean;
  hydrate: () => Promise<void>;
  /** Re-reads the active session, checking for a gap, then heartbeats. */
  tick: () => Promise<void>;
  start: (input: SessionInput) => Promise<WorkSession | null>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: (note?: string | null) => Promise<WorkSession | null>;
  update: (patch: Parameters<typeof api.sessions.update>[1]) => Promise<void>;
  resolveGap: (choice: "keep" | "exclude" | "end") => Promise<void>;
  setPanel: (open: boolean) => void;
}

const refreshDomains = () => invalidate("sessions", "devlinks", "task", "tasks", "activity");

export const useSessions = create<SessionState>((set, get) => {
  const apply = (s: WorkSession | null) => set({ active: s && s.status !== "ended" ? s : null, fetchedAt: Date.now() });
  const run = async <T>(fn: () => Promise<T>, fallback: string): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      toastError(describeError(e, fallback));
      return null;
    }
  };
  return {
    active: null,
    fetchedAt: Date.now(),
    hydrated: false,
    gap: null,
    panelOpen: false,

    hydrate: async () => {
      await get().tick();
      set({ hydrated: true });
    },

    tick: async () => {
      if (get().gap) return;
      const s = await api.sessions.active().catch(() => null);
      if (s && s.gapMs && s.status === "running" && getSetting("sessions.gapPrompt")) {
        apply(s);
        set({ gap: s });
        return;
      }
      apply(s);
      if (s?.status === "running") void api.sessions.heartbeat(s.id).catch(() => undefined);
    },

    start: async (input) => {
      const s = await run(() => api.sessions.start(input), "Couldn't start the session.");
      if (s) {
        apply(s);
        refreshDomains();
        toast(s.taskTitle ? `Working on ${s.taskTitle}` : "Session started");
      }
      return s;
    },

    pause: async () => {
      const a = get().active;
      if (!a) return;
      const s = await run(() => api.sessions.pause(a.id), "Couldn't pause the session.");
      if (s) apply(s);
    },

    resume: async () => {
      const a = get().active;
      if (!a) return;
      const s = await run(() => api.sessions.resume(a.id), "Couldn't resume the session.");
      if (s) apply(s);
    },

    stop: async (note) => {
      const a = get().active;
      if (!a) return null;
      const s = await run(() => api.sessions.stop(a.id, note ?? null), "Couldn't stop the session.");
      if (s) {
        apply(null);
        refreshDomains();
      }
      return s;
    },

    update: async (patch) => {
      const a = get().active;
      if (!a) return;
      const s = await run(() => api.sessions.update(a.id, patch), "Couldn't update the session.");
      if (s) {
        apply(s);
        refreshDomains();
      }
    },

    resolveGap: async (choice) => {
      const g = get().gap;
      set({ gap: null });
      if (!g) return;
      if (choice === "exclude") {
        const s = await run(() => api.sessions.discardGap(g.id), "Couldn't update the session.");
        if (s) apply(s);
      } else if (choice === "end") {
        await run(() => api.sessions.stop(g.id, null, g.lastSeenAt), "Couldn't stop the session.");
        apply(null);
        refreshDomains();
      } else {
        await api.sessions.heartbeat(g.id).catch(() => undefined);
        await get().tick();
      }
    },

    setPanel: (panelOpen) => set({ panelOpen }),
  };
});

/** Live elapsed milliseconds of the active session. */
export function liveElapsed(s: WorkSession, fetchedAt: number, now = Date.now()) {
  return s.status === "running" ? s.elapsedMs + Math.max(0, now - fetchedAt) : s.elapsedMs;
}

/** h:mm:ss for sessions (which can run for hours). */
export function formatElapsed(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
