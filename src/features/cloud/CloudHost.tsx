// Mounts Kern Cloud's dialogs and keeps the interface in step with the
// backend: account and sync status, remote changes, the realtime socket,
// deep links (kern://invite/…) and where this user is (presence).

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import type { ActiveSpace, SyncStatus } from "@/lib/types";
import { useRouter, type Route } from "@/stores/router";
import { getSetting, useSetting } from "@/stores/settings";
import { toast } from "@/stores/toast";
import { AuthDialog } from "./AuthDialog";
import { CreateWorkspaceDialog } from "./CreateWorkspace";
import { ImportDialog } from "./ImportDialog";
import { InviteDialog } from "./InviteDialog";
import { ManageWorkspaceDialog } from "./ManageWorkspace";
import { handleDeepLinks, leaveLostSpace, onApplied } from "./actions";
import { startRealtime, setPresence } from "./realtime";
import { openAuth, refreshMe, refreshStatus, setSync, useCloud } from "./store";

function viewOf(r: Route): { view: string; label?: string } {
  switch (r.name) {
    case "project":
      return { view: r.whiteboardId ? `wb:${r.whiteboardId}` : `project:${r.id}` };
    case "whiteboard":
      return { view: `wb:${r.id}` };
    case "task":
      return { view: `task:${r.id}` };
    case "notes":
      return { view: r.id ? `note:${r.id}` : "notes" };
    default:
      return { view: r.name };
  }
}

function useCloudEffects() {
  const enabled = useSetting("cloud.enabled");
  const share = useSetting("cloud.sharePresence");

  useEffect(() => {
    if (!isTauri) return;
    void refreshStatus().then((info) => {
      if (info?.signedIn) void refreshMe();
    });
    void handleDeepLinks();
    const offs = [
      listen<{ space: string; tables: string[]; whiteboards: string[] }>("kern://cloud-applied", (e) => {
        if (e.payload.space === useCloud.getState().info?.active?.id) onApplied(e.payload.tables, e.payload.whiteboards);
      }),
      listen<SyncStatus>("kern://cloud-sync", (e) => setSync(e.payload)),
      listen<ActiveSpace | null>("kern://cloud-space", () => void refreshStatus()),
      listen<string>("kern://cloud-auth", (e) => {
        void refreshStatus().then(() => refreshMe());
        if (e.payload === "expired" && getSetting("cloud.enabled")) {
          toast("Your Kern Cloud session ended. Sign in again to keep syncing.", {
            tone: "error",
            duration: 10_000,
            action: { label: "Sign in", run: () => openAuth({ email: useCloud.getState().info?.account?.email }) },
          });
        }
      }),
      listen<string>("kern://cloud-space-lost", (e) => {
        if (e.payload === useCloud.getState().info?.active?.id) {
          toast("This workspace is no longer available to you.", { tone: "error", duration: 8000 });
          void refreshMe().then((me) => leaveLostSpace(e.payload, me));
        }
      }),
      listen("kern://cloud-readonly", () => toast("You have view-only access here, so changes weren't saved.", { tone: "error" })),
      listen("kern://deep-link", () => void handleDeepLinks()),
    ];
    return () => offs.forEach((p) => void p.then((f) => f()));
  }, []);

  // The realtime socket follows the account and the open space.
  useEffect(() => (isTauri && enabled ? startRealtime() : undefined), [enabled]);

  // Share which page is open (whiteboards add the cursor themselves).
  useEffect(() => {
    if (!share) {
      setPresence(null);
      return;
    }
    const announce = (r: Route) => {
      if (r.name === "whiteboard" || (r.name === "project" && r.whiteboardId)) return;
      setPresence(viewOf(r));
    };
    announce(useRouter.getState().route);
    return useRouter.subscribe((s, prev) => {
      if (s.route !== prev.route) announce(s.route);
    });
  }, [share]);

  // Workspace data shown in dialogs is refreshed when membership changes.
  useEffect(
    () =>
      useCloud.subscribe((s, prev) => {
        if (s.me !== prev.me) void queryClient.invalidateQueries({ queryKey: ["cloud", "workspace"] });
      }),
    [],
  );
}

export function CloudHost() {
  useCloudEffects();
  return (
    <>
      <AuthDialog />
      <CreateWorkspaceDialog />
      <ManageWorkspaceDialog />
      <InviteDialog />
      <ImportDialog />
    </>
  );
}
