/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// The realtime socket to Kern Cloud. One connection per app, subscribed to
// the open space. It carries:
//   - "changes": records other people saved (handed to the backend to apply),
//   - "presence": who's here and where (cursors, selections),
//   - "ephemeral": live interactions such as whiteboard drags,
//   - "space" / "invite": workspace events for this account,
//   - "stream": a stream delivered a submission into the open space.
// The socket authenticates with a single-use ticket fetched by the backend;
// the session token never reaches the interface.

import { api } from "@/lib/ipc";
import type { RemoteChange } from "@/lib/types";
import { refreshMe, refreshStatus, useCloud, type Peer, type PresenceState } from "./store";
import { handleSpaceEvent, handleInviteEvent, handleStreamEvent, type StreamEventMessage } from "./actions";

type Ephemeral = { userId: string; conn: string; color: string; name: string; data: unknown };
type Listener = (e: Ephemeral) => void;

const listeners = new Set<Listener>();

/** Subscribes to ephemeral messages (whiteboard drags). */
export function onEphemeral(fn: Listener) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

let ws: WebSocket | null = null;
let subscribed: string | null = null;
let wanted = false;
let attempt = 0;
let reconnectTimer: number | undefined;
let pingTimer: number | undefined;
let lastPresence: PresenceState | null = null;
let presenceTimer: number | undefined;
let presenceQueued: PresenceState | null = null;
let lastPresenceSent = 0;
let lastEphemeralSent = 0;

function send(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function activeId() {
  return useCloud.getState().info?.active?.id ?? null;
}

function syncSubscription() {
  const target = activeId();
  if (subscribed === target) return;
  if (subscribed) send({ type: "unsubscribe", space: subscribed });
  useCloud.setState({ peers: {} });
  subscribed = target;
  if (target) {
    send({ type: "subscribe", space: target });
    if (lastPresence) send({ type: "presence", space: target, state: lastPresence });
  }
}

function onMessage(raw: string) {
  let msg: { type: string; space?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const space = msg.space as string | undefined;
  switch (msg.type) {
    case "hello": {
      const self = msg.self as { conn: string; userId: string; color: string };
      useCloud.setState({ connected: true, self });
      attempt = 0;
      void api.cloud.setConnection(self.conn).catch(() => undefined);
      subscribed = null;
      syncSubscription();
      return;
    }
    case "subscribed": {
      if (space !== subscribed) return;
      const peers: Record<string, Peer> = {};
      for (const p of (msg.peers as Peer[]) ?? []) peers[p.conn] = p;
      useCloud.setState({ peers });
      return;
    }
    case "changes": {
      if (!space || space !== activeId()) return;
      void api.cloud.apply(space, msg.from as number, msg.to as number, msg.changes as RemoteChange[]).catch(() => undefined);
      return;
    }
    case "presence": {
      if (space !== subscribed) return;
      const p = msg as unknown as Peer;
      useCloud.setState((s) => ({ peers: { ...s.peers, [p.conn]: { conn: p.conn, userId: p.userId, name: p.name, image: p.image, color: p.color, state: p.state } } }));
      return;
    }
    case "leave": {
      if (space !== subscribed) return;
      useCloud.setState((s) => {
        const peers = { ...s.peers };
        delete peers[msg.conn as string];
        return { peers };
      });
      return;
    }
    case "ephemeral": {
      if (space !== subscribed) return;
      const e = msg as unknown as Ephemeral;
      listeners.forEach((fn) => fn(e));
      return;
    }
    case "space":
      handleSpaceEvent(msg.event as string, space ?? "");
      return;
    case "invite":
      handleInviteEvent(msg.invite as { id: string; workspace: string; inviterName: string | null });
      return;
    case "stream":
      handleStreamEvent(msg as unknown as StreamEventMessage);
      return;
  }
}

async function connect() {
  window.clearTimeout(reconnectTimer);
  if (!wanted || ws) return;
  const info = useCloud.getState().info;
  if (!info?.signedIn || !info.wsUrl) return;
  let ticket: string;
  try {
    ticket = (await api.cloud.request<{ ticket: string }>("POST", "/realtime/ticket")).ticket;
  } catch {
    schedule();
    return;
  }
  if (!wanted || ws) return;
  const sock = new WebSocket(`${info.wsUrl}?ticket=${encodeURIComponent(ticket)}`);
  ws = sock;
  sock.onmessage = (e) => onMessage(String(e.data));
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    subscribed = null;
    window.clearInterval(pingTimer);
    useCloud.setState({ connected: false, peers: {}, self: null });
    void api.cloud.setConnection(null).catch(() => undefined);
    schedule();
  };
  sock.onerror = () => sock.close();
  window.clearInterval(pingTimer);
  pingTimer = window.setInterval(() => send({ type: "ping" }), 25_000);
}

function schedule() {
  if (!wanted) return;
  const delays = [1000, 2000, 5000, 10_000, 20_000, 30_000];
  const delay = delays[Math.min(attempt, delays.length - 1)] * (0.75 + Math.random() * 0.5);
  attempt++;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => void connect(), delay);
}

function disconnect() {
  window.clearTimeout(reconnectTimer);
  window.clearInterval(pingTimer);
  const sock = ws;
  ws = null;
  subscribed = null;
  sock?.close();
  useCloud.setState({ connected: false, peers: {}, self: null });
  void api.cloud.setConnection(null).catch(() => undefined);
}

/**
 * Keeps the socket in step with the account and open space: connected while
 * signed in with a cloud space open, subscribed to that space.
 */
export function startRealtime(): () => void {
  const evaluate = () => {
    const { info } = useCloud.getState();
    const should = !!info?.signedIn && !!info.active;
    if (should && !wanted) {
      wanted = true;
      attempt = 0;
      void connect();
    } else if (!should && wanted) {
      wanted = false;
      disconnect();
    } else if (should) {
      syncSubscription();
    }
  };
  evaluate();
  const unsub = useCloud.subscribe((s, prev) => {
    if (s.info?.signedIn !== prev.info?.signedIn || s.info?.active?.id !== prev.info?.active?.id) evaluate();
  });
  // Come back quickly after sleep or a network change.
  const online = () => {
    if (wanted && !ws) {
      attempt = 0;
      void connect();
    }
    void refreshStatus().then(() => refreshMe());
  };
  window.addEventListener("online", online);
  return () => {
    unsub();
    window.removeEventListener("online", online);
    wanted = false;
    disconnect();
  };
}

/** Shares what this user is looking at (throttled; replayed on reconnect). */
export function setPresence(state: PresenceState | null) {
  lastPresence = state;
  presenceQueued = state;
  const flush = () => {
    presenceTimer = undefined;
    lastPresenceSent = performance.now();
    if (subscribed) send({ type: "presence", space: subscribed, state: presenceQueued });
  };
  const wait = 50 - (performance.now() - lastPresenceSent);
  if (wait <= 0) flush();
  else if (presenceTimer === undefined) presenceTimer = window.setTimeout(flush, wait);
}

/** Sends a live interaction to everyone in the space (at most ~25 a second). */
export function sendEphemeral(data: unknown, force = false) {
  const now = performance.now();
  if (!force && now - lastEphemeralSent < 40) return false;
  lastEphemeralSent = now;
  if (subscribed) send({ type: "ephemeral", space: subscribed, data });
  return true;
}
