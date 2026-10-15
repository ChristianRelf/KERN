/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// A one-shot request to centre a whiteboard on one object when it opens
// (e.g. from a search result).

let pending: { whiteboardId: string; nodeId: string } | null = null;

export function requestWhiteboardFocus(whiteboardId: string, nodeId: string) {
  pending = { whiteboardId, nodeId };
}

export function takeWhiteboardFocus(whiteboardId: string): string | null {
  if (pending?.whiteboardId !== whiteboardId) return null;
  const id = pending.nodeId;
  pending = null;
  return id;
}
