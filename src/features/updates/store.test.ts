import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.fn();
const relaunch = vi.fn();
const settingsSet = vi.fn();
const open = vi.fn();
const toast = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: (...a: unknown[]) => check(...a) }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));
vi.mock("@/lib/ipc", () => ({
  api: { settings: { set: (e: unknown) => settingsSet(e) }, system: { open: (u: string) => open(u) } },
  describeError: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}));
vi.mock("@/stores/toast", () => ({ toast: (m: string) => toast(m) }));

const { startUpdate, useUpdater, leaveUpdate, MAX_ATTEMPTS, PENDING_KEY } = await import("./store");

function fakeUpdate(opts: { download?: () => Promise<void>; install?: () => Promise<void> } = {}) {
  return {
    version: "0.2.0",
    currentVersion: "0.1.9",
    body: "## What's new\n- Things",
    download: vi.fn(async (onEvent: (e: unknown) => void) => {
      if (opts.download) return opts.download();
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 60 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      onEvent({ event: "Finished" });
    }),
    install: vi.fn(opts.install ?? (async () => undefined)),
    close: vi.fn(async () => undefined),
  };
}

/** Runs startUpdate to completion, skipping its retry pauses. */
async function run(opts?: Parameters<typeof startUpdate>[0]) {
  const p = startUpdate(opts);
  await vi.runAllTimersAsync();
  await p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", { activeElement: null });
  for (const f of [check, relaunch, settingsSet, open, toast]) f.mockReset();
  settingsSet.mockResolvedValue(undefined);
  open.mockResolvedValue(undefined);
  leaveUpdate();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("startUpdate", () => {
  it("downloads, records what's new, installs and relaunches", async () => {
    const u = fakeUpdate();
    check.mockResolvedValue(u);
    await run();
    expect(u.download).toHaveBeenCalledTimes(1);
    expect(settingsSet).toHaveBeenCalledWith({ [PENDING_KEY]: { from: "0.1.9", to: "0.2.0", notes: "## What's new\n- Things" } });
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    const s = useUpdater.getState();
    expect([s.phase, s.downloaded, s.total]).toEqual(["restarting", 100, 100]);
  });

  it("retries a failed download, then succeeds", async () => {
    let calls = 0;
    check.mockImplementation(async () =>
      fakeUpdate({
        download: async () => {
          if (++calls < 3) throw new Error("connection reset");
        },
      }),
    );
    await run();
    expect(check).toHaveBeenCalledTimes(3);
    expect(useUpdater.getState().phase).toBe("restarting");
  });

  it(`gives up after ${MAX_ATTEMPTS} failed downloads, installing nothing`, async () => {
    const updates: ReturnType<typeof fakeUpdate>[] = [];
    check.mockImplementation(async () => {
      const u = fakeUpdate({ download: async () => Promise.reject(new Error("timed out")) });
      updates.push(u);
      return u;
    });
    await run();
    expect(updates).toHaveLength(MAX_ATTEMPTS);
    for (const u of updates) {
      expect(u.install).not.toHaveBeenCalled();
      expect(u.close).toHaveBeenCalled();
    }
    expect(settingsSet).not.toHaveBeenCalled();
    const s = useUpdater.getState();
    expect([s.phase, s.failedStep, s.attempt, s.error]).toEqual(["failed", "download", MAX_ATTEMPTS, "timed out"]);
    // "Back to Kern" returns to the running version.
    leaveUpdate();
    expect(useUpdater.getState().phase).toBeNull();
  });

  it("counts failed checks as failed attempts", async () => {
    check.mockRejectedValue(new Error("offline"));
    await run();
    expect(check).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(useUpdater.getState().failedStep).toBe("download");
  });

  it("forgets the pending update when installing fails", async () => {
    check.mockResolvedValue(fakeUpdate({ install: async () => Promise.reject(new Error("installer refused")) }));
    await run();
    expect(settingsSet).toHaveBeenLastCalledWith({ [PENDING_KEY]: null });
    expect(relaunch).not.toHaveBeenCalled();
    const s = useUpdater.getState();
    expect([s.phase, s.failedStep]).toEqual(["failed", "install"]);
  });

  it("opens the release page when there's nothing to install in the app", async () => {
    check.mockResolvedValue(null);
    await run({ fallbackUrl: "https://example.com/release" });
    expect(useUpdater.getState().phase).toBeNull();
    expect(open).toHaveBeenCalledWith("https://example.com/release");
    expect(toast).toHaveBeenCalled();
  });

  it("ignores a second start while one is running", async () => {
    check.mockResolvedValue(fakeUpdate());
    const a = startUpdate();
    const b = startUpdate();
    await vi.runAllTimersAsync();
    await Promise.all([a, b]);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
