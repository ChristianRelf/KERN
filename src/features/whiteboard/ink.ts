/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Freehand ink geometry: stroke smoothing, hit-testing and node construction.

import { newNodeId, type WbColor, type WbNode } from "./model";

type Pt = { x: number; y: number };

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Smooth SVG path through flat [x, y, ...] points (quadratic curves via midpoints). */
export function inkPath(pts: number[], sx = 1, sy = 1): string {
  const n = pts.length >> 1;
  if (!n) return "";
  const x = (i: number) => r1(pts[i * 2] * sx);
  const y = (i: number) => r1(pts[i * 2 + 1] * sy);
  // A single tap still leaves a dot (round caps on a zero-length segment).
  if (n === 1) return `M${x(0)} ${y(0)}l0.01 0`;
  let d = `M${x(0)} ${y(0)}`;
  for (let i = 1; i < n - 1; i++) d += `Q${x(i)} ${y(i)} ${r1((x(i) + x(i + 1)) / 2)} ${r1((y(i) + y(i + 1)) / 2)}`;
  return `${d}L${x(n - 1)} ${y(n - 1)}`;
}

/** Builds a drawing node from absolute flow-space points. */
export function makeDrawing(flow: number[], strokeWidth: number, color: WbColor): WbNode {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < flow.length; i += 2) {
    minX = Math.min(minX, flow[i]);
    maxX = Math.max(maxX, flow[i]);
    minY = Math.min(minY, flow[i + 1]);
    maxY = Math.max(maxY, flow[i + 1]);
  }
  // Pad by the stroke so the selection box hugs the visible ink, not its centreline.
  const pad = strokeWidth / 2 + 2;
  const x0 = minX - pad;
  const y0 = minY - pad;
  const w = Math.max(8, maxX - minX + pad * 2);
  const h = Math.max(8, maxY - minY + pad * 2);
  const points = flow.map((v, i) => r1(v - (i % 2 ? y0 : x0)));
  return {
    id: newNodeId(),
    type: "draw",
    position: { x: x0, y: y0 },
    width: w,
    height: h,
    data: { points, vw: w, vh: h, strokeWidth, color },
    zIndex: 0,
  };
}

function distToSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether a flow-space point lies within `radius` of a drawing's ink. `origin` is its absolute position. */
export function inkHit(n: WbNode, origin: Pt, p: Pt, radius: number): boolean {
  const pts = n.data.points ?? [];
  const w = n.width ?? n.data.vw ?? 1;
  const h = n.height ?? n.data.vh ?? 1;
  if (p.x < origin.x - radius || p.y < origin.y - radius || p.x > origin.x + w + radius || p.y > origin.y + h + radius) return false;
  const sx = n.data.vw ? w / n.data.vw : 1;
  const sy = n.data.vh ? h / n.data.vh : 1;
  const r = radius + (n.data.strokeWidth ?? 3) / 2;
  const at = (i: number) => ({ x: origin.x + pts[i * 2] * sx, y: origin.y + pts[i * 2 + 1] * sy });
  const count = pts.length >> 1;
  if (count === 1) return Math.hypot(p.x - at(0).x, p.y - at(0).y) <= r;
  for (let i = 1; i < count; i++) if (distToSegment(p, at(i - 1), at(i)) <= r) return true;
  return false;
}
