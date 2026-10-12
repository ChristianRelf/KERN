// Branch naming for tasks: a safe, readable slug with a conventional
// prefix ("feature/reactor-cooling-controls", or "fix/124-reactor-cooling"
// when an issue is linked). Names are checked with git before use and a
// taken name gets a numeric suffix; an existing branch is never reused
// silently.

import { useEffect, useState } from "react";
import { api } from "@/lib/ipc";
import type { BranchCheck } from "@/lib/types";

const STOP = new Set(["a", "an", "the", "to", "for", "of", "and", "in", "on", "with"]);
const FIX_WORDS = /\b(fix|bug|crash|broken|error|regression|issue)\b/i;

/** "Fix the reactor cooling controls!" → "reactor-cooling-controls". */
export function slugify(text: string, maxWords = 6, maxLen = 48): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((w, i) => !(STOP.has(w) && i > 0) && !(i === 0 && /^(fix|add|implement|make)$/.test(w) && words.length > 1));
  let out = "";
  for (const w of (meaningful.length ? meaningful : words).slice(0, maxWords)) {
    if ((out + "-" + w).length > maxLen) break;
    out = out ? `${out}-${w}` : w;
  }
  return out || "work";
}

/** Suggested branch for a task; `fix/` when the task (or its issue) looks like a fix. */
export function suggestBranchName(title: string, issueNumber?: number | null, labels: string[] = []): string {
  const fix = FIX_WORDS.test(title) || labels.some((l) => FIX_WORDS.test(l));
  const prefix = fix ? "fix" : "feature";
  const slug = slugify(title, issueNumber ? 3 : 5);
  return issueNumber ? `${prefix}/${issueNumber}-${slug}` : `${prefix}/${slug}`;
}

/** Adds -2, -3… until the name isn't in `taken`. */
export function uniqueBranch(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; i < 100; i++) {
    const n = `${name}-${i}`;
    if (!taken.has(n)) return n;
  }
  return `${name}-${Date.now().toString(36)}`;
}

/** Debounced git validation of a branch name. */
export function useBranchCheck(repoId: string | null | undefined, name: string): BranchCheck | null {
  const [res, setRes] = useState<BranchCheck | null>(null);
  useEffect(() => {
    const n = name.trim();
    if (!repoId || !n) {
      setRes(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void api.git
        .checkBranch(repoId, n)
        .then((r) => !cancelled && setRes(r))
        .catch(() => !cancelled && setRes(null));
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [repoId, name]);
  return res;
}
