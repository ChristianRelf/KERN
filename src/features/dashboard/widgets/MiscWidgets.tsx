import { Bookmark, FileText, FolderKanban, History, Pencil, Plus, Presentation, Trash } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WidgetProps } from "../types";
import { useRecent } from "@/hooks/data";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { navigate } from "@/stores/router";
import { relativeTime } from "@/lib/dates";
import { EmptyState, Segmented } from "@/components/ui/Controls";
import { Button } from "@/components/ui/Button";
import { ContextMenu } from "@/components/ui/Menu";
import { prompt } from "@/components/ui/Dialog";
import { getSetting, useSetting } from "@/stores/settings";
import { createTask } from "@/features/tasks/actions";
import { parseQuickTask } from "@/features/tasks/parse";
import { inputFromParsed } from "@/features/tasks/QuickAdd";
import { useProjects } from "@/hooks/data";

// ------------------------------------------------------------- Quick capture

export type CaptureConfig = { saveAs: "task" | "idea" };

export function CaptureWidget({ config }: WidgetProps<CaptureConfig>) {
  const [text, setText] = useState("");
  const { data: projects } = useProjects();
  const save = async () => {
    const v = text.trim();
    if (!v) return;
    setText("");
    try {
      if (config.saveAs === "task") {
        const input = await inputFromParsed(parseQuickTask(v, { projects: projects ?? [] }), { status: "inbox" });
        if (!input.title) input.title = v;
        await createTask(input, { quiet: true });
        toast(input.projectId ? "Task added" : "Added to Inbox");
      } else {
        await api.inbox.add(v);
        invalidate("inbox", "stats");
        toast("Captured to Inbox");
      }
    } catch (e) {
      setText(v);
      toastError(describeError(e, "Couldn't capture that."));
    }
  };
  return (
    <div className="col" style={{ gap: 6, height: "100%" }}>
      <textarea
        className="textarea"
        style={{ flex: 1, minHeight: 40, resize: "none" }}
        placeholder={config.saveAs === "task" ? "Type a task and press Enter" : "Type a thought and press Enter"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
        aria-label="Quick capture"
      />
    </div>
  );
}

export function CaptureConfigForm({ config, setConfig }: { config: CaptureConfig; setConfig: (p: Partial<CaptureConfig>) => void }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)", gap: 12 }}>
      <span className="muted">Save as</span>
      <Segmented
        size="sm"
        value={config.saveAs}
        onChange={(saveAs) => setConfig({ saveAs })}
        options={[
          { value: "task", label: "Inbox task" },
          { value: "idea", label: "Idea" },
        ]}
      />
    </div>
  );
}

// ------------------------------------------------------------- Sticky note

export type StickyConfig = { title: string; text: string };

export function StickyWidget({ config, setConfig }: WidgetProps<StickyConfig>) {
  const [text, setText] = useState(config.text);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(text);
  latest.current = text;
  useEffect(() => {
    if (document.activeElement?.getAttribute("data-sticky") !== "1") setText(config.text);
  }, [config.text]);
  // Flush pending text on unmount so nothing typed is lost.
  useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        setConfig({ text: latest.current });
      }
    },
    [],
  );
  return (
    <textarea
      className="sticky-area"
      data-sticky="1"
      placeholder="Jot something down…"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        window.clearTimeout(timer.current);
        const v = e.target.value;
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          setConfig({ text: v });
        }, 500);
      }}
      onBlur={() => {
        if (timer.current) {
          window.clearTimeout(timer.current);
          timer.current = undefined;
          setConfig({ text: latest.current });
        }
      }}
      aria-label="Sticky note"
    />
  );
}

// ------------------------------------------------------------- Bookmarks

export interface BookmarkItem {
  id: string;
  title: string;
  url: string;
}
export type BookmarksConfig = { items: BookmarkItem[] };

function hostOf(url: string) {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host;
  } catch {
    return "";
  }
}

function Favicon({ url }: { url: string }) {
  const previews = useSetting("data.linkPreviews");
  const [failed, setFailed] = useState(false);
  const host = hostOf(url);
  const letter = (host.replace(/^www\./, "")[0] ?? "?").toUpperCase();
  return (
    <span className="favicon">
      {previews && host && !failed && navigator.onLine ? (
        <img src={`https://${host}/favicon.ico`} alt="" onError={() => setFailed(true)} loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        letter
      )}
    </span>
  );
}

export function BookmarksWidget({ config, setConfig }: WidgetProps<BookmarksConfig>) {
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const items = config.items ?? [];
  const add = async () => {
    const u = url.trim();
    if (!u) return;
    const full = /^[a-z]+:/i.test(u) ? u : `https://${u}`;
    let title = hostOf(full).replace(/^www\./, "") || u;
    setUrl("");
    setAdding(false);
    const id = crypto.randomUUID();
    setConfig({ items: [...items, { id, title, url: full }] });
    if (getSetting("data.linkPreviews")) {
      try {
        const meta = await api.system.linkMetadata(full);
        if (meta.title) {
          title = meta.title.slice(0, 80);
          setConfig({ items: [...items, { id, title, url: full }] });
        }
      } catch {
        /* offline or blocked: keep the host name */
      }
    }
  };
  return (
    <div className="col">
      {items.map((b) => (
        <ContextMenu
          key={b.id}
          items={() => [
            {
              label: "Rename",
              icon: Pencil,
              onSelect: async () => {
                const t = await prompt({ title: "Rename bookmark", initial: b.title });
                if (t) setConfig({ items: items.map((x) => (x.id === b.id ? { ...x, title: t } : x)) });
              },
            },
            {
              label: "Edit link",
              onSelect: async () => {
                const u = await prompt({ title: "Edit link", initial: b.url });
                if (u) setConfig({ items: items.map((x) => (x.id === b.id ? { ...x, url: u } : x)) });
              },
            },
            { type: "separator" },
            { label: "Remove", icon: Trash, danger: true, onSelect: () => setConfig({ items: items.filter((x) => x.id !== b.id) }) },
          ]}
        >
          <a
            className="bookmark"
            href={b.url}
            onClick={(e) => {
              e.preventDefault();
              void api.system.open(b.url).catch((err) => toastError(describeError(err, "Couldn't open the link.")));
            }}
            title={b.url}
          >
            <Favicon url={b.url} />
            <span className="truncate grow">{b.title}</span>
            <span className="faint truncate" style={{ fontSize: "var(--fs-xs)", maxWidth: "40%" }}>
              {hostOf(b.url)}
            </span>
          </a>
        </ContextMenu>
      ))}
      {!items.length && !adding && (
        <EmptyState compact icon={Bookmark}>
          Keep your frequent links here.
        </EmptyState>
      )}
      {adding ? (
        <input
          className="input"
          autoFocus
          placeholder="Paste a link and press Enter"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => !url.trim() && setAdding(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
            if (e.key === "Escape") setAdding(false);
          }}
          style={{ marginTop: 6 }}
        />
      ) : (
        <Button variant="ghost" size="sm" icon={Plus} onClick={() => setAdding(true)} style={{ alignSelf: "flex-start", marginTop: 4 }}>
          Add link
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------- Recently opened

export type RecentConfig = { max: number };

export function RecentWidget({ config }: WidgetProps<RecentConfig>) {
  const { data } = useRecent(config.max);
  if (!data?.length)
    return (
      <EmptyState compact icon={History}>
        Projects, notes and whiteboards you open appear here.
      </EmptyState>
    );
  return (
    <div className="col">
      {data.map((r) => {
        const Icon = r.entityType === "project" ? FolderKanban : r.entityType === "note" ? FileText : Presentation;
        return (
          <button
            key={`${r.entityType}:${r.entityId}`}
            type="button"
            className="mini-task"
            style={{ textAlign: "left" }}
            onClick={() =>
              r.entityType === "project"
                ? navigate({ name: "project", id: r.entityId })
                : r.entityType === "note"
                  ? navigate({ name: "notes", id: r.entityId })
                  : navigate({ name: "whiteboard", id: r.entityId })
            }
          >
            <Icon size={14} className="faint" />
            <span className="mini-task__title">{r.title}</span>
            <span className="mini-task__meta">{relativeTime(r.openedAt)}</span>
          </button>
        );
      })}
    </div>
  );
}
