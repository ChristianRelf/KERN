// Collaborative editing support for the whiteboard.
//
// The editor keeps a baseline: each object and connection as last saved (or
// last received). Saving sends only what differs from the baseline, so two
// people editing the same whiteboard never overwrite each other's objects.
// When someone else's changes arrive, a three-way merge takes their version
// of everything this editor hasn't changed since the baseline, and keeps
// local edits that are still waiting to be saved.

import type { ScenePatch, WbEdgeRecord, WbNodeRecord } from "@/lib/types";

/** JSON with sorted keys, so equal records always compare equal. */
export function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

export interface Baseline {
  nodes: Map<string, string>;
  edges: Map<string, string>;
}

export interface Records {
  nodes: WbNodeRecord[];
  edges: WbEdgeRecord[];
}

export function baselineOf(r: Records): Baseline {
  return { nodes: new Map(r.nodes.map((n) => [n.id, stable(n)])), edges: new Map(r.edges.map((e) => [e.id, stable(e)])) };
}

/** What changed relative to the baseline. Ids in `skip` (moved live by someone else) are left out. */
export function diff(base: Baseline, cur: Records, skip: ReadonlySet<string> = new Set()): ScenePatch {
  const seenN = new Set<string>();
  const seenE = new Set<string>();
  const patch: ScenePatch = { nodes: [], removedNodes: [], edges: [], removedEdges: [] };
  for (const n of cur.nodes) {
    seenN.add(n.id);
    if (!skip.has(n.id) && base.nodes.get(n.id) !== stable(n)) patch.nodes.push(n);
  }
  for (const id of base.nodes.keys()) if (!seenN.has(id)) patch.removedNodes.push(id);
  for (const e of cur.edges) {
    seenE.add(e.id);
    if (base.edges.get(e.id) !== stable(e)) patch.edges.push(e);
  }
  for (const id of base.edges.keys()) if (!seenE.has(id)) patch.removedEdges.push(id);
  return patch;
}

export const isEmpty = (p: ScenePatch) => !p.nodes.length && !p.removedNodes.length && !p.edges.length && !p.removedEdges.length;

/** Records a saved patch in the baseline. */
export function commit(base: Baseline, p: ScenePatch) {
  p.nodes.forEach((n) => base.nodes.set(n.id, stable(n)));
  p.removedNodes.forEach((id) => base.nodes.delete(id));
  p.edges.forEach((e) => base.edges.set(e.id, stable(e)));
  p.removedEdges.forEach((id) => base.edges.delete(id));
}

export interface Merge {
  /** Remote versions to take: a record, or null to remove. */
  nodes: Map<string, WbNodeRecord | null>;
  edges: Map<string, WbEdgeRecord | null>;
  /** The new baseline (the remote scene). */
  next: Baseline;
}

function mergeKind<R extends { id: string }>(base: Map<string, string>, local: R[], remote: R[], skip: ReadonlySet<string>): Map<string, R | null> {
  const takes = new Map<string, R | null>();
  const l = new Map(local.map((r) => [r.id, stable(r)]));
  const r = new Map(remote.map((x) => [x.id, x]));
  const ids = new Set([...base.keys(), ...r.keys()]);
  for (const id of ids) {
    const rec = r.get(id);
    const rs = rec ? stable(rec) : undefined;
    const bs = base.get(id);
    if (rs === bs) continue; // nobody else changed it
    const localChanged = l.get(id) !== bs && !skip.has(id);
    if (localChanged && l.get(id) !== rs) continue; // our unsaved edit wins; it's saved next
    if (l.get(id) === rs) continue; // already identical
    takes.set(id, rec ?? null);
  }
  return takes;
}

export function merge(base: Baseline, local: Records, remote: Records, skip: ReadonlySet<string> = new Set()): Merge {
  return {
    nodes: mergeKind(base.nodes, local.nodes, remote.nodes, skip),
    edges: mergeKind(base.edges, local.edges, remote.edges, new Set()),
    next: baselineOf(remote),
  };
}
