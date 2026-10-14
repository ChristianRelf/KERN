import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { useUi } from "@/stores/ui";
import { createProject } from "./actions";
import { ProjectGlyph } from "./ProjectGlyph";
import { AppearancePicker } from "./AppearancePicker";
import { useGroups } from "@/hooks/data";
import { Select } from "@/components/ui/Controls";
import { DuePopover } from "@/features/tasks/pickers";
import { formatDue } from "@/lib/dates";
import { useSetting } from "@/stores/settings";
import { api } from "@/lib/ipc";
import { FolderField, type PickedFolder } from "./folders";

/** Icon, emoji and colour for a project (kept for existing callers). */
export function IconAccentPicker(props: { icon: string | null; accent: string | null; onChange: (p: { icon?: string | null; accent?: string | null }) => void; name: string }) {
  return <AppearancePicker {...props} />;
}

export function CreateProjectDialog() {
  const open = useUi((s) => s.createProjectOpen);
  const set = useUi((s) => s.set);
  return open ? <CreateProjectForm onClose={() => set({ createProjectOpen: false })} /> : null;
}

function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const folderField = useSetting("projects.folderField");
  const openAfter = useSetting("projects.openFolderAfterCreate");
  const [name, setName] = useState("");
  const [more, setMore] = useState(false);
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [accent, setAccent] = useState<string | null>(null);
  const [groupId, setGroupId] = useState<string>("none");
  const [targetDate, setTargetDate] = useState<string | null>(null);
  const [folder, setFolder] = useState<PickedFolder | null>(null);
  const { data: groups } = useGroups();
  const [busy, setBusy] = useState(false);
  const showFolder = folderField === "visible" || more || !!folder;

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const p = await createProject({
      name: name.trim(),
      description,
      icon,
      accent,
      targetDate,
      groupId: groupId === "none" ? null : groupId,
      folder: folder ? { path: folder.info.path, trust: folder.trust } : null,
    });
    setBusy(false);
    if (!p) return;
    if (folder && openAfter) void api.system.open(folder.info.path).catch(() => undefined);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New project"
      className="project-dialog"
      footer={
        <>
          {!more && (
            <Button variant="ghost" onClick={() => setMore(true)} style={{ marginRight: "auto" }}>
              More options
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!name.trim() || busy}>
            Create project
          </Button>
        </>
      }
    >
      <div className="project-dialog__name">
        <ProjectGlyph project={{ name: name || "?", icon, accent }} size={22} />
        <input
          className="project-dialog__title"
          autoFocus
          placeholder="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          aria-label="Project name"
        />
      </div>
      <textarea
        className="project-dialog__desc"
        placeholder="Add a description (optional)"
        value={description}
        rows={2}
        onChange={(e) => setDescription(e.target.value)}
        aria-label="Description"
      />
      {showFolder && <FolderField value={folder} onChange={setFolder} />}
      {more && (
        <>
          <IconAccentPicker
            icon={icon}
            accent={accent}
            name={name}
            onChange={(p) => {
              if (p.icon !== undefined) setIcon(p.icon);
              if (p.accent !== undefined) setAccent(p.accent);
            }}
          />
          <div className="row" style={{ gap: 8 }}>
            {!!groups?.length && (
              <Select
                value={groupId}
                onChange={setGroupId}
                ariaLabel="Group"
                options={[{ value: "none", label: "No group" }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
              />
            )}
            <DuePopover
              date={targetDate}
              withTime={false}
              onChange={(d) => setTargetDate(d)}
              trigger={
                <button type="button" className="btn">
                  {targetDate ? `Target: ${formatDue(targetDate)}` : "Target date"}
                </button>
              }
            />
          </div>
        </>
      )}
    </Dialog>
  );
}
