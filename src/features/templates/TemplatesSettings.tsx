/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// Settings → Templates: your saved templates (rename, share as a file,
// delete), importing a template file, and the built-in ones.

import { Download, FileText, FolderKanban, ListChecks, Pencil, Plus, Trash, Upload } from "lucide-react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { TemplateMeta } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { confirmDelete, prompt } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Controls";
import type { GroupDef } from "@/features/settings/controls";
import { newProjectFromTemplate, openTemplatePicker } from "./open";
import { useTemplates } from "./data";

const ICON = { project: FolderKanban, note: FileText, task: ListChecks };

function use(t: TemplateMeta) {
  if (t.kind === "project") newProjectFromTemplate(t.id);
  else openTemplatePicker(t.kind);
}

function TemplateRow({ t }: { t: TemplateMeta }) {
  const Icon = ICON[t.kind];
  return (
    <div className="row" style={{ gap: 8, minHeight: 34 }}>
      <Icon size={14} className="faint" />
      <div className="col grow" style={{ minWidth: 0, gap: 0 }}>
        <span className="truncate" style={{ fontSize: "var(--fs-sm)" }}>{t.name}</span>
        <span className="truncate faint" style={{ fontSize: "var(--fs-xs)" }}>{[t.description, t.summary].filter(Boolean).join(" · ")}</span>
      </div>
      <Button size="sm" variant="ghost" icon={Plus} onClick={() => use(t)}>
        Use
      </Button>
      {!t.builtin && (
        <>
          <IconButton
            icon={Pencil}
            label="Rename"
            size="sm"
            onClick={async () => {
              const name = await prompt({ title: "Rename template", initial: t.name });
              if (!name) return;
              await api.templates.update(t.id, { name }).catch((e) => toastError(describeError(e)));
              invalidate("templates");
            }}
          />
          <IconButton
            icon={Download}
            label="Save as a file to share"
            size="sm"
            onClick={async () => {
              const path = await saveDialog({ defaultPath: `${t.name.replace(/[<>:"/\\|?*]/g, "_")}.kern-template.json`, filters: [{ name: "Kern template", extensions: ["json"] }] });
              if (!path) return;
              await api.templates.export(t.id, path).then(() => toast("Template saved")).catch((e) => toastError(describeError(e)));
            }}
          />
          <IconButton
            icon={Trash}
            label="Delete"
            size="sm"
            onClick={async () => {
              if (!(await confirmDelete(`Delete “${t.name}”?`, "Projects, notes and tasks made from it aren't affected."))) return;
              await api.templates.delete(t.id).catch((e) => toastError(describeError(e)));
              invalidate("templates");
            }}
          />
        </>
      )}
    </div>
  );
}

function List({ builtin }: { builtin: boolean }) {
  const { data, isLoading } = useTemplates();
  if (isLoading) return <Skeleton height={60} />;
  const list = (data ?? []).filter((t) => t.builtin === builtin).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  if (!list.length)
    return (
      <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
        Save a project, note or task as a template from its menu, and it shows up here.
      </span>
    );
  return (
    <div className="col" style={{ gap: 0, width: "100%" }}>
      {list.map((t) => (
        <TemplateRow key={t.id} t={t} />
      ))}
    </div>
  );
}

async function importTemplate() {
  const path = await openDialog({ title: "Import a template", filters: [{ name: "Kern template", extensions: ["json"] }] });
  if (typeof path !== "string") return;
  try {
    const t = await api.templates.import(path);
    invalidate("templates");
    toast(`Imported “${t.name}”`);
  } catch (e) {
    toastError(describeError(e, "Couldn't import that template."));
  }
}

export function templateGroups(): GroupDef[] {
  return [
    {
      title: "Your templates",
      rows: [
        { label: "Saved templates", hint: "In a Kern Cloud workspace, templates are shared with its members.", keywords: "template project note task checklist", block: <List builtin={false} /> },
        { label: "Import a template file", control: <Button size="sm" icon={Upload} onClick={() => void importTemplate()}>Import…</Button> },
      ],
    },
    { title: "Built in", rows: [{ label: "Built-in templates", keywords: "template client launch event bug meeting", block: <List builtin /> }] },
  ];
}
