// Linked project folders: the trust prompt, folder picking, the compact
// folder element shown in project overviews and the Files tab browser.
// All filesystem access goes through Kern's Rust commands (api.folders),
// which verify every path against the linked folder.

import {
  ArrowLeft,
  ArrowUpDown,
  ClipboardCopy,
  Copy,
  CornerLeftUp,
  Ellipsis,
  ExternalLink,
  Eye,
  FilePlus,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  FolderSync,
  FolderX,
  Pencil,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldHalf,
  Trash2,
  Unlink,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useQuery } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { FileEntry, FolderInfo, Project, ProjectFolder, Trust } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { Dialog, confirm, confirmDelete, prompt } from "@/components/ui/Dialog";
import { isMac } from "@/lib/shortcuts";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, ContextMenu, type MenuItems } from "@/components/ui/Menu";
import { EmptyState, Skeleton, Switch } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { toast, toastError } from "@/stores/toast";
import { formatBytes, relativeTime } from "@/lib/dates";
import { FileTypeIcon } from "./fileIcons";
import { FileViewer, ImageHoverCard, canHoverPreview, isImage, viewableInApp } from "@/features/files/FileViewer";
import { SyntaxPrompt } from "@/features/plugins/SyntaxPrompt";
import { recordWorkspace } from "@/features/workspace/store";

export async function copyText(text: string, what = "Path") {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toastError("Couldn't copy to the clipboard.");
  }
}

/** Middle-truncates long paths so both the drive and the folder name stay visible. */
export function shortPath(path: string, max = 52): string {
  if (path.length <= max) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep);
  const head = parts.slice(0, 2).join(sep);
  const tail = parts[parts.length - 1];
  const room = max - head.length - tail.length - 5;
  if (room <= 0) return `${head}${sep}…${sep}${tail}`.slice(0, max);
  let middle = "";
  for (let i = parts.length - 2; i >= 2; i--) {
    const next = parts[i] + (middle ? sep + middle : "");
    if (next.length > room) break;
    middle = next;
  }
  return `${head}${sep}…${sep}${middle ? middle + sep : ""}${tail}`;
}

// ------------------------------------------------------------ trust prompt

interface TrustReq {
  info: FolderInfo;
  resolve: (t: Trust | null) => void;
}

const useTrustPrompt = create<{ req: TrustReq | null }>(() => ({ req: null }));

/** Asks how much to trust a folder. Resolves null on Cancel. */
export function askTrust(info: FolderInfo): Promise<Trust | null> {
  return new Promise((resolve) => useTrustPrompt.setState({ req: { info, resolve } }));
}

export function TrustPromptHost() {
  const req = useTrustPrompt((s) => s.req);
  const close = (t: Trust | null) => {
    req?.resolve(t);
    useTrustPrompt.setState({ req: null });
  };
  return (
    <Dialog
      open={!!req}
      onOpenChange={(o) => !o && close(null)}
      title="Do you trust the authors of the files in this folder?"
      centered
      className="trust-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button onClick={() => close("restricted")}>Open in Restricted Mode</Button>
          <Button variant="primary" autoFocus onClick={() => close("trusted")}>
            Trust Folder
          </Button>
        </>
      }
    >
      {req && (
        <>
          <div className="trust-dialog__path selectable">
            <FolderOpen size={15} strokeWidth={1.75} />
            <span>{req.info.path}</span>
          </div>
          <p className="dialog__desc">
            Some project features may access local files or run tools in this directory. Only enable those capabilities if you trust the contents of this folder.
          </p>
          <div className="trust-dialog__modes">
            <div>
              <ShieldCheck size={14} />
              <span>
                <b>Trusted</b> — open programs and scripts (each one confirmed), create and rename items, and allow AI file access per project.
              </span>
            </div>
            <div>
              <ShieldHalf size={14} />
              <span>
                <b>Restricted</b> — browse, reveal and open documents. Nothing runs.
              </span>
            </div>
          </div>
          {req.info.linkedProjects.length > 0 && <p className="dialog__desc faint">Also linked to {req.info.linkedProjects.join(", ")}.</p>}
        </>
      )}
    </Dialog>
  );
}

export interface PickedFolder {
  info: FolderInfo;
  trust: Trust;
}

/**
 * Native folder picker → canonical folder info → trust decision. A folder
 * trusted before is linked without asking again; anything else prompts.
 * Returns null if the user cancels at any point.
 */
export async function pickFolder(title = "Choose a project folder"): Promise<PickedFolder | null> {
  const picked = await openDialog({ directory: true, title });
  if (typeof picked !== "string") return null;
  let info: FolderInfo;
  try {
    info = await api.folders.inspect(picked);
  } catch (e) {
    toastError(describeError(e, "Couldn't read that folder."));
    return null;
  }
  if (info.trust === "trusted") return { info, trust: "trusted" };
  const trust = await askTrust(info);
  return trust ? { info, trust } : null;
}

export async function linkFolder(project: Pick<Project, "id" | "name">) {
  const picked = await pickFolder(`Choose a folder for ${project.name}`);
  if (!picked) return;
  try {
    await api.folders.link(project.id, picked.info.path, picked.trust);
    invalidate("folder", "files", "projects", "project", "trusted", "activity");
    toast(`Linked to ${picked.info.name}${picked.trust === "restricted" ? " (restricted)" : ""}`);
  } catch (e) {
    toastError(describeError(e, "Couldn't link the folder."));
  }
}

export async function unlinkFolder(project: Pick<Project, "id" | "name">, folder: Pick<ProjectFolder, "name">) {
  const ok = await confirm({
    title: `Remove the link to ${folder.name}?`,
    message: "Only the association is removed. The folder and its files stay exactly where they are.",
    confirmLabel: "Remove link",
  });
  if (!ok) return;
  try {
    await api.folders.unlink(project.id);
    invalidate("folder", "files", "projects", "project");
  } catch (e) {
    toastError(describeError(e));
  }
}

export async function setFolderTrust(projectId: string, trust: Trust, folder: Pick<ProjectFolder, "path" | "name">) {
  if (trust === "trusted") {
    const t = await askTrust({ path: folder.path, name: folder.name, trust: "restricted", linkedProjects: [] });
    if (t !== "trusted") return;
  }
  try {
    await api.folders.setTrust(projectId, trust);
    invalidate("folder", "files", "projects", "project", "trusted");
    toast(trust === "trusted" ? "Folder trusted" : "Folder restricted");
  } catch (e) {
    toastError(describeError(e));
  }
}

export function useProjectFolder(projectId: string | null | undefined, linked = true) {
  return useQuery({
    queryKey: ["folder", projectId],
    queryFn: () => api.folders.get(projectId!),
    enabled: !!projectId && linked,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

function TrustBadge({ trust }: { trust: Trust }) {
  return (
    <Tooltip content={trust === "trusted" ? "Trusted folder" : "Restricted mode: browse and open documents only"}>
      <span className="trust-badge" data-trust={trust}>
        {trust === "trusted" ? <ShieldCheck /> : <ShieldHalf />}
        {trust === "trusted" ? "Trusted" : "Restricted"}
      </span>
    </Tooltip>
  );
}

// ------------------------------------------------------------ creation field

/** Folder selector for the New Project dialog. Nothing is linked until the project is created. */
export function FolderField({ value, onChange }: { value: PickedFolder | null; onChange: (v: PickedFolder | null) => void }) {
  if (!value)
    return (
      <button
        type="button"
        className="folder-field folder-field--empty"
        onClick={async () => {
          const picked = await pickFolder();
          if (picked) onChange(picked);
        }}
      >
        <FolderOpen size={15} strokeWidth={1.75} />
        <span className="grow">Link a folder on this computer…</span>
        <span className="faint">Optional</span>
      </button>
    );
  return (
    <div className="folder-field">
      <FolderOpen size={15} strokeWidth={1.75} />
      <div className="col grow" style={{ minWidth: 0 }}>
        <span className="truncate" style={{ fontWeight: 550 }}>
          {value.info.name}
        </span>
        <Tooltip content={value.info.path}>
          <span className="folder-field__path truncate">{shortPath(value.info.path)}</span>
        </Tooltip>
      </div>
      <TrustBadge trust={value.trust} />
      <Dropdown
        align="end"
        items={[
          {
            label: "Change folder…",
            icon: FolderSync,
            onSelect: async () => {
              const picked = await pickFolder();
              if (picked) onChange(picked);
            },
          },
          { label: "Open in file manager", icon: ExternalLink, onSelect: () => void api.system.open(value.info.path).catch((e) => toastError(describeError(e))) },
          { label: "Copy path", icon: ClipboardCopy, onSelect: () => void copyText(value.info.path) },
          { type: "separator" },
          { label: "Remove", icon: FolderX, onSelect: () => onChange(null) },
        ]}
      >
        <IconButton icon={Ellipsis} label="Folder options" size="sm" noTooltip />
      </Dropdown>
    </div>
  );
}

// ------------------------------------------------------------ overview card

export function folderMenu(project: Pick<Project, "id" | "name">, f: ProjectFolder): MenuItems {
  const ok = f.status === "ok";
  return [
    ok && { label: "Open in file manager", icon: FolderOpen, onSelect: () => void api.folders.reveal(project.id, "").catch(() => void api.system.open(f.path)) },
    { label: "Copy path", icon: ClipboardCopy, onSelect: () => void copyText(f.path) },
    { type: "separator" },
    ok && f.trust === "restricted" && { label: "Trust folder…", icon: ShieldCheck, onSelect: () => void setFolderTrust(project.id, "trusted", f) },
    ok && f.trust === "trusted" && { label: "Switch to restricted mode", icon: ShieldHalf, onSelect: () => void setFolderTrust(project.id, "restricted", f) },
    { label: ok ? "Change folder…" : "Relink folder…", icon: FolderSync, onSelect: () => void linkFolder(project) },
    { type: "separator" },
    { label: "Remove link", icon: Unlink, onSelect: () => void unlinkFolder(project, f) },
  ];
}

/** Compact folder element for a project's overview. */
export function ProjectFolderCard({ project }: { project: Project }) {
  const { data: f, isLoading } = useProjectFolder(project.id, !!project.folderPath);
  if (!project.folderPath) return null;
  if (isLoading || !f) return <Skeleton height={44} />;
  const ok = f.status === "ok";
  return (
    <ContextMenu items={() => folderMenu(project, f)}>
      <div className="folder-card" data-status={f.status}>
        {ok ? <FolderOpen size={16} strokeWidth={1.75} /> : <FolderX size={16} strokeWidth={1.75} />}
        <div className="col grow" style={{ minWidth: 0 }}>
          <span className="truncate folder-card__name">{f.name}</span>
          <Tooltip content={f.path}>
            <span className="folder-card__path truncate">{ok ? shortPath(f.path, 64) : "Folder unavailable — it may have been moved or deleted."}</span>
          </Tooltip>
        </div>
        {ok ? <TrustBadge trust={f.trust} /> : null}
        {ok ? (
          <Button size="sm" onClick={() => void api.folders.open(project.id, "").catch((e) => toastError(describeError(e)))}>
            Open
          </Button>
        ) : (
          <Button size="sm" icon={FolderSearch} onClick={() => void linkFolder(project)}>
            Relink
          </Button>
        )}
        <Dropdown items={folderMenu(project, f)} align="end">
          <IconButton icon={Ellipsis} label="Folder actions" size="sm" noTooltip />
        </Dropdown>
      </div>
    </ContextMenu>
  );
}

// ------------------------------------------------------------ file browser

async function openEntry(projectId: string, e: FileEntry, folder: ProjectFolder, onEnter: (rel: string) => void) {
  if (e.isDir) return onEnter(e.rel);
  if (e.program) {
    if (!folder.capabilities.openPrograms) {
      toastError("Programs and scripts can't be opened in restricted mode. Trust the folder first.");
      return;
    }
    const ok = await confirm({
      title: `Run ${e.name}?`,
      message: "This opens a program or script, which can make changes to your computer. Only continue if you trust it.",
      confirmLabel: "Run",
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await api.folders.open(projectId, e.rel, e.program);
  } catch (err) {
    toastError(describeError(err, "Couldn't open that file."));
  }
}

const crumbs = (rel: string) => (rel ? rel.split("/") : []);
const BIN = isMac || !/Win/i.test(navigator.platform) ? "Trash" : "Recycle Bin";

type SortKey = "name" | "modified" | "size" | "type";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "modified", label: "Date modified" },
  { key: "size", label: "Size" },
  { key: "type", label: "Type" },
];
const extOf = (n: string) => (n.lastIndexOf(".") > 0 ? n.slice(n.lastIndexOf(".") + 1).toLowerCase() : "");
const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function sortEntries(list: FileEntry[], key: SortKey, desc: boolean, dirsFirst: boolean): FileEntry[] {
  const cmp = (a: FileEntry, b: FileEntry): number => {
    if (key === "modified") return (a.modified ?? 0) - (b.modified ?? 0) || byName(a, b);
    if (key === "size") return (a.size ?? -1) - (b.size ?? -1) || byName(a, b);
    if (key === "type") return extOf(a.name).localeCompare(extOf(b.name)) || byName(a, b);
    return byName(a, b);
  };
  return [...list].sort((a, b) => (dirsFirst && a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : desc ? -cmp(a, b) : cmp(a, b)));
}

async function newItem(projectId: string, parentRel: string, kind: "file" | "folder") {
  const name = await prompt({ title: kind === "file" ? "New file" : "New folder", placeholder: kind === "file" ? "notes.md" : "Folder name", confirmLabel: "Create" });
  if (!name) return;
  try {
    await (kind === "file" ? api.folders.createFile(projectId, parentRel, name) : api.folders.createFolder(projectId, parentRel, name));
    invalidate("files");
  } catch (err) {
    toastError(describeError(err, `Couldn't create the ${kind}.`));
  }
}

async function renameEntry(projectId: string, e: FileEntry) {
  const name = await prompt({ title: "Rename", initial: e.name, confirmLabel: "Rename" });
  if (!name || name === e.name) return;
  try {
    await api.folders.rename(projectId, e.rel, name);
    invalidate("files");
  } catch (err) {
    toastError(describeError(err, "Couldn't rename."));
  }
}

async function trashEntry(projectId: string, e: FileEntry) {
  const ok = await confirmDelete(
    `Delete “${e.name}”?`,
    `${e.isDir ? "The folder and everything in it move" : e.isLink ? "The link moves (what it points to is untouched)" : "The file moves"} to the ${BIN}, where you can restore ${e.isDir ? "them" : "it"}.`,
  );
  if (!ok) return;
  try {
    await api.folders.trash(projectId, e.rel);
    invalidate("files");
    toast(`Moved ${e.name} to the ${BIN}`);
  } catch (err) {
    toastError(describeError(err, "Couldn't delete that."));
  }
}

/** A browser for a linked folder: navigate, filter, sort, open, and (when trusted) create, rename, duplicate and delete. */
export function FolderBrowser({ project }: { project: Project }) {
  const { data: folder, isLoading: folderLoading } = useProjectFolder(project.id, !!project.folderPath);
  const [rel, setRel] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [viewing, setViewing] = useState<FileEntry | null>(null);
  // Remember the open file so the workspace can reopen it.
  const viewed = useRef(false);
  useEffect(() => {
    if (!viewing && !viewed.current) return;
    viewed.current = true;
    recordWorkspace(project.id, { openFile: viewing ? { rel: viewing.rel } : null });
  }, [project.id, viewing?.rel]);
  const [hover, setHover] = useState<{ entry: FileEntry; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean; dirsFirst: boolean }>({ key: "name", desc: false, dirsFirst: true });
  const ok = folder?.status === "ok";
  const { data: listing, error, isFetching, refetch } = useQuery({
    queryKey: ["files", project.id, rel],
    queryFn: () => api.folders.list(project.id, rel),
    enabled: ok,
    retry: false,
    staleTime: 10_000,
  });
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = (listing?.entries ?? []).filter((e) => (showHidden || !e.hidden) && (!q || e.name.toLowerCase().includes(q)));
    return sortEntries(shown, sort.key, sort.desc, sort.dirsFirst);
  }, [listing, showHidden, query, sort]);
  const go = (to: string) => {
    setRel(to);
    setQuery("");
  };

  if (folderLoading || !folder) return <Skeleton height={60} />;
  if (!ok)
    return (
      <EmptyState icon={FolderX} title="The linked folder isn't available" action={<Button icon={FolderSearch} onClick={() => void linkFolder(project)}>Relink folder</Button>}>
        {folder.path} may have been moved, renamed or deleted. The project and its tasks are unaffected.
      </EmptyState>
    );

  const parts = crumbs(rel);
  const modify = folder.capabilities.modify;
  const openExternal = (e: FileEntry) => void openEntry(project.id, e, folder, go);
  /** Click / Enter: folders open, text and images show in Kern, anything else opens in its app. */
  const activate = (e: FileEntry) => {
    setHover(null);
    if (e.isDir) go(e.rel);
    else if (viewableInApp(e)) setViewing(e);
    else openExternal(e);
  };
  const entryMenu = (e: FileEntry): MenuItems => [
    !e.isDir && viewableInApp(e) && { label: isImage(e) ? "View image" : folder.capabilities.modify ? "View & edit" : "View", icon: Eye, onSelect: () => setViewing(e) },
    { label: e.isDir ? "Open folder" : e.program ? "Run…" : "Open in default app", icon: e.isDir ? FolderOpen : ExternalLink, disabled: e.program && !folder.capabilities.openPrograms, onSelect: () => (e.isDir ? go(e.rel) : openExternal(e)) },
    { label: "Show in file manager", icon: FolderSearch, onSelect: () => void api.folders.reveal(project.id, e.rel).catch((err) => toastError(describeError(err))) },
    { type: "separator" },
    { label: "Copy path", icon: ClipboardCopy, onSelect: () => void api.folders.path(project.id, e.rel).then((p) => copyText(p)).catch((err) => toastError(describeError(err))) },
    { label: "Copy relative path", onSelect: () => void copyText(e.rel, "Relative path") },
    { label: "Copy name", onSelect: () => void copyText(e.name, "Name") },
    modify && { type: "separator" },
    modify && e.isDir && { label: "New file here…", icon: FilePlus, onSelect: () => void newItem(project.id, e.rel, "file") },
    modify && e.isDir && { label: "New folder here…", icon: FolderPlus, onSelect: () => void newItem(project.id, e.rel, "folder") },
    modify && { label: "Rename…", icon: Pencil, shortcut: "F2", onSelect: () => void renameEntry(project.id, e) },
    modify &&
      !e.isDir && {
        label: "Duplicate",
        icon: Copy,
        onSelect: () =>
          void api.folders
            .duplicate(project.id, e.rel)
            .then(() => invalidate("files"))
            .catch((err) => toastError(describeError(err, "Couldn't duplicate."))),
      },
    modify && { type: "separator" },
    modify && { label: `Delete…`, icon: Trash2, danger: true, shortcut: "Delete", onSelect: () => void trashEntry(project.id, e) },
  ];
  const sortMenu: MenuItems = [
    ...SORTS.map((s) => ({ label: s.label, checked: sort.key === s.key, onSelect: () => setSort((v) => ({ ...v, key: s.key })) })),
    { type: "separator" as const },
    { label: "Ascending", checked: !sort.desc, onSelect: () => setSort((v) => ({ ...v, desc: false })) },
    { label: "Descending", checked: sort.desc, onSelect: () => setSort((v) => ({ ...v, desc: true })) },
    { type: "separator" as const },
    { label: "Folders first", checked: sort.dirsFirst, onSelect: () => setSort((v) => ({ ...v, dirsFirst: !v.dirsFirst })) },
    { label: "Show hidden files", checked: showHidden, onSelect: () => setShowHidden((v) => !v) },
  ];

  return (
    <div className="file-browser">
      <SyntaxPrompt project={project} />
      <FileViewer projectId={project.id} folder={folder} entry={viewing} onClose={() => setViewing(null)} onOpenExternal={openExternal} />
      {hover && <ImageHoverCard projectId={project.id} entry={hover.entry} anchor={hover.rect} />}
      <div className="file-browser__bar">
        <IconButton icon={ArrowLeft} label="Back" size="sm" disabled={!rel} onClick={() => go(parts.slice(0, -1).join("/"))} />
        <nav className="file-browser__crumbs" aria-label="Folder path">
          <button type="button" onClick={() => go("")} data-current={!rel || undefined}>
            {folder.name}
          </button>
          {parts.map((p, i) => (
            <span key={i} className="row" style={{ gap: 2 }}>
              <span className="faint">/</span>
              <button type="button" onClick={() => go(parts.slice(0, i + 1).join("/"))} data-current={i === parts.length - 1 || undefined}>
                {p}
              </button>
            </span>
          ))}
        </nav>
        <span className="spacer" />
        <TrustBadge trust={folder.trust} />
        <label className="file-browser__filter">
          <Search size={13} aria-hidden />
          <input value={query} onChange={(ev) => setQuery(ev.target.value)} onKeyDown={(ev) => ev.key === "Escape" && setQuery("")} placeholder="Filter" aria-label="Filter this folder" spellCheck={false} />
        </label>
        <Tooltip content="Show hidden files">
          <label className="row" style={{ gap: 6, fontSize: "var(--fs-xs)", color: "var(--text-3)" }}>
            <Switch checked={showHidden} onChange={setShowHidden} label="Show hidden files" />
            Hidden
          </label>
        </Tooltip>
        <Dropdown items={sortMenu} align="end">
          <IconButton icon={ArrowUpDown} label="Sort" size="sm" />
        </Dropdown>
        {modify && <IconButton icon={FilePlus} label="New file" size="sm" onClick={() => void newItem(project.id, rel, "file")} />}
        {modify && <IconButton icon={FolderPlus} label="New folder" size="sm" onClick={() => void newItem(project.id, rel, "folder")} />}
        <IconButton icon={RefreshCw} label="Refresh" size="sm" onClick={() => void refetch()} className={isFetching ? "spin" : undefined} />
        <IconButton icon={FolderOpen} label="Open in file manager" size="sm" onClick={() => void api.folders.reveal(project.id, rel).catch((err) => toastError(describeError(err)))} />
      </div>
      {folder.trust === "restricted" && (
        <div className="file-browser__note">
          <ShieldHalf size={13} />
          Restricted mode: you can browse and open documents. Programs and scripts won't run, and files can't be changed from Kern.
          <button type="button" className="link-btn" onClick={() => void setFolderTrust(project.id, "trusted", folder)}>
            Trust folder…
          </button>
        </div>
      )}
      {error ? (
        <EmptyState compact icon={FolderX}>
          {describeError(error, "Couldn't read this folder.")}
        </EmptyState>
      ) : !listing ? (
        <Skeleton height={120} />
      ) : (
        <div className="file-list" role="list" onWheel={() => hover && setHover(null)}>
          {rel && (
            <button type="button" className="file-row file-row--up" onClick={() => go(parts.slice(0, -1).join("/"))}>
              <CornerLeftUp size={15} strokeWidth={1.75} className="file-icon" />
              <span className="grow">..</span>
            </button>
          )}
          {entries.map((e) => (
            <ContextMenu key={e.rel} items={() => entryMenu(e)}>
              <div
                className="file-row"
                role="listitem"
                tabIndex={0}
                data-dir={e.isDir || undefined}
                data-hidden={e.hidden || undefined}
                onClick={() => activate(e)}
                onMouseEnter={(ev) => {
                  if (!canHoverPreview(e)) return;
                  const rect = ev.currentTarget.getBoundingClientRect();
                  window.clearTimeout(hoverTimer.current);
                  hoverTimer.current = window.setTimeout(() => setHover({ entry: e, rect }), 350);
                }}
                onMouseLeave={() => {
                  window.clearTimeout(hoverTimer.current);
                  setHover(null);
                }}
                onKeyDown={(k) => {
                  if (k.key === "Enter") activate(e);
                  else if (modify && k.key === "F2") void renameEntry(project.id, e);
                  else if (modify && k.key === "Delete") void trashEntry(project.id, e);
                  else return;
                  k.preventDefault();
                }}
              >
                <FileTypeIcon entry={e} />
                <span className="truncate grow">{e.name}</span>
                {e.sensitive && (
                  <Tooltip content="May contain secrets. Never offered to AI features.">
                    <span className="chip">Sensitive</span>
                  </Tooltip>
                )}
                {e.program && (
                  <Tooltip content={folder.capabilities.openPrograms ? "Program or script — opening asks first" : "Program or script — disabled in restricted mode"}>
                    <span className="chip">Program</span>
                  </Tooltip>
                )}
                <span className="faint file-row__date">{e.modified ? relativeTime(e.modified) : ""}</span>
                <span className="faint tabular file-row__size">{e.size !== null ? formatBytes(e.size) : ""}</span>
                <span className="file-row__actions" onClick={(ev) => ev.stopPropagation()}>
                  <Dropdown items={() => entryMenu(e)} align="end">
                    <IconButton icon={Ellipsis} label="File actions" size="sm" noTooltip />
                  </Dropdown>
                </span>
              </div>
            </ContextMenu>
          ))}
          {!entries.length && <div className="empty empty--compact">{query.trim() ? `Nothing here matches “${query.trim()}”.` : "This folder is empty."}</div>}
          {listing.truncated && <div className="faint" style={{ padding: 8, fontSize: "var(--fs-xs)" }}>Showing the first 5,000 items.</div>}
        </div>
      )}
    </div>
  );
}
