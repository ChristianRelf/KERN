// Focus (Pomodoro-style) timer. Timestamp-based: remaining time is always
// computed from `endsAt`, so it stays accurate when the window is
// minimised or throttled. The completion notification is scheduled on a
// native thread (see focus_schedule in Rust). State persists across
// restarts.

import { create } from "zustand";
import { api } from "@/lib/ipc";
import { getSetting } from "@/stores/settings";
import { invalidate } from "@/lib/query";
import { toast } from "@/stores/toast";

export type FocusKind = "focus" | "short_break" | "long_break";
export type FocusPhase = "idle" | "running" | "paused";

interface Persisted {
  phase: FocusPhase;
  kind: FocusKind;
  durationSec: number;
  endsAt: number | null;
  remainingSec: number;
  startedAt: number | null;
  taskId: string | null;
  taskTitle: string | null;
  cycle: number;
}

interface FocusState extends Persisted {
  hydrated: boolean;
  hydrate: () => Promise<void>;
  start: (opts?: { taskId?: string | null; taskTitle?: string | null; kind?: FocusKind; minutes?: number }) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  reset: () => void;
  skip: () => void;
  setTask: (taskId: string | null, taskTitle: string | null) => void;
  setKind: (kind: FocusKind) => void;
  setMinutes: (minutes: number) => void;
  checkCompletion: () => void;
}

export const KIND_LABEL: Record<FocusKind, string> = {
  focus: "Focus",
  short_break: "Short break",
  long_break: "Long break",
};

function minutesFor(kind: FocusKind) {
  if (kind === "short_break") return getSetting("focus.shortBreakMinutes");
  if (kind === "long_break") return getSetting("focus.longBreakMinutes");
  return getSetting("focus.focusMinutes");
}

let endTimer: number | undefined;

function persist(s: Persisted) {
  void api.settings.set({ "internal.focus": s }).catch(() => undefined);
}

function pick(s: FocusState): Persisted {
  const { phase, kind, durationSec, endsAt, remainingSec, startedAt, taskId, taskTitle, cycle } = s;
  return { phase, kind, durationSec, endsAt, remainingSec, startedAt, taskId, taskTitle, cycle };
}

export function remainingOf(s: Pick<Persisted, "phase" | "endsAt" | "remainingSec">, now = Date.now()) {
  if (s.phase === "running" && s.endsAt) return Math.max(0, (s.endsAt - now) / 1000);
  return s.remainingSec;
}

async function record(s: Persisted, endedAt: number, completed: boolean) {
  if (!getSetting("focus.trackHistory") || !s.startedAt) return;
  const actual = Math.round(s.durationSec - remainingOf(s, endedAt));
  if (!completed && actual < 60) return; // ignore accidental starts
  try {
    await api.focus.record({
      taskId: s.taskId,
      kind: s.kind,
      plannedSeconds: s.durationSec,
      actualSeconds: completed ? s.durationSec : actual,
      startedAt: s.startedAt,
      endedAt,
      completed,
    });
    invalidate("focus", "task", "tasks");
  } catch {
    /* history is best-effort; never block the timer */
  }
}

export const useFocus = create<FocusState>((set, get) => {
  const commit = (p: Partial<Persisted>) => {
    set(p);
    persist(pick(get()));
    scheduleEnd();
  };

  const scheduleEnd = () => {
    window.clearTimeout(endTimer);
    const s = get();
    if (s.phase === "running" && s.endsAt) {
      endTimer = window.setTimeout(() => get().checkCompletion(), Math.max(0, s.endsAt - Date.now()) + 50);
    }
  };

  const notifyNative = (s: Persisted) => {
    if (s.phase === "running" && s.endsAt) {
      const title = s.kind === "focus" ? "Focus session complete" : "Break's over";
      const body =
        s.kind === "focus" ? (s.taskTitle ? `${s.taskTitle} - time for a break.` : "Time for a break.") : "Ready to focus again?";
      void api.focus.schedule(s.endsAt, title, body).catch(() => undefined);
    } else {
      void api.focus.cancel().catch(() => undefined);
    }
  };

  return {
    phase: "idle",
    kind: "focus",
    durationSec: 25 * 60,
    endsAt: null,
    remainingSec: 25 * 60,
    startedAt: null,
    taskId: null,
    taskTitle: null,
    cycle: 0,
    hydrated: false,

    hydrate: async () => {
      try {
        const raw = (await api.settings.getAll())["internal.focus"] as Persisted | undefined;
        if (raw && typeof raw === "object" && raw.phase) {
          set({ ...raw, hydrated: true });
          scheduleEnd();
          get().checkCompletion();
          return;
        }
      } catch {
        /* fall through to defaults */
      }
      const d = minutesFor("focus") * 60;
      set({ durationSec: d, remainingSec: d, hydrated: true });
    },

    start: (opts) => {
      const s = get();
      const kind = opts?.kind ?? s.kind;
      const minutes = opts?.minutes ?? (s.phase === "idle" && kind === s.kind ? s.durationSec / 60 : minutesFor(kind));
      const dur = Math.round(minutes * 60);
      const now = Date.now();
      const next: Partial<Persisted> = {
        phase: "running",
        kind,
        durationSec: dur,
        remainingSec: dur,
        endsAt: now + dur * 1000,
        startedAt: now,
        taskId: opts?.taskId !== undefined ? opts.taskId : s.taskId,
        taskTitle: opts?.taskTitle !== undefined ? opts.taskTitle : s.taskTitle,
      };
      commit(next);
      notifyNative(pick(get()));
    },

    pause: () => {
      const s = get();
      if (s.phase !== "running") return;
      commit({ phase: "paused", remainingSec: remainingOf(s), endsAt: null });
      notifyNative(pick(get()));
    },

    resume: () => {
      const s = get();
      if (s.phase !== "paused") return;
      commit({ phase: "running", endsAt: Date.now() + s.remainingSec * 1000 });
      notifyNative(pick(get()));
    },

    stop: () => {
      const s = get();
      if (s.phase !== "idle" && s.kind === "focus") void record(pick(s), Date.now(), false);
      const d = minutesFor(s.kind) * 60;
      commit({ phase: "idle", endsAt: null, remainingSec: d, durationSec: d, startedAt: null });
      notifyNative(pick(get()));
    },

    reset: () => {
      const s = get();
      const d = minutesFor(s.kind) * 60;
      commit({ phase: "idle", endsAt: null, remainingSec: d, durationSec: d, startedAt: null });
      notifyNative(pick(get()));
    },

    skip: () => {
      const s = get();
      if (s.phase !== "idle" && s.kind === "focus") void record(pick(s), Date.now(), false);
      const nextKind: FocusKind = s.kind === "focus" ? "short_break" : "focus";
      const d = minutesFor(nextKind) * 60;
      commit({ phase: "idle", kind: nextKind, endsAt: null, remainingSec: d, durationSec: d, startedAt: null });
      notifyNative(pick(get()));
    },

    setTask: (taskId, taskTitle) => commit({ taskId, taskTitle }),

    setKind: (kind) => {
      const s = get();
      if (s.phase !== "idle") return;
      const d = minutesFor(kind) * 60;
      commit({ kind, durationSec: d, remainingSec: d });
    },

    setMinutes: (minutes) => {
      const s = get();
      if (s.phase !== "idle") return;
      const d = Math.round(Math.max(1, Math.min(240, minutes)) * 60);
      commit({ durationSec: d, remainingSec: d });
    },

    checkCompletion: () => {
      const s = get();
      if (s.phase !== "running" || !s.endsAt || Date.now() < s.endsAt) return;
      const endedAt = s.endsAt;
      void record(pick(s), endedAt, true);
      if (s.kind === "focus") {
        const cycle = s.cycle + 1;
        const every = getSetting("focus.longBreakEvery");
        const kind: FocusKind = cycle % Math.max(1, every) === 0 ? "long_break" : "short_break";
        const d = minutesFor(kind) * 60;
        commit({ phase: "idle", kind, cycle, durationSec: d, remainingSec: d, endsAt: null, startedAt: null });
        // When unfocused, the native notification has already been shown.
        if (document.hasFocus()) toast("Focus session complete");
        if (getSetting("focus.autoStartBreaks")) get().start({ kind });
      } else {
        const d = minutesFor("focus") * 60;
        commit({ phase: "idle", kind: "focus", durationSec: d, remainingSec: d, endsAt: null, startedAt: null });
        if (document.hasFocus()) toast("Break's over");
        if (getSetting("focus.autoStartFocus")) get().start({ kind: "focus" });
      }
    },
  };
});
