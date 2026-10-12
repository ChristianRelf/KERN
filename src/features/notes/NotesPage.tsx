import {
  Archive,
  ArchiveRestore,
  Download,
  Ellipsis,
  FileText,
  FolderInput,
  NotebookPen,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Editor } from "@tiptap/react";
import type { NoteMeta } from "@/lib/types";
import { useNotes, useProjectMap, useProjects } from "@/hooks/data";
import { useQuery } from "@tanstack/react-query";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { navigate, onBeforeNavigate } from "@/stores/router";
import { pushUndo } from "@/stores/undo";
import { toast, toastError } from "@/stores/toast";
import { relativeTime } from "@/lib/dates";
import { Button, IconButton } from "@/components/ui/Button";
import { ContextMenu, Dropdown, type MenuItems } from "@/components/ui/Menu";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { createNote } from "@/features/search/commands";
import { NoteEditor, InsertMenu } from "./NoteEditor";

const refresh = () => invalidate("notes", "note", "recent", "search");

async function patchNote(id: string, patch: Parameters<typeof api.notes.update>[1]) {
  try {
    await api.notes.update(id, patch);
    refresh();
  } catch (e) {
    toastError(describeError(e), () => void patchNote(id, patch));
  }
}

async function deleteNote(n: NoteMeta, after?: () => void) {
  try {
    await api.notes.delete([n.id]);
    refresh();
    invalidate("trash");
    after?.();
    pushUndo("Note moved to trash", async () => {
      await api.notes.restore([n.id]);
      refresh();
      invalidate("trash");
    });
  } catch (e) {
    toastError(describeError(e));
  }
}

async function exportNote(id: string) {
  const n = await api.notes.get(id);
  const path = await saveDialog({ defaultPath: `${(n.title || "Untitled").replace(/[<>:"/\\|?*]/g, "_")}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (!path) return;
  const body = n.title && !n.content.trimStart().startsWith("# ") ? `# ${n.title}\n\n${n.content}` : n.content;
  await api.system.writeText(path, body);
  toast("Note exported");
}

function noteMenu(n: NoteMeta, projects: { id: string; name: string }[], onDeleted?: () => void): MenuItems {
  return [
    { label: n.pinned ? "Unpin" : "Pin", icon: n.pinned ? PinOff : Pin, onSelect: () => void patchNote(n.id, { pinned: !n.pinned }) },
    {
      type: "submenu",
      label: "Move to project",
      icon: FolderInput,
      items: [
        { label: "No project", checked: !n.projectId, onSelect: () => void patchNote(n.id, { projectId: null }) },
        ...(projects.length ? [{ type: "separator" as const }] : []),
        ...projects.map((p) => ({ label: p.name, checked: n.projectId === p.id, onSelect: () => void patchNote(n.id, { projectId: p.id }) })),
      ],
    },
    { label: "Export as Markdown…", icon: Download, onSelect: () => void exportNote(n.id).catch((e) => toastError(describeError(e))) },
    { label: n.archivedAt ? "Unarchive" : "Archive", icon: n.archivedAt ? ArchiveRestore : Archive, onSelect: () => void patchNote(n.id, { archived: !n.archivedAt }) },
    { type: "separator" },
    { label: "Move to trash", icon: Trash, danger: true, onSelect: () => void deleteNote(n, onDeleted) },
  ];
}

export default function NotesPage({ noteId, projectId, embedded }: { noteId?: string; projectId?: string; embedded?: boolean }) {
  const [showArchived, setShowArchived] = useState(false);
  const { data: notes, isLoading } = useNotes(projectId ?? null, showArchived);
  const { data: projects } = useProjects();
  const projectMap = useProjectMap();
  const [q, setQ] = useState("");
  const [localId, setLocalId] = useState<string | undefined>(undefined);
  const selectedId = embedded ? localId : noteId;

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (notes ?? []).filter((n) => !s || n.title.toLowerCase().includes(s) || n.excerpt.toLowerCase().includes(s));
  }, [notes, q]);

  const select = (id: string | undefined) => {
    if (embedded) setLocalId(id);
    else navigate({ name: "notes", id }, { replace: true });
  };

  // Open the most recent note when nothing is selected.
  useEffect(() => {
    if (!selectedId && filtered.length && !q) select(filtered[0].id);
  }, [selectedId, filtered.length]);

  const create = async () => {
    if (embedded) {
      const n = await api.notes.create({ projectId: projectId ?? null });
      refresh();
      setLocalId(n.id);
    } else await createNote(projectId);
  };

  return (
    <div className={embedded ? "notes" : "page"}>
      {!embedded && (
        <header className="page-header">
          <h1 className="page-header__title">
            <NotebookPen /> Notes
          </h1>
          <div className="page-header__actions">
            <IconButton icon={Plus} label="New note" shortcut="Mod+Alt+N" onClick={() => void create()} />
          </div>
        </header>
      )}
      <div className="notes">
        <div className="notes__list">
          <div className="row" style={{ padding: "10px 10px 6px", gap: 6 }}>
            <div className="input-wrap grow">
              <Search />
              <input className="input" style={{ height: "var(--control-h-sm)" }} placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
            </div>
            {embedded && <IconButton icon={Plus} label="New note" size="sm" onClick={() => void create()} />}
            <IconButton icon={Archive} label={showArchived ? "Hide archived" : "Show archived"} size="sm" active={showArchived} onClick={() => setShowArchived(!showArchived)} />
          </div>
          <div className="notes__list-items" role="listbox" aria-label="Notes">
            {isLoading && <Skeleton height={48} />}
            {filtered.map((n) => {
              const project = !projectId && n.projectId ? projectMap.get(n.projectId) : undefined;
              return (
                <ContextMenu key={n.id} items={() => noteMenu(n, projects ?? [], () => selectedId === n.id && select(undefined))}>
                  <button type="button" className="note-item" data-active={selectedId === n.id || undefined} onClick={() => select(n.id)} role="option" aria-selected={selectedId === n.id}>
                    <span className="note-item__title">
                      {n.pinned && <Pin size={11} className="faint" />}
                      <span className="truncate">{n.title || "Untitled"}</span>
                    </span>
                    {n.excerpt && <span className="note-item__excerpt">{n.excerpt}</span>}
                    <span className="note-item__meta">
                      {relativeTime(n.updatedAt)}
                      {project && (
                        <>
                          · <ProjectGlyph project={project} size={10} /> {project.name}
                        </>
                      )}
                      {n.archivedAt && " · Archived"}
                    </span>
                  </button>
                </ContextMenu>
              );
            })}
            {!isLoading && !filtered.length && (
              <EmptyState compact icon={FileText} action={!q && <Button size="sm" icon={Plus} onClick={() => void create()}>New note</Button>}>
                {q ? `No notes match “${q}”.` : "No notes yet."}
              </EmptyState>
            )}
          </div>
        </div>
        <div className="notes__editor">
          {selectedId ? (
            <NoteView key={selectedId} id={selectedId} onDeleted={() => select(undefined)} />
          ) : (
            <EmptyState icon={NotebookPen} title="No note selected" action={<Button icon={Plus} onClick={() => void create()}>New note</Button>} />
          )}
        </div>
      </div>
    </div>
  );
}

function NoteView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { data: note, isError } = useQuery({ queryKey: ["note", id], queryFn: () => api.notes.get(id), staleTime: Infinity });
  const { data: projects } = useProjects();
  const projectMap = useProjectMap();
  const [title, setTitle] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const pending = useRef<{ title?: string; content?: string }>({});
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = {};
    if (p.title === undefined && p.content === undefined) return;
    void api.notes
      .update(id, p)
      .then((n) => {
        queryClient.setQueryData(["note", id], n);
        invalidate("notes", "search");
      })
      .catch((e) => {
        // Keep the unsaved edit so the retry includes it.
        pending.current = { ...p, ...pending.current };
        toastError(describeError(e, "Couldn't save the note."), flush);
      });
  }, [id]);

  const queue = (p: { title?: string; content?: string }) => {
    pending.current = { ...pending.current, ...p };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 700);
  };

  useEffect(() => onBeforeNavigate(flush), [flush]);
  useEffect(() => {
    window.addEventListener("blur", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [flush]);

  if (isError) return <EmptyState icon={FileText} title="This note isn't available" />;
  if (!note) return <div className="page-loading" />;
  const project = note.projectId ? projectMap.get(note.projectId) : undefined;
  const meta: NoteMeta = { ...note, excerpt: "" };

  return (
    <>
      <div className="toolbar" style={{ minHeight: 40 }}>
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          {project ? (
            <button type="button" className="row" style={{ gap: 6, display: "inline-flex" }} onClick={() => navigate({ name: "project", id: project.id })}>
              <ProjectGlyph project={project} size={12} /> {project.name}
            </button>
          ) : (
            "No project"
          )}
          {" · "}Edited {relativeTime(note.updatedAt)}
        </span>
        <span className="spacer" />
        <InsertMenu editor={editor} />
        <IconButton icon={note.pinned ? PinOff : Pin} label={note.pinned ? "Unpin" : "Pin"} active={note.pinned} onClick={() => void patchNote(id, { pinned: !note.pinned }).then(() => invalidate("note"))} />
        <Dropdown items={() => noteMenu(meta, projects ?? [], onDeleted)} align="end">
          <IconButton icon={Ellipsis} label="Note actions" noTooltip />
        </Dropdown>
      </div>
      <div className="note-scroll" onClick={(e) => e.target === e.currentTarget && editor?.chain().focus("end").run()}>
        <div className="note-doc">
          <input
            className="note-title"
            placeholder="Untitled"
            value={title ?? note.title}
            onChange={(e) => {
              setTitle(e.target.value);
              queue({ title: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "ArrowDown") {
                e.preventDefault();
                editor?.chain().focus("start").run();
              }
            }}
            autoFocus={!note.title && !note.content}
            aria-label="Note title"
          />
          <NoteEditor initial={note.content} onChange={(md) => queue({ content: md })} onFlush={flush} onEditor={setEditor} />
        </div>
      </div>
    </>
  );
}
