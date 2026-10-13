import { lazy, Suspense, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query";
import { useSettings } from "@/stores/settings";
import { useRouter, type Route } from "@/stores/router";
import { useFocus } from "@/features/focus/store";
import { useSessions } from "@/features/sessions/store";
import { SessionGapHost } from "@/features/sessions/SessionUi";
import { StartWorkHost } from "@/features/sessions/StartWork";
import { FileViewerHost } from "@/features/files/FileViewerHost";
import { useWorktreeDialog } from "@/features/dev/worktreeDialog";
import { useTerminal, reattachTerminals } from "@/features/terminal/store";
import { useUi } from "@/stores/ui";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { Toaster } from "@/components/ui/Toaster";
import { ConfirmHost, PromptHost } from "@/components/ui/Dialog";
import { Sidebar } from "@/components/layout/Sidebar";
import { Inspector } from "@/components/layout/Inspector";
import { Routes } from "./Routes";
import { useAppearance, useBackendEvents, useGlobalShortcuts, useOsIntegration, useRememberRoute, useWorkSessions } from "./effects";
import { CommandPalette } from "@/features/search/CommandPalette";
import { QuickCapture } from "@/features/capture/QuickCapture";
import { CreateProjectDialog } from "@/features/projects/CreateProjectDialog";
import { TaskModal } from "@/features/tasks/TaskModal";
import { TaskComposer } from "@/features/tasks/TaskComposer";
import { TrustPromptHost } from "@/features/projects/folders";
import { RepoPickerHost } from "@/features/github/shared";
import { ShortcutsDialog } from "@/features/settings/ShortcutsDialog";
import { BriefingPrompt } from "@/features/daily-briefing/BriefingPrompt";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { Button } from "@/components/ui/Button";
import { describeError } from "@/lib/ipc";
import { BrandMark } from "./BrandMark";
import { CloudHost } from "@/features/cloud/CloudHost";

const TerminalPanel = lazy(() => import("@/features/terminal/TerminalPanel"));
const CatchupHost = lazy(() => import("@/features/catchup/CatchupDialog"));
const WorktreeDialogHost = lazy(() => import("@/features/dev/Worktrees"));

/** Hosts that load their code only once they're needed. */
function LazyHosts() {
  const catchup = useUi((s) => !!s.catchupProjectId);
  const worktree = useWorktreeDialog((s) => !!s.req);
  return (
    <Suspense fallback={null}>
      {catchup && <CatchupHost />}
      {worktree && <WorktreeDialogHost />}
    </Suspense>
  );
}

function TerminalDrawer() {
  const needed = useTerminal((s) => s.open && s.tabs.length > 0);
  return needed ? (
    <Suspense fallback={null}>
      <TerminalPanel />
    </Suspense>
  ) : null;
}

/** Fades out and removes the startup splash painted by index.html. */
function hideSplash() {
  const el = document.getElementById("splash");
  if (!el || el.dataset.hidden !== undefined) return;
  el.dataset.hidden = "";
  window.setTimeout(() => el.remove(), 200);
}

function initialRoute(): Route {
  const { values, raw } = useSettings.getState();
  switch (values["general.landing"]) {
    case "tasks":
      return { name: "tasks" };
    case "inbox":
      return { name: "inbox" };
    case "last": {
      const r = raw["internal.lastRoute"] as Route | undefined;
      return r && typeof r === "object" && "name" in r ? r : { name: "dashboard" };
    }
    default:
      return { name: "dashboard" };
  }
}

function Shell() {
  useEffect(() => {
    // Startup marker (ms since the page started loading); see PERFORMANCE.md.
    (window as unknown as { __kernReadyAt?: number }).__kernReadyAt ??= performance.now();
  }, []);
  useAppearance();
  useOsIntegration();
  useBackendEvents();
  useGlobalShortcuts();
  useRememberRoute();
  useWorkSessions();
  return (
    <div className="shell">
      <Sidebar />
      <main className="workspace">
        <div className="workspace__main">
          <Routes />
        </div>
        <TerminalDrawer />
      </main>
      <Inspector />
      <CommandPalette />
      <QuickCapture />
      <CreateProjectDialog />
      <TaskModal />
      <TaskComposer />
      <ShortcutsDialog />
      <BriefingPrompt />
      <Onboarding />
      <TrustPromptHost />
      <RepoPickerHost />
      <SessionGapHost />
      <StartWorkHost />
      <FileViewerHost />
      <LazyHosts />
      <CloudHost />
      <ConfirmHost />
      <PromptHost />
      <Toaster />
    </div>
  );
}

export function App() {
  const loaded = useSettings((s) => s.loaded);
  const [error, setError] = useState<string | null>(null);

  const boot = async () => {
    setError(null);
    try {
      await useSettings.getState().load();
      useRouter.setState({ route: initialRoute() });
      void useFocus.getState().hydrate();
      void useSessions.getState().hydrate();
      void reattachTerminals();
    } catch (e) {
      setError(describeError(e, "Couldn't load your data."));
    }
  };

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    if (loaded || error) hideSplash();
  }, [loaded, error]);

  if (error)
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <div className="col" style={{ alignItems: "center", gap: 12, color: "var(--text-2)" }}>
          <BrandMark size={28} />
          <span>{error}</span>
          <Button onClick={() => void boot()}>Retry</Button>
        </div>
      </div>
    );
  if (!loaded) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Shell />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
