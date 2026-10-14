// Startup: load settings and the window mode, then show full Kern, Kern
// Lite, or the choice between them. Each mode's code loads on demand.

import { lazy, Suspense, useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { queryClient } from "@/lib/query";
import { useSettings } from "@/stores/settings";
import { useRouter, type Route } from "@/stores/router";
import { useFocus } from "@/features/focus/store";
import { useSessions } from "@/features/sessions/store";
import { reattachTerminals } from "@/features/terminal/store";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { Button } from "@/components/ui/Button";
import { describeError, isTauri } from "@/lib/ipc";
import { BrandMark } from "./BrandMark";
import { hideSplash } from "./splash";
import { loadMode, switchMode, useMode, type AppMode } from "./mode";
import { StartChooser } from "./StartChooser";
import { useUpdater } from "@/features/updates/store";
import { UpdateScreen } from "@/features/updates/UpdateScreen";
import { WhatsNewHost } from "@/features/updates/WhatsNew";

const Shell = lazy(() => import("./Shell"));
const LiteApp = lazy(() => import("@/features/lite/LiteApp"));

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

export function App() {
  const loaded = useSettings((s) => s.loaded);
  const mode = useMode((s) => s.mode);
  const updating = useUpdater((s) => s.phase !== null);
  const [error, setError] = useState<string | null>(null);

  const boot = async () => {
    setError(null);
    try {
      await Promise.all([useSettings.getState().load(), loadMode()]);
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
    // The tray menu and "Kern Lite" / "Kern" shortcuts switch modes.
    if (!isTauri) return;
    const off = listen<AppMode>("kern://switch-mode", (e) => void switchMode(e.payload));
    return () => void off.then((f) => f());
  }, []);

  useEffect(() => {
    if (error || (loaded && mode === null)) hideSplash();
  }, [loaded, error, mode]);

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
  if (!loaded || mode === undefined) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {updating ? (
          // The rest of the app steps aside while an update runs.
          <UpdateScreen />
        ) : (
          <>
            {mode === null ? (
              <StartChooser />
            ) : (
              <Suspense fallback={null}>{mode === "lite" ? <LiteApp /> : <Shell />}</Suspense>
            )}
            <WhatsNewHost />
          </>
        )}
      </TooltipProvider>
    </QueryClientProvider>
  );
}
