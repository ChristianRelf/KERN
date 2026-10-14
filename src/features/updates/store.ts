// In-app updates. Starting one swaps the whole window for a minimal update
// screen, downloads the signed installer listed in the release's
// latest.json (up to three attempts), then installs it: on Windows the
// installer runs passively and reopens Kern; elsewhere Kern relaunches.
// If every download attempt fails, or installing fails, the screen gives
// way to Kern again, still on the version that was running.

import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, describeError } from "@/lib/ipc";
import { toast } from "@/stores/toast";

export const MAX_ATTEMPTS = 3;
/** Pause before each retry, by the attempt that failed (1-based). */
const RETRY_DELAY_MS = [0, 1500, 4000];
/** How long the failure message shows before Kern comes back by itself. */
export const FAILED_RETURN_MS = 6000;

export type UpdatePhase = "preparing" | "downloading" | "retrying" | "installing" | "restarting" | "failed";

interface UpdateState {
  phase: UpdatePhase | null;
  current: string | null;
  target: string | null;
  /** 1-based download attempt in progress (or that just failed). */
  attempt: number;
  downloaded: number;
  total: number | null;
  error: string | null;
  /** Which step failed, when phase is "failed". */
  failedStep: "download" | "install" | null;
}

const IDLE: UpdateState = { phase: null, current: null, target: null, attempt: 0, downloaded: 0, total: null, error: null, failedStep: null };

export const useUpdater = create<UpdateState>(() => IDLE);

/** Settings key: the update being installed, so the next start can say what's new. */
export const PENDING_KEY = "internal.pendingUpdate";
export interface PendingUpdate {
  from: string;
  to: string;
  /** Notes from latest.json, used when GitHub can't be reached afterwards. */
  notes: string | null;
}

const set = (p: Partial<UpdateState>) => useUpdater.setState(p);
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Returns to Kern on the running version. */
export function leaveUpdate() {
  useUpdater.setState(IDLE);
}

/**
 * Checks for the update and downloads it, retrying up to MAX_ATTEMPTS
 * times. Resolves with a downloaded update, or null when the release has no
 * in-app package for this platform.
 */
async function fetchUpdate(): Promise<Update | null> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    set({ attempt, downloaded: 0, total: null, phase: attempt === 1 ? "preparing" : "retrying" });
    if (attempt > 1) await sleep(RETRY_DELAY_MS[attempt - 1]);
    let update: Update | null = null;
    try {
      update = await check({ timeout: 30_000 });
      if (!update) return null;
      set({ target: update.version, current: update.currentVersion, phase: "downloading" });
      await update.download(
        (e) => {
          if (e.event === "Started") set({ total: e.data.contentLength ?? null, downloaded: 0 });
          else if (e.event === "Progress") set({ downloaded: useUpdater.getState().downloaded + e.data.chunkLength });
        },
        { timeout: 5 * 60_000 },
      );
      return update;
    } catch (e) {
      lastError = e;
      void update?.close().catch(() => undefined);
    }
  }
  throw lastError;
}

/**
 * Runs the whole update. `fallbackUrl` is the release page, opened when the
 * release can't be installed from inside Kern (no latest.json for this
 * platform, e.g. an older or Linux-only release).
 */
export async function startUpdate(opts: { current?: string; target?: string; fallbackUrl?: string } = {}) {
  if (useUpdater.getState().phase && useUpdater.getState().phase !== "failed") return;
  // Unsaved edits are saved on blur; blur before the app is swapped out.
  (document.activeElement as HTMLElement | null)?.blur?.();
  useUpdater.setState({ ...IDLE, phase: "preparing", current: opts.current ?? null, target: opts.target ?? null, attempt: 1 });
  await sleep(150);

  let update: Update | null;
  try {
    update = await fetchUpdate();
  } catch (e) {
    set({ phase: "failed", failedStep: "download", error: describeError(e, "Couldn't download the update.") });
    return;
  }
  if (!update) {
    leaveUpdate();
    toast("This update can't be installed from inside Kern. Opening the release page.");
    if (opts.fallbackUrl) void api.system.open(opts.fallbackUrl).catch(() => undefined);
    return;
  }

  const pending: PendingUpdate = { from: update.currentVersion, to: update.version, notes: update.body ?? null };
  try {
    await api.settings.set({ [PENDING_KEY]: pending });
    set({ phase: "installing" });
    // On Windows the installer closes Kern here and opens the new version.
    await update.install();
    set({ phase: "restarting" });
    await relaunch();
  } catch (e) {
    await api.settings.set({ [PENDING_KEY]: null }).catch(() => undefined);
    set({ phase: "failed", failedStep: "install", error: describeError(e, "Couldn't install the update.") });
  }
}
