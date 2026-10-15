/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Lane layout for the commit graph. Commits arrive newest first in
// topological order; each row gets the lane its node sits in plus the line
// segments to draw above (into the node) and below (out to its parents).
// Lanes are reused once free, so the graph stays as narrow as the history.

export interface GraphCommit {
  hash: string;
  parents: string[];
}

/** A line segment within one row, in lane units: top → middle or middle → bottom. */
export interface Edge {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  /** Lines entering the row from above, ending at the row's middle. */
  top: Edge[];
  /** Lines leaving the row's middle, ending at the bottom. */
  bottom: Edge[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest point, in lanes. */
  width: number;
}

export function layoutGraph(commits: GraphCommit[]): GraphLayout {
  // lanes[i] = hash the lane is waiting for, or null when free.
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  let width = 0;

  const claim = (hash: string): number => {
    let i = lanes.indexOf(null);
    if (i === -1) i = lanes.push(null) - 1;
    lanes[i] = hash;
    colors[i] = nextColor++;
    return i;
  };

  const rows = commits.map((c) => {
    const before = lanes.slice();
    const beforeColors = colors.slice();
    // Every lane waiting for this commit converges on its node.
    const waiting = before.flatMap((h, i) => (h === c.hash ? [i] : []));
    const lane = waiting.length ? waiting[0] : claim(c.hash);
    const color = colors[lane];
    for (const i of waiting.slice(1)) lanes[i] = null;

    const top: Edge[] = [];
    before.forEach((h, i) => {
      if (h === null) return;
      top.push({ from: i, to: h === c.hash ? lane : i, color: beforeColors[i] });
    });

    // First parent continues in this lane; others join an existing lane or open a new one.
    const bottom: Edge[] = [];
    const [first, ...rest] = c.parents;
    lanes[lane] = first ?? null;
    if (first) bottom.push({ from: lane, to: lane, color });
    for (const p of rest) {
      const existing = lanes.indexOf(p);
      const to = existing !== -1 ? existing : claim(p);
      bottom.push({ from: lane, to, color: colors[to] });
    }
    lanes.forEach((h, i) => {
      if (h !== null && i !== lane && !bottom.some((e) => e.to === i)) bottom.push({ from: i, to: i, color: colors[i] });
    });

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, before.length, lanes.length, lane + 1);
    return { lane, color, top, bottom };
  });

  return { rows, width };
}

export interface RefLabel {
  name: string;
  kind: "head" | "branch" | "remote" | "tag";
}

/** Turns git's full decorations into labels; "HEAD -> refs/heads/main" is the current branch. */
export function parseRefs(refs: string[]): RefLabel[] {
  const out: RefLabel[] = [];
  for (const r of refs) {
    if (r.startsWith("HEAD -> ")) out.push({ name: r.slice(8).replace(/^refs\/heads\//, ""), kind: "head" });
    else if (r === "HEAD") out.push({ name: "HEAD", kind: "head" });
    else if (r.startsWith("tag: ")) out.push({ name: r.slice(5).replace(/^refs\/tags\//, ""), kind: "tag" });
    else if (r.startsWith("refs/remotes/")) {
      if (!r.endsWith("/HEAD")) out.push({ name: r.slice(13), kind: "remote" });
    } else if (r.startsWith("refs/heads/")) out.push({ name: r.slice(11), kind: "branch" });
  }
  return out;
}
