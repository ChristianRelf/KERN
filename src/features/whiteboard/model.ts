import type { Edge, Node } from "@xyflow/react";
import type { WbEdgeRecord, WbNodeRecord } from "@/lib/types";
import { getSetting } from "@/stores/settings";

export type WbNodeType =
  | "text"
  | "sticky"
  | "task"
  | "image"
  | "shape"
  | "area"
  | "link"
  | "file"
  | "project"
  | "board"
  | "note";

export interface WbData extends Record<string, unknown> {
  title?: string;
  text?: string;
  label?: string;
  locked?: boolean;
  // sticky
  tone?: "plain" | "warm" | "cool";
  // shapes
  shape?: "rect" | "rounded" | "circle" | "line" | "arrow";
  flip?: boolean;
  stroke?: "solid" | "dashed";
  fill?: boolean;
  // area
  areaFill?: "dashed" | "solid";
  // references
  taskId?: string;
  projectId?: string;
  boardId?: string;
  noteId?: string;
  url?: string;
  description?: string;
  siteName?: string;
  path?: string;
  name?: string;
  // image (path relative to the attachments dir)
  src?: string;
  aspect?: number;
  /** Transient: start in edit mode after creation. */
  editing?: boolean;
}

export type WbNode = Node<WbData, WbNodeType>;

export interface WbEdgeData extends Record<string, unknown> {
  directed?: boolean;
  both?: boolean;
  line?: "solid" | "dashed" | "dotted";
  path?: "smooth" | "straight" | "step";
  label?: string;
}

export type WbEdge = Edge<WbEdgeData>;

const STICKY_SIZES = { s: 160, m: 200, l: 260 };

export const DEFAULT_SIZES: Record<WbNodeType, { w: number; h: number }> = {
  text: { w: 260, h: 140 },
  sticky: { w: 200, h: 200 },
  task: { w: 260, h: 92 },
  image: { w: 320, h: 220 },
  shape: { w: 160, h: 110 },
  area: { w: 520, h: 360 },
  link: { w: 280, h: 96 },
  file: { w: 260, h: 72 },
  project: { w: 260, h: 104 },
  board: { w: 260, h: 84 },
  note: { w: 280, h: 140 },
};

export const newNodeId = () => `n_${crypto.randomUUID()}`;
export const newEdgeId = () => `e_${crypto.randomUUID()}`;

export function makeNode(type: WbNodeType, position: { x: number; y: number }, data: Partial<WbData> = {}, size?: { w: number; h: number }): WbNode {
  let s = size ?? DEFAULT_SIZES[type];
  const base: WbData = {};
  if (type === "sticky") {
    const px = STICKY_SIZES[getSetting("wb.stickySize")];
    s = size ?? { w: px, h: px };
    base.tone = getSetting("wb.stickyTone");
  }
  if (type === "shape") base.shape = "rounded";
  if (type === "area") base.label = "Area";
  return {
    id: newNodeId(),
    type,
    position: { x: position.x - s.w / 2, y: position.y - s.h / 2 },
    width: s.w,
    height: s.h,
    data: { ...base, ...data },
    zIndex: type === "area" ? -1 : 0,
  };
}

export function edgeDefaults(): WbEdgeData {
  return { directed: getSetting("wb.connectorArrow"), line: "solid", path: getSetting("wb.connectorStyle") };
}

/** React Flow requires parents before children. */
export function sortParentsFirst(nodes: WbNode[]): WbNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = (n: WbNode, seen = new Set<string>()): number => {
    if (!n.parentId || seen.has(n.id)) return 0;
    seen.add(n.id);
    const p = byId.get(n.parentId);
    return p ? depth(p, seen) + 1 : 0;
  };
  return [...nodes].sort((a, b) => depth(a) - depth(b));
}

export function fromRecords(nodes: WbNodeRecord[], edges: WbEdgeRecord[]): { nodes: WbNode[]; edges: WbEdge[] } {
  const ids = new Set(nodes.map((n) => n.id));
  const rfNodes: WbNode[] = nodes.map((r) => {
    const data = { ...(r.data as WbData), locked: r.locked };
    delete data.editing;
    return {
      id: r.id,
      type: r.type as WbNodeType,
      position: { x: r.x, y: r.y },
      width: r.width ?? DEFAULT_SIZES[r.type as WbNodeType]?.w ?? 200,
      height: r.height ?? DEFAULT_SIZES[r.type as WbNodeType]?.h ?? 100,
      parentId: r.parentId && ids.has(r.parentId) ? r.parentId : undefined,
      zIndex: r.z,
      draggable: !r.locked,
      deletable: !r.locked,
      data,
    };
  });
  const rfEdges: WbEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? undefined,
    targetHandle: e.targetHandle ?? undefined,
    type: "wb",
    data: e.data as WbEdgeData,
  }));
  return { nodes: sortParentsFirst(rfNodes), edges: rfEdges };
}

export function toRecords(nodes: WbNode[], edges: WbEdge[]): { nodes: WbNodeRecord[]; edges: WbEdgeRecord[] } {
  return {
    nodes: nodes.map((n) => {
      const data = { ...n.data };
      delete data.editing;
      delete data.locked;
      return {
        id: n.id,
        type: n.type ?? "text",
        x: Math.round(n.position.x * 100) / 100,
        y: Math.round(n.position.y * 100) / 100,
        width: Math.round((n.width ?? n.measured?.width ?? 200) * 100) / 100,
        height: Math.round((n.height ?? n.measured?.height ?? 100) * 100) / 100,
        z: n.zIndex ?? 0,
        parentId: n.parentId ?? null,
        locked: !!n.data.locked,
        data,
      };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      data: e.data ?? {},
    })),
  };
}

/** Absolute position of a node (resolving parent chain). */
export function absolutePosition(n: WbNode, byId: Map<string, WbNode>): { x: number; y: number } {
  let x = n.position.x;
  let y = n.position.y;
  let p = n.parentId ? byId.get(n.parentId) : undefined;
  const seen = new Set<string>();
  while (p && !seen.has(p.id)) {
    seen.add(p.id);
    x += p.position.x;
    y += p.position.y;
    p = p.parentId ? byId.get(p.parentId) : undefined;
  }
  return { x, y };
}

export function sizeOf(n: WbNode) {
  return { w: n.width ?? n.measured?.width ?? 200, h: n.height ?? n.measured?.height ?? 100 };
}

export function isDescendant(nodeId: string, maybeAncestor: string, byId: Map<string, WbNode>): boolean {
  let p = byId.get(nodeId)?.parentId;
  const seen = new Set<string>();
  while (p && !seen.has(p)) {
    if (p === maybeAncestor) return true;
    seen.add(p);
    p = byId.get(p)?.parentId;
  }
  return false;
}
