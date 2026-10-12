import { describe, expect, it } from "vitest";
import { layoutGraph, parseRefs } from "./graph";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe("layoutGraph", () => {
  it("keeps a linear history in one lane", () => {
    const g = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(g.width).toBe(1);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(g.rows[2].bottom).toEqual([]);
  });

  it("opens a lane for a merged branch and closes it where it forks", () => {
    // m merges f into main; f and b both come from a.
    const g = layoutGraph([c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]);
    expect(g.width).toBe(2);
    expect(g.rows[0].bottom).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 0, to: 1, color: 1 },
    ]);
    expect(g.rows[1].lane).toBe(1);
    expect(g.rows[2].lane).toBe(0);
    // Both lanes wait for a, so lane 1 converges into lane 0.
    expect(g.rows[3].lane).toBe(0);
    expect(g.rows[3].top).toContainEqual({ from: 1, to: 0, color: 1 });
  });

  it("gives an unrelated branch tip its own lane", () => {
    const g = layoutGraph([c("x", "a"), c("y", "a"), c("a")]);
    expect(g.rows[1].lane).toBe(1);
    expect(g.rows[2].top).toHaveLength(2);
  });
});

describe("parseRefs", () => {
  it("labels heads, branches, remotes and tags", () => {
    expect(parseRefs(["HEAD -> refs/heads/main", "refs/remotes/origin/main", "refs/remotes/origin/HEAD", "refs/heads/feature/x", "tag: refs/tags/v1"])).toEqual([
      { name: "main", kind: "head" },
      { name: "origin/main", kind: "remote" },
      { name: "feature/x", kind: "branch" },
      { name: "v1", kind: "tag" },
    ]);
  });
});
