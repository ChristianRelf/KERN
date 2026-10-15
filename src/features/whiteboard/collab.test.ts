/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

import { describe, expect, it } from "vitest";
import type { WbNodeRecord } from "@/lib/types";
import { baselineOf, commit, diff, isEmpty, merge, stable } from "./collab";

const node = (id: string, x: number, text = id): WbNodeRecord => ({ id, type: "text", x, y: 0, width: 200, height: 100, z: 0, parentId: null, locked: false, data: { text } });
const scene = (...nodes: WbNodeRecord[]) => ({ nodes, edges: [] });

describe("whiteboard collaboration", () => {
  it("compares records regardless of key order", () => {
    expect(stable({ b: 1, a: { d: 2, c: [1, { f: 1, e: 2 }] } })).toBe(stable({ a: { c: [1, { e: 2, f: 1 }], d: 2 }, b: 1 }));
  });

  it("saves only what changed", () => {
    const base = baselineOf(scene(node("a", 0), node("b", 10)));
    const p = diff(base, scene(node("a", 5), node("c", 20)));
    expect(p.nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(p.removedNodes).toEqual(["b"]);
    commit(base, p);
    expect(isEmpty(diff(base, scene(node("a", 5), node("c", 20))))).toBe(true);
  });

  it("takes collaborators' changes and keeps unsaved local edits", () => {
    const base = baselineOf(scene(node("a", 0), node("b", 0), node("c", 0)));
    const local = scene(node("a", 99), node("b", 0), node("c", 0)); // moved a, not saved yet
    const remote = scene(node("a", 0, "edited by them"), node("b", 50), node("d", 0)); // changed a and b, deleted c, added d
    const m = merge(base, local, remote);
    expect(m.nodes.has("a")).toBe(false); // our pending move wins and is saved next
    expect(m.nodes.get("b")?.x).toBe(50);
    expect(m.nodes.get("c")).toBeNull();
    expect(m.nodes.get("d")?.id).toBe("d");
    // After merging, our edit to "a" is still a change to save.
    expect(diff(m.next, scene(node("a", 99), node("b", 50), node("d", 0))).nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("doesn't re-save positions that only moved because someone else dragged", () => {
    const base = baselineOf(scene(node("a", 0)));
    const live = scene(node("a", 42)); // position from a collaborator's live drag
    expect(isEmpty(diff(base, live, new Set(["a"])))).toBe(true);
    // Their save arrives: it's taken even though our copy differs.
    const m = merge(base, live, scene(node("a", 40)), new Set(["a"]));
    expect(m.nodes.get("a")?.x).toBe(40);
  });

  it("keeps work added locally that the server hasn't seen", () => {
    const base = baselineOf(scene(node("a", 0)));
    const m = merge(base, scene(node("a", 0), node("mine", 1)), scene(node("a", 0)));
    expect(m.nodes.size).toBe(0);
    expect(diff(m.next, scene(node("a", 0), node("mine", 1))).nodes.map((n) => n.id)).toEqual(["mine"]);
  });
});
