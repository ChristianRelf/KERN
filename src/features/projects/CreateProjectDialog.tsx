/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { useMemo, useState } from "react";
import { LayoutTemplate } from "lucide-react";
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
import { describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { navigate } from "@/stores/router";
import { toastError } from "@/stores/toast";
import { todayStr } from "@/lib/dates";
import { useTemplates } from "@/features/templates/data";
import { useTemplateDialogs } from "@/features/templates/open";
import "@/features/templates/templates.css";

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
  const { data: templates } = useTemplates("project");
  const [templateId, setTemplateId] = useState<string>(() => {
    const pre = useTemplateDialogs.getState().projectTemplate;
    useTemplateDialogs.setState({ projectTemplate: null });
    return pre ?? "blank";
  });
  const [startDate, setStartDate] = useState<string>(todayStr());
  const template = useMemo(() => templates?.find((t) => t.id === templateId), [templates, templateId]);

  const submitFromTemplate = async () => {
    try {
      let p = await api.templates.useProject(templateId, { name: name.trim(), startDate, groupId: groupId === "none" ? null : groupId });
      const patch: Parameters<typeof api.projects.update>[1] = {};
      if (description.trim()) patch.description = description;
      if (icon) patch.icon = icon;
      if (accent) patch.accent = accent;
      if (targetDate) patch.targetDate = targetDate;
      if (Object.keys(patch).length) p = await api.projects.update(p.id, patch);
      if (folder) await api.folders.link(p.id, folder.info.path, folder.trust);
      invalidate("projects", "project", "groups", "tasks", "notes", "milestones", "boards");
      navigate({ name: "project", id: p.id });
      return p;
    } catch (e) {
      toastError(describeError(e, "Couldn't create the project from that template."));
      return null;
    }
  };

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    if (templateId !== "blank") {
      const p = await submitFromTemplate();
      setBusy(false);
      if (!p) return;
      if (folder && openAfter) void api.system.open(folder.info.path).catch(() => undefined);
      onClose();
      return;
    }
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
      {!!templates?.length && (
        <div className="template-pick">
          <LayoutTemplate size={15} className="faint" />
          <Select
            value={templateId}
            onChange={setTemplateId}
            ariaLabel="Start from"
            options={[
              { value: "blank", label: "Blank project" },
              ...templates.filter((t) => !t.builtin).map((t) => ({ value: t.id, label: t.name })),
              ...templates.filter((t) => t.builtin).map((t) => ({ value: t.id, label: `${t.name} (built in)` })),
            ]}
          />
          {template && (
            <DuePopover
              date={startDate}
              withTime={false}
              onChange={(d) => d && setStartDate(d)}
              trigger={
                <button type="button" className="btn btn--sm">
                  Starts {formatDue(startDate)}
                </button>
              }
            />
          )}
          {template && <span className="faint template-pick__summary">{template.description || template.summary} · {template.summary}</span>}
        </div>
      )}
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
