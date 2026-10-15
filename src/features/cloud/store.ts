/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Kern Cloud state: the account, spaces, the open space, sync status,
// presence, and which cloud dialog is showing.

import { create } from "zustand";
import { api, describeError, KernError } from "@/lib/ipc";
import type { ActiveSpace, CloudInfo, Me, Space, SyncStatus } from "@/lib/types";
import { spaceLook } from "./ui";

export type AuthMode = "sign-in" | "sign-up" | "verify" | "code" | "forgot" | "reset";

export interface AuthRequest {
  /** Why sign-in is needed, shown at the top of the dialog. */
  reason?: string;
  mode?: AuthMode;
  email?: string;
  /** Runs after a successful sign-in. */
  then?: () => void | Promise<void>;
}

export interface Peer {
  conn: string;
  userId: string;
  name: string;
  image: string | null;
  color: string;
  state: PresenceState | null;
}

/** What a collaborator is looking at (ephemeral, never stored). */
export interface PresenceState {
  /** "wb:<id>", "project:<id>", "task:<id>", … */
  view?: string;
  label?: string;
  /** Whiteboard cursor in flow coordinates. */
  cursor?: { x: number; y: number } | null;
  selection?: string[];
}

export type ManageTab = "general" | "members" | "invites" | "github" | "activity" | "danger";

interface CloudState {
  info: CloudInfo | null;
  me: Me | null;
  meLoading: boolean;
  auth: AuthRequest | null;
  createOpen: boolean;
  manage: { id: string; tab: ManageTab } | null;
  inviteId: string | null;
  importOpen: boolean;
  /** Realtime connection. */
  connected: boolean;
  self: { conn: string; userId: string; color: string } | null;
  peers: Record<string, Peer>;
  set: (patch: Partial<CloudState>) => void;
}

export const useCloud = create<CloudState>((set) => ({
  info: null,
  me: null,
  meLoading: false,
  auth: null,
  createOpen: false,
  manage: null,
  inviteId: null,
  importOpen: false,
  connected: false,
  self: null,
  peers: {},
  set: (patch) => set(patch),
}));

const st = () => useCloud.getState();

export async function refreshStatus(): Promise<CloudInfo | null> {
  try {
    const info = await api.cloud.status();
    useCloud.setState({ info });
    return info;
  } catch {
    return null;
  }
}

/** Reloads the account overview (spaces, invitations). */
export async function refreshMe(): Promise<Me | null> {
  const info = st().info ?? (await refreshStatus());
  if (!info?.signedIn) {
    useCloud.setState({ me: null });
    return null;
  }
  useCloud.setState({ meLoading: true });
  try {
    const me = await api.cloud.request<Me>("GET", "/me");
    useCloud.setState({ me });
    return me;
  } catch (e) {
    if (e instanceof KernError && e.code === "auth") await refreshStatus();
    return null;
  } finally {
    useCloud.setState({ meLoading: false });
  }
}

export function setSync(sync: SyncStatus) {
  const info = st().info;
  if (info) useCloud.setState({ info: { ...info, sync } });
}

export function openAuth(req: AuthRequest = {}) {
  useCloud.setState({ auth: req });
}

/** The space currently open, with its role when known. */
export function activeSpace(): (ActiveSpace & { role?: Space["role"]; logo?: string | null }) | null {
  const { info, me } = st();
  const a = info?.active;
  if (!a) return null;
  const full = a.kind === "personal" ? me?.personal : me?.workspaces.find((w) => w.id === a.id);
  return { ...a, role: full?.role, logo: full?.logo ?? null, name: full?.name ?? a.name };
}

export function useActiveSpace() {
  const info = useCloud((s) => s.info);
  const me = useCloud((s) => s.me);
  const a = info?.active;
  if (!a) return null;
  const full = a.kind === "personal" ? me?.personal : me?.workspaces.find((w) => w.id === a.id);
  const look = a.kind === "workspace" ? spaceLook(full?.settings) : { icon: null, tint: false };
  return { ...a, role: full?.role, logo: full?.logo ?? null, name: full?.name ?? a.name, accent: full?.accent ?? null, ...look };
}

/** True when the open space only allows viewing. */
export function useReadOnly() {
  return useActiveSpace()?.role === "viewer";
}

export function errorText(e: unknown, fallback: string) {
  return describeError(e, fallback);
}
