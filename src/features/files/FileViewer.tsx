/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// In-app file viewing for the project file browser: text files open in a
// small editor (saving needs a trusted folder), images in a lightbox, and
// image rows show a low-resolution preview on hover.

import { ExternalLink, FolderSearch, Maximize2, Minimize2, RotateCcw, Save } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { FileEntry, FileText, ProjectFolder } from "@/lib/types";
import { api, describeError, KernError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { Button } from "@/components/ui/Button";
import { Dialog, confirm } from "@/components/ui/Dialog";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { toast, toastError } from "@/stores/toast";
import { formatBytes } from "@/lib/dates";
import { FileTypeIcon } from "@/features/projects/fileIcons";
import { installSyntaxes, syntaxForFile, useInstalledGrammars } from "@/features/plugins/syntax";
import { SyntaxIcon } from "@/features/plugins/SyntaxIcon";
import { CodeEditor } from "./CodeEditor";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "avif", "bmp", "ico", "svg"]);
/** Opened with the default app rather than read as text. */
const BINARY_EXTS = new Set(
  "exe dll so dylib msi msix appx com scr sys bin dat iso dmg pkg deb rpm apk zip 7z rar tar gz tgz bz2 xz zst jar war class pyc o obj a lib pdb wasm pdf doc docx xls xlsx ppt pptx odt ods odp pages numbers key mp3 wav flac ogg opus m4a aac mp4 mov mkv webm avi wmv ttf otf woff woff2 eot psd ai sketch fig blend fbx glb gltf stl sqlite sqlite3 db lockb heic tif tiff raw cr2 nef".split(" "),
);
const PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

const extOf = (name: string) => (name.lastIndexOf(".") > 0 ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
export const isImage = (e: Pick<FileEntry, "name" | "isDir">) => !e.isDir && IMAGE_EXTS.has(extOf(e.name));
/** Whether clicking the file opens it inside Kern. */
export const viewableInApp = (e: FileEntry) => !e.isDir && (isImage(e) || !BINARY_EXTS.has(extOf(e.name)));

// ------------------------------------------------------------ images

function useImage(projectId: string, e: FileEntry, enabled = true, repositoryId: string | null = null) {
  return useQuery({
    queryKey: ["files", "image", projectId, repositoryId, e.rel, e.modified],
    queryFn: () => api.folders.image(projectId, e.rel, repositoryId),
    enabled,
    staleTime: Infinity,
    gcTime: 2 * 60_000,
    retry: false,
  });
}

/** Scales an image down to fit `max` pixels, for a light hover preview. */
function downscale(src: string, max: number): Promise<{ url: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth || max;
      const h = img.naturalHeight || max;
      const k = Math.min(1, max / Math.max(w, h));
      try {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
        resolve({ url: c.toDataURL("image/webp", 0.8), w, h });
      } catch {
        resolve({ url: src, w, h });
      }
    };
    img.onerror = () => reject(new Error("unreadable"));
    img.src = src;
  });
}

function useThumbnail(projectId: string, e: FileEntry) {
  return useQuery({
    queryKey: ["files", "thumb", projectId, e.rel, e.modified],
    queryFn: async () => downscale(await api.folders.image(projectId, e.rel), 280),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: false,
  });
}

/** Floating low-resolution preview shown while hovering an image row. */
export function ImageHoverCard({ projectId, entry, anchor }: { projectId: string; entry: FileEntry; anchor: DOMRect }) {
  const { data, isError } = useThumbnail(projectId, entry);
  const W = 300;
  const below = anchor.bottom + 220 < window.innerHeight;
  const style: CSSProperties = {
    left: Math.max(8, Math.min(anchor.left + 220, window.innerWidth - W - 8)),
    ...(below ? { top: anchor.bottom + 4 } : { bottom: window.innerHeight - anchor.top + 4 }),
  };
  return createPortal(
    <div className="image-hover" style={style} role="tooltip">
      {data ? <img src={data.url} alt="" /> : isError ? <span className="faint">No preview</span> : <Skeleton width={200} height={130} />}
      {data && (
        <span className="image-hover__meta">
          {data.w} × {data.h}
          {entry.size !== null && ` · ${formatBytes(entry.size)}`}
        </span>
      )}
    </div>,
    document.body,
  );
}

export const canHoverPreview = (e: FileEntry) => isImage(e) && (e.size ?? 0) <= PREVIEW_MAX_BYTES;

function ImageViewer({ projectId, entry, repositoryId }: { projectId: string; entry: FileEntry; repositoryId: string | null }) {
  const { data, error } = useImage(projectId, entry, true, repositoryId);
  const [actual, setActual] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  if (error) return <EmptyState compact>{describeError(error, "Couldn't load the image.")}</EmptyState>;
  if (!data) return <Skeleton height={360} />;
  return (
    <div className="image-viewer" data-actual={actual || undefined}>
      <div className="image-viewer__stage">
        <img
          src={data}
          alt={entry.name}
          onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onClick={() => setActual(!actual)}
          title={actual ? "Click to fit" : "Click for actual size"}
        />
      </div>
      {dims && (
        <span className="image-viewer__meta">
          {dims.w} × {dims.h}
          {entry.size !== null && ` · ${formatBytes(entry.size)}`}
          <button type="button" className="link-btn" onClick={() => setActual(!actual)}>
            {actual ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            {actual ? "Fit" : "Actual size"}
          </button>
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------ text

function TextViewer({ projectId, entry, onDirty, onOpenExternal, repositoryId }: { projectId: string; entry: FileEntry; onDirty: (d: boolean) => void; onOpenExternal: () => void; repositoryId: string | null }) {
  const { data, error, refetch } = useQuery({
    queryKey: ["files", "text", projectId, repositoryId, entry.rel],
    queryFn: () => api.folders.read(projectId, entry.rel, repositoryId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const [file, setFile] = useState<FileText | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const { data: installed = [] } = useInstalledGrammars();
  const syntax = syntaxForFile(entry.name);
  const hasSyntax = !!syntax && installed.includes(syntax.id);

  useEffect(() => {
    if (data) {
      setFile(data);
      setDraft(data.text);
    }
  }, [data]);

  const dirty = !!file && draft !== file.text;
  useEffect(() => onDirty(dirty), [dirty]);

  const save = async () => {
    if (!file || !dirty || file.readOnly || saving) return;
    setSaving(true);
    try {
      const modified = await api.folders.write(projectId, entry.rel, { ...file, text: draft }, repositoryId);
      setFile({ ...file, text: draft, modified });
      invalidate("files");
      toast(`Saved ${entry.name}`);
    } catch (e) {
      const changed = e instanceof KernError && e.message.includes("changed on disk");
      toastError(describeError(e, "Couldn't save the file."), changed ? undefined : () => void save());
    } finally {
      setSaving(false);
    }
  };

  if (error)
    return (
      <EmptyState compact action={<Button icon={ExternalLink} onClick={onOpenExternal}>Open in default app</Button>}>
        {describeError(error, "Couldn't read this file.")}
      </EmptyState>
    );
  if (!file) return <Skeleton height={360} />;

  return (
    <div className="text-viewer">
      <CodeEditor value={draft} onChange={setDraft} lang={hasSyntax ? syntax!.id : null} installed={installed} readOnly={file.readOnly} onSave={() => void save()} ariaLabel={`Contents of ${entry.name}`} />
      <div className="text-viewer__bar">
        {syntax && <SyntaxIcon id={syntax.id} size={13} />}
        <span className="faint">
          {syntax ? syntax.name : "Plain text"}
          {" · "}
          {draft.split("\n").length.toLocaleString()} lines{file.crlf ? " · CRLF" : ""}
          {file.readOnly && " · Read-only (trust the folder to edit)"}
        </span>
        {syntax && !hasSyntax && (
          <button type="button" className="link-btn" onClick={() => void installSyntaxes([syntax])}>
            Install {syntax.name} syntax
          </button>
        )}
        <span className="spacer" />
        {dirty && <span className="text-viewer__dirty">Unsaved changes</span>}
        {!file.readOnly && (
          <>
            <Button
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              disabled={!dirty || saving}
              onClick={async () => {
                if (await confirm({ title: "Revert your changes?", message: "Your edits since the last save are discarded.", confirmLabel: "Revert", danger: true })) {
                  setDraft(file.text);
                  void refetch();
                }
              }}
            >
              Revert
            </Button>
            <Button size="sm" variant="primary" icon={Save} disabled={!dirty || saving} onClick={() => void save()} title="Save (Ctrl+S)">
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ dialog

export function FileViewer({
  projectId,
  repositoryId = null,
  folder,
  entry,
  onClose,
  onOpenExternal,
}: {
  projectId: string;
  /** Show a file from one of the project's repositories instead of its folder. */
  repositoryId?: string | null;
  folder: ProjectFolder;
  entry: FileEntry | null;
  onClose: () => void;
  /** Opens the file with its default app (programs ask first). */
  onOpenExternal: (e: FileEntry) => void;
}) {
  const [dirty, setDirty] = useState(false);
  useEffect(() => setDirty(false), [entry?.rel]);

  const requestClose = async () => {
    if (dirty && !(await confirm({ title: "Discard unsaved changes?", message: `Your edits to ${entry?.name} haven't been saved.`, confirmLabel: "Discard", danger: true }))) return;
    onClose();
  };

  return (
    <Dialog
      open={!!entry}
      onOpenChange={(o) => !o && void requestClose()}
      className="file-viewer"
      title={
        entry && (
          <span className="row" style={{ gap: 8, minWidth: 0 }}>
            <FileTypeIcon entry={entry} />
            <span className="truncate">{entry.name}</span>
            <span className="faint truncate file-viewer__path">
              {folder.name}/{entry.rel}
            </span>
            {dirty && <span className="text-viewer__dot" aria-label="Unsaved changes" />}
          </span>
        )
      }
    >
      {entry && (
        <>
          <div className="file-viewer__actions">
            <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => onOpenExternal(entry)} disabled={entry.program && !folder.capabilities.openPrograms}>
              Open in default app
            </Button>
            <Button size="sm" variant="ghost" icon={FolderSearch} onClick={() => void api.folders.reveal(projectId, entry.rel, repositoryId).catch((e) => toastError(describeError(e)))}>
              Show in file manager
            </Button>
          </div>
          {isImage(entry) ? <ImageViewer projectId={projectId} entry={entry} repositoryId={repositoryId} /> : <TextViewer key={entry.rel} projectId={projectId} entry={entry} onDirty={setDirty} onOpenExternal={() => onOpenExternal(entry)} repositoryId={repositoryId} />}
        </>
      )}
    </Dialog>
  );
}
