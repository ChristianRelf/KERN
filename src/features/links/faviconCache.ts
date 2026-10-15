/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Session cache of favicon image URLs per site, shared by the note editor's
// link icons. Kept free of editor imports so other screens (e.g. storage
// cleanup) can reset it without loading the editor bundle.

import { convertFileSrc } from "@tauri-apps/api/core";
import { api, isTauri } from "@/lib/ipc";
import { originOf } from "./links";

const sources = new Map<string, Promise<string | null>>();

export function faviconSrc(url: string): Promise<string | null> {
  const origin = originOf(url);
  if (!origin || !isTauri) return Promise.resolve(null);
  let p = sources.get(origin);
  if (!p) {
    p = api.system
      .favicon(url)
      .then((f) => (f.path ? convertFileSrc(f.path) : null))
      .catch(() => null);
    sources.set(origin, p);
  }
  return p;
}

/** Forget cached lookups (after the favicon cache is cleared). */
export function resetNoteFavicons() {
  sources.clear();
}
