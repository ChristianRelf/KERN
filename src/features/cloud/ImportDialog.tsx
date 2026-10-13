// "Copy offline data here": brings offline projects, tasks, boards, notes
// and whiteboards into the open cloud space. Files are never uploaded; links
// to folders and local repositories are copied as links on this computer.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CloudUpload, HardDrive } from "lucide-react";
import { api } from "@/lib/ipc";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox, Segmented, Skeleton } from "@/components/ui/Controls";
import { toast, toastError } from "@/stores/toast";
import { errorText, useActiveSpace, useCloud } from "./store";

export function ImportDialog() {
  const open = useCloud((s) => s.importOpen);
  return open ? <Import /> : null;
}

const LABELS: Record<string, string> = { tasks: "tasks", notes: "notes", whiteboards: "whiteboards", boards: "boards", inbox: "inbox items" };

function Import() {
  const space = useActiveSpace();
  const { data, isLoading } = useQuery({ queryKey: ["cloud", "offline-summary"], queryFn: api.cloud.offlineSummary, staleTime: 0 });
  const [mode, setMode] = useState<"all" | "projects">("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const close = () => useCloud.setState({ importOpen: false });
  const target = space ? (space.kind === "personal" ? "your personal space" : space.name) : "";
  const total = useMemo(() => (data ? Object.values(data.counts).reduce((a, b) => a + b, 0) + data.projects.length : 0), [data]);

  const run = async () => {
    setBusy(true);
    try {
      const counts = await api.cloud.importOffline(mode === "all" ? null : [...picked]);
      const n = (counts.projects ?? 0) + (counts.tasks ?? 0) + (counts.notes ?? 0) + (counts.whiteboards ?? 0);
      toast(n ? `Copied ${counts.projects ?? 0} projects, ${counts.tasks ?? 0} tasks, ${counts.notes ?? 0} notes and ${counts.whiteboards ?? 0} whiteboards. Syncing now.` : "Nothing new to copy - it's already here.", { tone: "success", duration: 6000 });
      close();
    } catch (e) {
      toastError(errorText(e, "Couldn't copy the data."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && close()}
      title={
        <span className="row" style={{ gap: 8 }}>
          <CloudUpload size={16} strokeWidth={1.75} /> Copy offline data to {target}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={CloudUpload} disabled={busy || !total || (mode === "projects" && !picked.size)} onClick={() => void run()}>
            {busy ? "Copying…" : "Copy"}
          </Button>
        </>
      }
    >
      {isLoading || !data ? (
        <Skeleton height={140} />
      ) : (
        <div className="col" style={{ gap: 14 }}>
          <div className="cloud-callout">
            <HardDrive size={18} />
            <span className="muted">
              Your offline data stays exactly as it is; this makes a copy in {target}
              {space?.kind === "workspace" ? ", visible to its members" : ""}. Files, attachments and folder contents are never uploaded - linked folders keep working on this computer only.
            </span>
          </div>
          {total === 0 ? (
            <span className="faint">There's no offline data to copy.</span>
          ) : (
            <>
              <Segmented<"all" | "projects">
                value={mode}
                onChange={setMode}
                options={[
                  { value: "all", label: "Everything" },
                  { value: "projects", label: "Choose projects" },
                ]}
              />
              {mode === "all" ? (
                <span className="muted">
                  {data.projects.length} projects
                  {Object.entries(data.counts)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `, ${n} ${LABELS[k] ?? k}`)
                    .join("")}
                  .
                </span>
              ) : (
                <div className="repo-pick" style={{ maxHeight: 260 }}>
                  {data.projects.map(([id, name]) => (
                    <label key={id} className="repo-pick__row">
                      <Checkbox
                        checked={picked.has(id)}
                        onChange={(on) => {
                          const next = new Set(picked);
                          if (on) next.add(id);
                          else next.delete(id);
                          setPicked(next);
                        }}
                        label={name}
                      />
                      <span className="truncate">{name}</span>
                    </label>
                  ))}
                </div>
              )}
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                Copying again skips anything already copied. Whiteboard images live on this computer, so collaborators see placeholders for them.
              </span>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
