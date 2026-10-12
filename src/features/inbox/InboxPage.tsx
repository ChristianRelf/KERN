import { ExternalLink, FolderInput, Inbox, Lightbulb, NotebookPen, Pencil, SquareCheckBig, Trash } from "lucide-react";
import type { InboxItem } from "@/lib/types";
import { useInbox, useTasks } from "@/hooks/data";
import { api, describeError } from "@/lib/ipc";
import { Favicon, displayUrl } from "@/features/links/links";
import { invalidate, invalidateTasks } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { pushUndo } from "@/stores/undo";
import { navigate } from "@/stores/router";
import { relativeTime } from "@/lib/dates";
import { TaskList } from "@/features/tasks/TaskList";
import { IconButton } from "@/components/ui/Button";
import { ContextMenu } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/Controls";
import { ProjectPicker } from "@/features/tasks/pickers";
import { prompt } from "@/components/ui/Dialog";
import { useUi } from "@/stores/ui";

const refresh = () => {
  invalidate("inbox", "stats", "notes");
  invalidateTasks();
};

async function convert(item: InboxItem, to: "task" | "note", projectId?: string | null) {
  try {
    const r = await api.inbox.convert(item.id, to, projectId);
    refresh();
    pushUndo(to === "task" ? "Converted to task" : "Converted to note", async () => {
      if (r.kind === "task") await api.tasks.purge([r.id]);
      else await api.notes.delete([r.id]);
      await api.inbox.restore(item);
      refresh();
    });
    if (to === "note") toast("Saved as note", { action: { label: "Open", run: () => navigate({ name: "notes", id: r.id }) } });
  } catch (e) {
    toastError(describeError(e));
  }
}

async function remove(item: InboxItem) {
  try {
    await api.inbox.delete(item.id);
    refresh();
    pushUndo("Deleted", async () => {
      await api.inbox.restore(item);
      refresh();
    });
  } catch (e) {
    toastError(describeError(e));
  }
}

function IdeaRow({ item }: { item: InboxItem }) {
  const Icon = Lightbulb;
  const menu = () => [
    { label: "Convert to task", icon: SquareCheckBig, onSelect: () => void convert(item, "task") },
    { label: "Convert to note", icon: NotebookPen, onSelect: () => void convert(item, "note") },
    item.kind === "link" && { label: "Open link", icon: ExternalLink, onSelect: () => void api.system.open(item.content) },
    {
      label: "Edit",
      icon: Pencil,
      onSelect: async () => {
        const v = await prompt({ title: "Edit", initial: item.content });
        if (v) {
          await api.inbox.update(item.id, v);
          invalidate("inbox");
        }
      },
    },
    { type: "separator" as const },
    { label: "Delete", icon: Trash, danger: true, onSelect: () => void remove(item) },
  ];
  return (
    <ContextMenu items={menu}>
      <div className="inbox-item">
        {item.kind === "link" ? <Favicon url={item.content} size={16} style={{ marginTop: 2 }} /> : <Icon strokeWidth={1.75} />}
        <div className="col grow" style={{ gap: 2 }}>
          {item.kind === "link" ? (
            <a
              href={item.content}
              className="inbox-item__content"
              onClick={(e) => {
                e.preventDefault();
                void api.system.open(item.content).catch((err) => toastError(describeError(err)));
              }}
              title={item.content}
            >
              {displayUrl(item.content, 90)}
            </a>
          ) : (
            <span className="inbox-item__content selectable">{item.content}</span>
          )}
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {relativeTime(item.createdAt)}
          </span>
        </div>
        <div className="inbox-item__actions">
          <IconButton icon={SquareCheckBig} label="Convert to task" size="sm" onClick={() => void convert(item, "task")} />
          <ProjectPicker
            value={null}
            allowNone={false}
            onChange={(pid) => void convert(item, "task", pid)}
            trigger={<IconButton icon={FolderInput} label="Move to project as task" size="sm" />}
          />
          <IconButton icon={NotebookPen} label="Convert to note" size="sm" onClick={() => void convert(item, "note")} />
          <IconButton icon={Trash} label="Delete" size="sm" onClick={() => void remove(item)} />
        </div>
      </div>
    </ContextMenu>
  );
}

export function InboxPage() {
  const { data: tasks } = useTasks({ statuses: ["inbox"], noProject: true, topLevelOnly: true, order: "manual" });
  const { data: items } = useInbox();
  const count = (tasks?.length ?? 0) + (items?.length ?? 0);
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <Inbox /> Inbox
        </h1>
        {count > 0 && <span className="page-header__sub">{count} to organise</span>}
        <div className="page-header__actions">
          <IconButton icon={Lightbulb} label="Capture an idea" onClick={() => useUi.getState().openCapture("idea")} />
        </div>
      </header>
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <TaskList
            sections={[{ key: "inbox", tasks: tasks ?? [], addDefaults: { status: "inbox" }, collapsible: false }]}
            sortable
            quickAddPosition="top"
            empty={
              <EmptyState icon={Inbox} title="Inbox zero">
                New tasks without a project land here. Give them a project or date to organise them.
              </EmptyState>
            }
          />
        </div>
        <aside style={{ width: 360, borderLeft: "1px solid var(--border-subtle)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div className="section-title" style={{ padding: "14px 16px 8px" }}>
            Ideas & links <span className="count">{items?.length ?? 0}</span>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 16px" }}>
            {items?.map((i) => <IdeaRow key={i.id} item={i} />)}
            {!items?.length && (
              <EmptyState compact icon={Lightbulb}>
                Captured thoughts and links wait here until you turn them into tasks or notes.
              </EmptyState>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
