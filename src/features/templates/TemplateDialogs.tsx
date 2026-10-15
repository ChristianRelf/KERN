// Template dialogs: saving a project as a template, and picking a note or
// task template to start from.

import { FileText, LayoutTemplate, ListChecks, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TemplateMeta } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, invalidateTasks } from "@/lib/query";
import { navigate } from "@/stores/router";
import { toast, toastError } from "@/stores/toast";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState, Skeleton, Switch } from "@/components/ui/Controls";
import { openTask } from "@/features/tasks/menu";
import { newProjectFromTemplate, useTemplateDialogs, type TemplateRequest } from "./open";
import "./templates.css";

export function useTemplates(kind?: TemplateMeta["kind"]) {
  return useQuery({ queryKey: ["templates", kind ?? "all"], queryFn: () => api.templates.list(kind), staleTime: 60_000 });
}

function SaveProject({ req, close }: { req: Extract<TemplateRequest, { mode: "save-project" }>; close: () => void }) {
  const [name, setName] = useState(req.name);
  const [description, setDescription] = useState("");
  const [tasks, setTasks] = useState(true);
  const [notes, setNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const t = await api.templates.saveProject(req.projectId, name.trim(), description.trim(), tasks, notes);
      invalidate("templates");
      toast(`Saved “${t.name}” as a template`, { action: { label: "New project from it", run: () => newProjectFromTemplate(t.id) } });
      close();
    } catch (e) {
      toastError(describeError(e, "Couldn't save the template."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title="Save as template"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void save()}>
            Save template
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
          Keeps this project's boards and columns, milestones, and (if you like) its open tasks with their checklists and notes. Dates are kept relative to each other, so a new project starts on whatever day you choose. Completed work and files aren't included.
        </p>
        <label className="field">
          <span className="field__label">Name</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        </label>
        <label className="field">
          <span className="field__label">Description</span>
          <input className="input" placeholder="What it's for (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: "var(--fs-sm)" }}>Include open tasks</span>
          <Switch checked={tasks} onChange={setTasks} label="Include open tasks" />
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span style={{ fontSize: "var(--fs-sm)" }}>Include notes</span>
          <Switch checked={notes} onChange={setNotes} label="Include notes" />
        </div>
      </div>
    </Dialog>
  );
}

function Pick({ req, close }: { req: Extract<TemplateRequest, { mode: "pick" }>; close: () => void }) {
  const { data, isLoading } = useTemplates(req.kind);
  const [q, setQ] = useState("");
  const list = useMemo(() => (data ?? []).filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  const use = async (t: TemplateMeta) => {
    try {
      if (req.kind === "note") {
        const n = await api.templates.useNote(t.id, req.projectId ?? null);
        invalidate("notes", "recent");
        navigate({ name: "notes", id: n.id });
      } else {
        const task = await api.templates.useTask(t.id, req.projectId ?? null, null);
        invalidateTasks();
        openTask(task.id);
      }
      close();
    } catch (e) {
      toastError(describeError(e, "Couldn't use that template."));
    }
  };
  const Icon = req.kind === "note" ? FileText : ListChecks;
  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={req.kind === "note" ? "New note from a template" : "New task from a template"}>
      <div className="col" style={{ gap: 8 }}>
        <div className="input-wrap">
          <Search />
          <input className="input" autoFocus placeholder="Search templates" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {isLoading && <Skeleton height={80} />}
        <div className="col" style={{ gap: 2, maxHeight: 380, overflowY: "auto" }}>
          {list.map((t) => (
            <button key={t.id} type="button" className="template-option" onClick={() => void use(t)}>
              <Icon size={16} className="faint" />
              <span className="col grow" style={{ minWidth: 0, gap: 1, textAlign: "left" }}>
                <span className="truncate">{t.name}</span>
                <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>
                  {t.description || t.summary}
                  {t.builtin ? " · built in" : ""}
                </span>
              </span>
            </button>
          ))}
          {!isLoading && !list.length && (
            <EmptyState compact icon={LayoutTemplate}>
              {q ? "No templates match." : `Save a ${req.kind} as a template from its menu to see it here.`}
            </EmptyState>
          )}
        </div>
      </div>
    </Dialog>
  );
}

export default function TemplateHost() {
  const req = useTemplateDialogs((s) => s.req);
  const close = () => useTemplateDialogs.setState({ req: null });
  if (!req) return null;
  return req.mode === "save-project" ? <SaveProject req={req} close={close} /> : <Pick req={req} close={close} />;
}
