import { useEffect, useState, useSyncExternalStore } from "react";
import { todayStr } from "@/lib/dates";

// One shared timer flips "today" at local midnight (and re-checks when the
// window regains visibility, e.g. after sleep or a timezone change).
let current = todayStr();
const listeners = new Set<() => void>();
let timer: number | undefined;

function check() {
  const t = todayStr();
  if (t !== current) {
    current = t;
    listeners.forEach((l) => l());
  }
  schedule();
}

function schedule() {
  window.clearTimeout(timer);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2);
  timer = window.setTimeout(check, Math.min(next.getTime() - now.getTime(), 60 * 60 * 1000));
}

if (typeof window !== "undefined") {
  schedule();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) check();
  });
  window.addEventListener("focus", check);
}

export function useToday(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

/** Re-renders every `ms` while mounted (only for live displays like timers). */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
  return now;
}
