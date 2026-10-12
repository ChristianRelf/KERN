// Settings → Data & Storage: what Kern stores, where, and safe cleanup.

import { ClipboardCopy, FolderOpen, Info, RefreshCw, X } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { api, describeError, isTauri } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import type { StorageCleanup, StorageLocation, StorageReport } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Popover, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { confirm } from "@/components/ui/Dialog";
import { toast, toastError } from "@/stores/toast";
import { formatBytes, relativeTime } from "@/lib/dates";
import { useSetting } from "@/stores/settings";
import { copyText, shortPath } from "@/features/projects/folders";
import { SToggle, type GroupDef } from "@/features/settings/controls";
import { CATEGORY_HINT, CATEGORY_LABEL, displayCategories } from "./categories";
import { resetNoteFavicons } from "@/features/links/faviconCache";

const StorageChart = lazy(() => import("./StorageChart"));

export function useStorageReport() {
  return useQuery({ queryKey: ["storage", "report"], queryFn: api.storage.report, staleTime: Infinity });
}

interface ScanState {
  running: boolean;
  files: number;
  bytes: number;
  phase: string;
}

/** Runs scans and tracks their progress (shared by settings and the widget). */
export function useStorageScan() {
  const [state, setState] = useState<ScanState>({ running: false, files: 0, bytes: 0, phase: "" });
  useEffect(() => {
    if (!isTauri) return;
    const off = listen<{ phase: string; files: number; bytes: number }>("kern://storage-scan", (e) =>
      setState((s) => (s.running ? { ...s, ...e.payload } : s)),
    );
    return () => void off.then((f) => f());
  }, []);
  const run = async (includeLinked: boolean) => {
    setState({ running: true, files: 0, bytes: 0, phase: "kern" });
    try {
      const report = await api.storage.scan(includeLinked);
      queryClient.setQueryData(["storage", "report"], report);
      return report;
    } catch (e) {
      toastError(describeError(e, "The storage scan failed."));
      return null;
    } finally {
      setState((s) => ({ ...s, running: false }));
    }
  };
  return { ...state, run, cancel: () => void api.storage.cancel() };
}

function Overview({ report, scan }: { report: StorageReport | null | undefined; scan: ReturnType<typeof useStorageScan> }) {
  const includeLinked = useSetting("storage.includeLinkedFolders");
  return (
    <div className="storage-overview">
      {report ? (
        <Suspense fallback={<Skeleton height={168} />}>
          <StorageChart categories={report.categories} total={report.totalBytes} />
        </Suspense>
      ) : (
        <Skeleton height={168} />
      )}
      <div className="storage-overview__meta">
        {scan.running ? (
          <span className="faint tabular">
            Scanning{scan.phase === "linked" ? " linked folders" : ""}… {scan.files.toLocaleString()} files · {formatBytes(scan.bytes)}
          </span>
        ) : report ? (
          <span className="faint">
            {report.totalFiles.toLocaleString()} files · last scanned {relativeTime(report.scannedAt)}
            {report.skipped > 0 && ` · ${report.skipped} items couldn't be read`}
          </span>
        ) : (
          <span className="faint">Not scanned yet.</span>
        )}
        <span className="spacer" />
        {scan.running ? (
          <Button size="sm" icon={X} onClick={scan.cancel}>
            Cancel
          </Button>
        ) : (
          <Button size="sm" icon={RefreshCw} onClick={() => void scan.run(includeLinked)}>
            Scan now
          </Button>
        )}
      </div>
    </div>
  );
}

function LocationRow({ loc, report }: { loc: StorageLocation; report: StorageReport }) {
  const isFile = loc.id === "database";
  const usage = displayCategories(report.categories).find((c) => c.id === loc.id || (loc.id === "webview" && c.id === "cache"));
  return (
    <div className="list-row storage-location">
      <span className="col grow" style={{ minWidth: 0 }}>
        <span style={{ fontSize: "var(--fs-sm)" }}>{loc.label}</span>
        <Tooltip content={loc.path}>
          <span className="mono faint truncate" style={{ fontSize: "var(--fs-xs)" }}>
            {shortPath(loc.path, 72)}
          </span>
        </Tooltip>
      </span>
      {!loc.exists && <span className="chip">Not created yet</span>}
      <div className="row" style={{ gap: 0 }}>
        <IconButton icon={ClipboardCopy} label="Copy path" size="sm" onClick={() => void copyText(loc.path)} />
        <IconButton
          icon={FolderOpen}
          label={isFile ? "Show in folder" : "Open folder"}
          size="sm"
          disabled={!loc.exists}
          onClick={() => void (isFile ? api.system.reveal(loc.path) : api.system.open(loc.path)).catch((e) => toastError(describeError(e)))}
        />
        <Popover pad align="end" trigger={<IconButton icon={Info} label="Details" size="sm" noTooltip />}>
          <div className="col" style={{ gap: 6, width: 280, fontSize: "var(--fs-sm)" }}>
            <b>{loc.label}</b>
            <span className="mono selectable" style={{ fontSize: "var(--fs-xs)", wordBreak: "break-all" }}>
              {loc.path}
            </span>
            {usage && usage.bytes > 0 && (
              <span className="faint">
                {CATEGORY_LABEL[usage.id]}: {formatBytes(usage.bytes)} in {usage.files.toLocaleString()} files
              </span>
            )}
            {usage && usage.id !== "logsOther" && <span className="faint">{CATEGORY_HINT[usage.id]}</span>}
          </div>
        </Popover>
      </div>
    </div>
  );
}

const CLEANUPS: { id: StorageCleanup; label: string; hint: string; confirm?: string }[] = [
  { id: "favicons", label: "Clear website icons", hint: "Cached favicons are fetched again when links are shown (if allowed in Privacy)." },
  { id: "expiredPreviews", label: "Clear expired link previews", hint: "Link titles fetched more than 30 days ago." },
  { id: "temporary", label: "Clear temporary files", hint: "Leftovers from interrupted exports and restores." },
  {
    id: "unusedWhiteboardAssets",
    label: "Remove unused whiteboard images",
    hint: "Images no longer placed on any whiteboard (including whiteboards in the trash) for over a day.",
    confirm: "Images that aren't on any whiteboard are deleted permanently. Images on whiteboards - even in the trash - are kept.",
  },
];

function CleanupButton({ c }: { c: (typeof CLEANUPS)[number] }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (c.confirm && !(await confirm({ title: `${c.label}?`, message: c.confirm, confirmLabel: "Remove", danger: true }))) return;
    setBusy(true);
    try {
      const freed = await api.storage.cleanup(c.id);
      toast(freed > 0 ? `Freed ${formatBytes(freed)}` : "Nothing to clear");
      invalidate("storage", "favicon");
      if (c.id === "favicons") resetNoteFavicons();
    } catch (e) {
      toastError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button size="sm" onClick={() => void run()} disabled={busy}>
      {busy ? "Clearing…" : "Clear"}
    </Button>
  );
}

function LinkedFolders({ report, scan }: { report: StorageReport | null | undefined; scan: ReturnType<typeof useStorageScan> }) {
  const enabled = useSetting("storage.includeLinkedFolders");
  if (!enabled) return null;
  if (!report?.linked)
    return (
      <div className="row" style={{ gap: 8 }}>
        <span className="faint grow" style={{ fontSize: "var(--fs-sm)" }}>
          Linked folders haven't been measured yet.
        </span>
        <Button size="sm" icon={RefreshCw} disabled={scan.running} onClick={() => void scan.run(true)}>
          Measure
        </Button>
      </div>
    );
  if (!report.linked.length) return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No projects are linked to folders.</span>;
  return (
    <div className="col" style={{ gap: 2, width: "100%" }}>
      {report.linked.map((l) => (
        <div key={l.projectId} className="list-row">
          <FolderOpen strokeWidth={1.75} />
          <span className="col grow" style={{ minWidth: 0 }}>
            <span style={{ fontSize: "var(--fs-sm)" }}>{l.projectName}</span>
            <Tooltip content={l.path}>
              <span className="mono faint truncate" style={{ fontSize: "var(--fs-xs)" }}>
                {shortPath(l.path, 64)}
              </span>
            </Tooltip>
          </span>
          {l.note && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{l.note}</span>}
          <span className="tabular" style={{ fontSize: "var(--fs-sm)" }}>
            {l.files ? `${formatBytes(l.bytes)} · ${l.files.toLocaleString()} files` : "-"}
          </span>
        </div>
      ))}
    </div>
  );
}

export function useStorageGroups(): GroupDef[] {
  const { data: report, isFetched } = useStorageReport();
  const scan = useStorageScan();
  const started = useRef(false);
  // First visit with no measurement yet: scan once (in the background).
  useEffect(() => {
    if (isFetched && report === null && !started.current) {
      started.current = true;
      void scan.run(false);
    }
  }, [isFetched, report]);

  return [
    {
      title: "Storage",
      rows: [
        {
          label: "Kern data on this computer",
          keywords: "storage usage disk space chart size scan",
          block: <Overview report={report} scan={scan} />,
        },
      ],
    },
    {
      title: "Storage locations",
      rows: [
        {
          label: "Where your data lives",
          keywords: "path folder location database backups cache open",
          block: report ? (
            <div className="col" style={{ gap: 2, width: "100%" }}>
              {report.locations.map((l) => (
                <LocationRow key={l.id} loc={l} report={report} />
              ))}
            </div>
          ) : (
            <Skeleton height={60} />
          ),
        },
      ],
    },
    {
      title: "Linked project folders",
      rows: [
        {
          label: "Measure linked project folders",
          hint: "These files belong to your own folders, not to Kern, so they're never part of Kern's storage total. Measuring them reads only file sizes.",
          keywords: "external projects folders size",
          control: <SToggle k="storage.includeLinkedFolders" />,
          block: <LinkedFolders report={report} scan={scan} />,
        },
      ],
    },
    {
      title: "Cleanup",
      rows: [
        ...CLEANUPS.map((c) => ({ label: c.label, hint: c.hint, keywords: "cache clear free space", control: <CleanupButton c={c} /> })),
        {
          label: "Old backups",
          hint: "Delete individual backups from the list under Backups, or lower how many automatic backups are kept.",
          keywords: "manage backups delete",
          control: (
            <Button size="sm" variant="ghost" onClick={() => document.getElementById("settings-backups")?.scrollIntoView({ behavior: "smooth" })}>
              Manage backups
            </Button>
          ),
        },
      ],
    },
  ];
}
