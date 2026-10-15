/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// "What's new" after an update: the release's notes, read from its GitHub
// page (or, offline, from the update's own manifest), shown once on the
// first start of a new version. It can also be opened from Settings → About.

import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Controls";
import { api } from "@/lib/ipc";
import { renderMarkdown, safeHref } from "@/lib/markdown";
import { useSettings } from "@/stores/settings";
import { APP_NAME } from "@/app/brand";
import { compareVersions, inAppNotes, isSecurityRelease } from "./notes";
import { PENDING_KEY, type PendingUpdate } from "./store";
import { RELEASES_PAGE } from "./constants";
import "./updates.css";

/** Settings key: the version that ran last on this device. */
const LAST_KEY = "internal.lastVersion";

const useWhatsNew = create<{ version: string | null; fallback: string | null }>(() => ({ version: null, fallback: null }));

export function openWhatsNew(version: string, fallback: string | null = null) {
  useWhatsNew.setState({ version, fallback });
}

let noted = false;

/**
 * Once per start: notes that this version has run, and opens What's new when
 * it was just updated to (by the updater, or from an older version).
 */
async function noteVersionRun() {
  // The host remounts after an update screen gives way; the settings read
  // here are from startup, so only the first run may act on them.
  if (noted) return;
  noted = true;
  const [{ version }, raw] = [await api.system.info(), useSettings.getState().raw];
  const pending = raw[PENDING_KEY] as PendingUpdate | null | undefined;
  const last = typeof raw[LAST_KEY] === "string" ? (raw[LAST_KEY] as string) : null;
  const viaUpdater = !!pending && pending.to === version;
  // Versions before this one didn't record themselves: someone who has used
  // Kern before (a saved last page) has updated; a fresh install hasn't.
  const newer = last ? compareVersions(last, version) < 0 : raw["internal.lastRoute"] !== undefined;
  if (last !== version || pending) await api.settings.set({ [LAST_KEY]: version, ...(pending ? { [PENDING_KEY]: null } : {}) });
  if (viaUpdater || newer) openWhatsNew(version, viaUpdater ? (pending?.notes ?? null) : null);
}

export function WhatsNewHost() {
  const { version, fallback } = useWhatsNew();
  useEffect(() => {
    void noteVersionRun().catch(() => undefined);
  }, []);
  const notes = useQuery({
    queryKey: ["releaseNotes", version],
    queryFn: () => api.system.releaseNotes(version!),
    enabled: !!version,
    staleTime: Infinity,
    retry: 1,
  });
  const body = notes.data?.body || fallback || "";
  const html = useMemo(() => (body ? renderMarkdown(inAppNotes(body)) : ""), [body]);
  const url = notes.data?.url ?? (version ? `${RELEASES_PAGE}/tag/v${version}` : RELEASES_PAGE);
  const published = notes.data?.publishedAt ? new Date(notes.data.publishedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : null;
  const close = () => useWhatsNew.setState({ version: null, fallback: null });

  return (
    <Dialog
      open={!!version}
      onOpenChange={(o) => !o && close()}
      wide
      title={`What's new in ${APP_NAME} ${version ?? ""}`}
      footer={
        <>
          <Button icon={ArrowUpRight} onClick={() => void api.system.open(url).catch(() => undefined)}>
            Release page
          </Button>
          <span className="grow" />
          <Button variant="primary" onClick={close} autoFocus>
            Got it
          </Button>
        </>
      }
    >
      {(published || isSecurityRelease(body)) && (
        <div className="whats-new__meta">
          {isSecurityRelease(body) && <span className="security-badge">Security update</span>}
          {published && `Released ${published}`}
        </div>
      )}
      {html ? (
        <div
          className="prose whats-new__notes selectable"
          // Sanitised by renderMarkdown; links open in the browser.
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={(e) => {
            const a = (e.target as HTMLElement).closest("a");
            if (!a) return;
            e.preventDefault();
            const href = safeHref(a.getAttribute("href"));
            if (href) void api.system.open(href).catch(() => undefined);
          }}
        />
      ) : notes.isLoading ? (
        <div className="col" style={{ gap: 8 }}>
          <Skeleton width="40%" height={14} />
          <Skeleton width="90%" />
          <Skeleton width="75%" />
          <Skeleton width="82%" />
        </div>
      ) : (
        <p className="faint" style={{ margin: 0 }}>
          The notes for this version couldn't be loaded. They're on the release page.
        </p>
      )}
    </Dialog>
  );
}
