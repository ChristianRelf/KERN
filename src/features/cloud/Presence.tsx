/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Live presence: collaborators' cursors and selections on a whiteboard, and
// avatar stacks showing who is looking at the same thing.

import { useMemo } from "react";
import { useSetting } from "@/stores/settings";
import { Tooltip } from "@/components/ui/Tooltip";
import { useCloud, type Peer } from "./store";
import { Avatar } from "./ui";

/** Collaborators currently viewing `view` (one entry per person). */
export function usePeersOn(view: string) {
  const peers = useCloud((s) => s.peers);
  const self = useCloud((s) => s.info?.account?.id);
  return useMemo(() => {
    const byUser = new Map<string, Peer>();
    for (const p of Object.values(peers)) if (p.state?.view === view && p.userId !== self) byUser.set(p.userId, p);
    return [...byUser.values()];
  }, [peers, view, self]);
}

/** All connections (several per person, e.g. two devices) viewing `view`. */
function useConnsOn(view: string) {
  const peers = useCloud((s) => s.peers);
  const self = useCloud((s) => s.self?.conn);
  return useMemo(() => Object.values(peers).filter((p) => p.state?.view === view && p.conn !== self), [peers, view, self]);
}

export function PeerStack({ view, max = 5, size = 22 }: { view: string; max?: number; size?: number }) {
  const peers = usePeersOn(view);
  if (!peers.length) return null;
  const extra = peers.length - max;
  return (
    <div className="peer-stack" aria-label={`${peers.length} collaborator${peers.length === 1 ? "" : "s"} here`}>
      {peers.slice(0, max).map((p) => (
        <Tooltip key={p.userId} content={`${p.name} is here`}>
          <span>
            <Avatar name={p.name} image={p.image} color={p.color} size={size} ring={p.color} />
          </span>
        </Tooltip>
      ))}
      {extra > 0 && <span className="peer-stack__more">+{extra}</span>}
    </div>
  );
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Cursors and selection outlines on a whiteboard. `transform` is React
 * Flow's [x, y, zoom]; `boxOf` gives a node's absolute box in flow space.
 */
export function WhiteboardPresence({ view, transform, boxOf }: { view: string; transform: [number, number, number]; boxOf: (id: string) => Box | null }) {
  const show = useSetting("cloud.showCursors");
  const conns = useConnsOn(view);
  if (!show || !conns.length) return null;
  const [tx, ty, z] = transform;
  return (
    <div className="wb-presence" aria-hidden>
      <svg className="wb-presence__boxes">
        {conns.flatMap((p) =>
          (p.state?.selection ?? []).slice(0, 50).map((id) => {
            const b = boxOf(id);
            if (!b) return null;
            return <rect key={`${p.conn}:${id}`} x={b.x * z + tx - 3} y={b.y * z + ty - 3} width={b.w * z + 6} height={b.h * z + 6} rx={6} fill="none" stroke={p.color} strokeWidth={1.5} />;
          }),
        )}
      </svg>
      {conns.map((p) => {
        const c = p.state?.cursor;
        if (!c) return null;
        return (
          <div key={p.conn} className="wb-cursor" style={{ transform: `translate(${c.x * z + tx}px, ${c.y * z + ty}px)`, color: p.color }}>
            <svg width="16" height="18" viewBox="0 0 16 18">
              <path d="M1 1 L1 15 L5 11.2 L8.2 17 L10.6 15.8 L7.5 10.2 L13 10.2 Z" fill="currentColor" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
            <span className="wb-cursor__name" style={{ background: p.color }}>
              {p.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}
