// Import from other apps: pick an export file, see what will be created,
// then import it all at once (one transaction, with undo via the trash).

import { FileUp, FolderKanban, Upload } from "lucide-react";
import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { ImportBundle } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { navigate } from "@/stores/router";
import { toast, toastError } from "@/stores/toast";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/Controls";
import { countTasks, detect, parseExport, SOURCE_LABEL, type ImportSource } from "./parsers";

const HOW: Record<ImportSource, string> = {
  todoist: "In Todoist, open the project → ⋯ → Export as a template → Download as CSV.",
  trello: "In Trello, open the board → ⋯ → Print, export and share → Export as JSON.",
  linear: "In Linear, Settings → Administration → Import / export → Export CSV.",
  csv: "Notion: open the database → ⋯ → Export → Markdown & CSV (use the .csv). Any other app: a CSV with a title column, plus optional status, due date, priority, tags and project columns.",
};

export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [file, setFile] = useState<{ path: string; name: string; text: string } | null>(null);
  const [source, setSource] = useState<ImportSource>("csv");
  const [bundle, setBundle] = useState<ImportBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = (name: string, text: string, src: ImportSource) => {
    try {
      setBundle(parseExport(name, text, src));
      setError(null);
    } catch (e) {
      setBundle(null);
      setError(e instanceof Error ? e.message : "That file couldn't be read.");
    }
  };

  const choose = async () => {
    const path = await openDialog({ title: "Choose an export", filters: [{ name: "Exports", extensions: ["csv", "json"] }] });
    if (typeof path !== "string") return;
    try {
      const text = await api.system.readText(path);
      const name = path.replace(/^.*[\\/]/, "");
      let src: ImportSource = "csv";
      try {
        src = detect(name, text);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      setFile({ path, name, text });
      setSource(src);
      read(name, text, src);
    } catch (e) {
      toastError(describeError(e, "Couldn't read that file."));
    }
  };

  const run = async () => {
    if (!bundle) return;
    setBusy(true);
    try {
      const r = await api.importBundle(bundle);
      invalidate("projects", "project", "tasks", "task", "labels", "notes", "boards", "board", "stats", "rundown");
      toast(`Imported ${r.tasks} task${r.tasks === 1 ? "" : "s"} into ${r.projects} project${r.projects === 1 ? "" : "s"}${r.labels ? ` (${r.labels} new labels)` : ""}`);
      if (r.projectIds[0]) navigate({ name: "project", id: r.projectIds[0] });
      close();
    } catch (e) {
      toastError(describeError(e, "The import failed. Nothing was changed."));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setFile(null);
    setBundle(null);
    setError(null);
    onClose();
  };

  const perProject = bundle ? bundle.projects.map((p) => ({ name: p.name, n: countTasks(bundle.tasks.filter((t) => t.projectKey === p.key)) })) : [];
  const loose = bundle ? countTasks(bundle.tasks.filter((t) => !t.projectKey)) : 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title="Import from another app"
      wide
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" icon={Upload} disabled={!bundle || busy || (!countTasks(bundle.tasks) && !bundle.projects.length)} onClick={() => void run()}>
            {bundle ? `Import ${countTasks(bundle.tasks)} task${countTasks(bundle.tasks) === 1 ? "" : "s"}` : "Import"}
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
          Bring in projects and tasks from Todoist, Trello, Linear, Notion or any CSV. Columns, checklists, labels, due dates and priorities come along; finished tasks arrive completed. Everything is read on this computer.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <Button icon={FileUp} onClick={() => void choose()}>
            {file ? "Choose another file…" : "Choose export file…"}
          </Button>
          {file && <span className="truncate faint" style={{ fontSize: "var(--fs-sm)" }}>{file.name}</span>}
          {file && (
            <Select
              value={source}
              onChange={(v) => {
                setSource(v);
                read(file.name, file.text, v);
              }}
              ariaLabel="Read as"
              options={(Object.keys(SOURCE_LABEL) as ImportSource[]).map((s) => ({ value: s, label: `Read as ${SOURCE_LABEL[s]}` }))}
            />
          )}
        </div>
        {error && <span style={{ color: "var(--danger)", fontSize: "var(--fs-sm)" }}>{error}</span>}
        {bundle && (
          <div className="panel" style={{ gap: 4 }}>
            <div className="panel__title">Will create</div>
            {perProject.map((p) => (
              <div key={p.name} className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
                <FolderKanban size={14} className="faint" />
                <span className="truncate grow">{p.name}</span>
                <span className="faint tabular">
                  {p.n} task{p.n === 1 ? "" : "s"}
                </span>
              </div>
            ))}
            {loose > 0 && (
              <div className="row" style={{ fontSize: "var(--fs-sm)" }}>
                <span className="grow">Inbox</span>
                <span className="faint tabular">{loose}</span>
              </div>
            )}
            {!countTasks(bundle.tasks) && <span className="faint">No tasks were found in this file.</span>}
          </div>
        )}
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          How to export: {HOW[file ? source : "csv"]}
          {!file && (
            <>
              {" "}
              Todoist: {HOW.todoist} Trello: {HOW.trello} Linear: {HOW.linear}
            </>
          )}
        </span>
      </div>
    </Dialog>
  );
}
