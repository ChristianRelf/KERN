/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ArchiveRestore, DatabaseBackup, Download, FileJson, FileSpreadsheet, FolderOpen, NotebookText, Trash, Upload } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import type { RestorePreview } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog, confirm } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Controls";
import { toast, toastError } from "@/stores/toast";
import { useAppInfo } from "@/hooks/data";
import { useSetting, setSetting } from "@/stores/settings";
import { formatBytes, todayStr } from "@/lib/dates";
import { format } from "date-fns";
import type { GroupDef } from "./controls";
import { SNumber, SSegmented } from "./controls";

const KIND_LABEL = { auto: "Automatic", manual: "Manual", "pre-restore": "Before restore", export: "Full export" } as const;

function useBackups() {
  return useQuery({ queryKey: ["backups"], queryFn: api.data.backupsList });
}

export function StorageStats() {
  const { data: s } = useQuery({ queryKey: ["stats", "storage"], queryFn: api.stats.storage });
  if (!s) return <Skeleton height={40} />;
  const total = s.dbBytes + s.attachmentsBytes || 1;
  return (
    <div className="col" style={{ gap: 8, width: "100%" }}>
      <div className="storage-bar">
        <div style={{ width: `${(s.dbBytes / total) * 100}%`, background: "var(--text-2)" }} />
        <div style={{ width: `${(s.attachmentsBytes / total) * 100}%`, background: "var(--text-4)" }} />
      </div>
      <div className="row faint" style={{ fontSize: "var(--fs-xs)", gap: 14, flexWrap: "wrap" }}>
        <span>Database {formatBytes(s.dbBytes)}</span>
        <span>
          Attachments {formatBytes(s.attachmentsBytes)} ({s.attachmentsCount})
        </span>
        <span>{s.tasks} tasks</span>
        <span>{s.projects} projects</span>
        <span>{s.notes} notes</span>
        <span>
          {s.whiteboards} whiteboards ({s.whiteboardObjects} objects)
        </span>
        <span>{s.activityEntries} activity entries</span>
        <span>{s.trashItems} in trash</span>
      </div>
    </div>
  );
}

function PathRow({ path }: { path: string }) {
  return (
    <div className="row" style={{ gap: 6, minWidth: 0 }}>
      <code className="mono truncate selectable" style={{ fontSize: "var(--fs-xs)", color: "var(--text-2)" }} title={path}>
        {path}
      </code>
      <IconButton icon={FolderOpen} label="Show in folder" size="sm" onClick={() => void api.system.reveal(path).catch((e) => toastError(describeError(e)))} />
    </div>
  );
}

function RestoreDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const { data: preview, error, isLoading } = useQuery<RestorePreview>({ queryKey: ["restore-preview", path], queryFn: () => api.data.backupPreview(path), retry: false });
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    try {
      const safety = await api.data.backupRestore(path);
      toast(`Restored. Your previous data was saved to ${safety.fileName}.`);
      // Reload so every view picks up the restored data.
      window.setTimeout(() => window.location.reload(), 600);
    } catch (e) {
      setBusy(false);
      toastError(describeError(e, "Restore failed. Your current data is unchanged."));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && onClose()}
      title="Restore backup"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void restore()} disabled={!preview?.valid || busy}>
            {busy ? "Restoring…" : "Replace current data"}
          </Button>
        </>
      }
    >
      {isLoading && <Skeleton height={60} />}
      {error && <p className="dialog__desc">{describeError(error, "This file can't be read as a backup.")}</p>}
      {preview && (
        <>
          <p className="dialog__desc">
            Created {format(new Date(preview.manifest.createdAt), "d MMM yyyy, HH:mm")} by version {preview.manifest.appVersion}
            {" · "}
            {KIND_LABEL[preview.manifest.kind] ?? preview.manifest.kind}
          </p>
          <div className="props">
            {Object.entries(preview.counts).map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <span className="props__label" style={{ textTransform: "capitalize" }}>
                  {k}
                </span>
                <span className="tabular">{v}</span>
              </div>
            ))}
            <span className="props__label">Attachments</span>
            <span>{preview.hasAttachments ? "Included" : "None"}</span>
          </div>
          {preview.valid ? (
            <p className="dialog__desc">
              Everything currently in the app will be replaced by this backup. A safety backup of your current data is made first, so this can be reversed.
            </p>
          ) : (
            <p className="dialog__desc" style={{ color: "var(--danger)" }}>
              {preview.problems.join(" ")}
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}

export function useDataGroups(): GroupDef[] {
  const { data: info } = useAppInfo();
  const { data: backups } = useBackups();
  const backupDir = useSetting("backups.dir");
  const frequency = useSetting("backups.frequency");
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toastError(describeError(e, `${label} failed.`));
    } finally {
      setBusy(null);
    }
  };

  const backupNow = () =>
    run("Backup", async () => {
      const b = await api.data.backupCreate();
      invalidate("backups");
      toast(`Backed up (${formatBytes(b.size)})`);
    });

  const chooseDir = async () => {
    const dir = await openDialog({ directory: true, title: "Choose backup folder" });
    if (typeof dir === "string") {
      await setSetting("backups.dir", dir);
      invalidate("backups");
    }
  };

  const restoreFromFile = async () => {
    const file = await openDialog({ title: "Choose a backup or export", filters: [{ name: "Kern archive", extensions: ["zip"] }] });
    if (typeof file === "string") setRestorePath(file);
  };

  const stamp = todayStr();
  const exportAll = () =>
    run("Export", async () => {
      const path = await saveDialog({ defaultPath: `kern-export-${stamp}.zip`, filters: [{ name: "Zip archive", extensions: ["zip"] }] });
      if (!path) return;
      const r = await api.data.exportAll(path);
      toast(`Exported ${formatBytes(r.size)}`, { action: { label: "Show", run: () => void api.system.reveal(r.path) } });
    });
  const exportCsv = () =>
    run("Export", async () => {
      const path = await saveDialog({ defaultPath: `kern-tasks-${stamp}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!path) return;
      await api.data.exportTasksCsv(path);
      toast("Tasks exported", { action: { label: "Show", run: () => void api.system.reveal(path) } });
    });
  const exportNotes = () =>
    run("Export", async () => {
      const dir = await openDialog({ directory: true, title: "Choose a folder for the Markdown files" });
      if (typeof dir !== "string") return;
      const n = await api.data.exportNotesMarkdown(dir);
      toast(`${n} note${n === 1 ? "" : "s"} exported`, { action: { label: "Show", run: () => void api.system.reveal(dir) } });
    });
  const exportProjects = () =>
    run("Export", async () => {
      const path = await saveDialog({ defaultPath: `kern-projects-${stamp}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path) return;
      await api.data.exportProjectsJson(path);
      toast("Projects exported", { action: { label: "Show", run: () => void api.system.reveal(path) } });
    });

  return [
    {
      id: "settings-backups",
      title: "Backups",
      rows: [
        { label: "Automatic backups", hint: "Consistent snapshots of the database plus attachments.", control: <SSegmented k="backups.frequency" options={[{ value: "off", label: "Off" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }]} /> },
        { label: "Keep", hint: "Older automatic backups are removed.", control: <SNumber k="backups.keep" min={1} max={200} suffix="backups" /> },
        {
          label: "Backup folder",
          keywords: "location directory",
          control: (
            <div className="row" style={{ gap: 6 }}>
              {backupDir && (
                <Button size="sm" variant="ghost" onClick={() => void setSetting("backups.dir", null).then(() => invalidate("backups"))}>
                  Use default
                </Button>
              )}
              <Button size="sm" onClick={() => void chooseDir()}>
                Choose…
              </Button>
            </div>
          ),
          block: <PathRow path={backupDir ?? info?.defaultBackupsDir ?? ""} />,
        },
        {
          label: "Back up now",
          hint: frequency === "off" ? "Automatic backups are off." : undefined,
          control: (
            <Button size="sm" icon={DatabaseBackup} onClick={() => void backupNow()} disabled={!!busy}>
              {busy === "Backup" ? "Backing up…" : "Back up now"}
            </Button>
          ),
        },
        {
          label: "Backup history",
          keywords: "restore previous",
          control: (
            <Button size="sm" icon={ArchiveRestore} onClick={() => void restoreFromFile()}>
              Restore from file…
            </Button>
          ),
          block: (
            <div className="col" style={{ gap: 2, width: "100%" }}>
              {!backups?.length && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>No backups yet.</span>}
              {backups?.slice(0, 20).map((b) => (
                <div key={b.path} className="list-row" style={{ minHeight: 30, padding: "2px 6px" }}>
                  <DatabaseBackup strokeWidth={1.75} />
                  <span className="grow truncate" style={{ fontSize: "var(--fs-sm)" }}>
                    {format(new Date(b.manifest.createdAt), "EEE d MMM yyyy, HH:mm")}
                    <span className="faint">
                      {" · "}
                      {KIND_LABEL[b.manifest.kind] ?? b.manifest.kind} · {formatBytes(b.size)} · {b.manifest.counts.tasks ?? 0} tasks
                    </span>
                  </span>
                  <div className="list-row__actions">
                    <Button size="sm" onClick={() => setRestorePath(b.path)}>
                      Restore…
                    </Button>
                    <IconButton icon={FolderOpen} label="Show in folder" size="sm" onClick={() => void api.system.reveal(b.path)} />
                    <IconButton
                      icon={Trash}
                      label="Delete backup"
                      size="sm"
                      onClick={async () => {
                        if (await confirm({ title: "Delete this backup?", message: b.fileName, confirmLabel: "Delete", danger: true })) {
                          await api.data.backupDelete(b.path).catch((e) => toastError(describeError(e)));
                          invalidate("backups");
                        }
                      }}
                    />
                  </div>
                </div>
              ))}
              {restorePath && <RestoreDialog path={restorePath} onClose={() => setRestorePath(null)} />}
            </div>
          ),
        },
      ],
    },
    {
      title: "Export & import",
      rows: [
        {
          label: "Export everything",
          hint: "A portable archive: database, JSON for every table, Markdown notes, whiteboards, attachments and settings.",
          control: (
            <Button size="sm" icon={Download} onClick={() => void exportAll()} disabled={!!busy}>
              Export…
            </Button>
          ),
        },
        {
          label: "Import from backup or export",
          hint: "Replaces current data after a preview; a safety backup is made first.",
          keywords: "restore",
          control: (
            <Button size="sm" icon={Upload} onClick={() => void restoreFromFile()}>
              Import…
            </Button>
          ),
        },
        { label: "Tasks as CSV", control: <Button size="sm" icon={FileSpreadsheet} onClick={() => void exportCsv()}>Export…</Button> },
        { label: "Notes as Markdown", control: <Button size="sm" icon={NotebookText} onClick={() => void exportNotes()}>Export…</Button> },
        { label: "Projects as JSON", control: <Button size="sm" icon={FileJson} onClick={() => void exportProjects()}>Export…</Button> },
      ],
    },
    {
      title: "Contents & retention",
      rows: [
        { label: "Contents", keywords: "size statistics counts", block: <StorageStats /> },
        { label: "Keep deleted items for", hint: "Trash is emptied automatically after this many days (0 keeps them forever).", control: <SNumber k="data.trashRetentionDays" min={0} max={3650} suffix="days" /> },
        { label: "Keep activity history for", control: <SNumber k="data.activityRetentionDays" min={7} max={3650} suffix="days" /> },
      ],
    },
  ];
}
