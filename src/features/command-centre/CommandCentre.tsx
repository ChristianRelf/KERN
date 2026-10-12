// Project Command Centre: the project's overview. An editable widget grid
// (same engine as the dashboard) that starts from a preset matching what
// the project has — General for any project, Hybrid once code is linked —
// with the main project actions always one click away. Development actions
// only appear when the project has development resources.

import { Check, Ellipsis, FolderGit2, Pencil, Play, Plus, Presentation, RotateCcw, SquareKanban, SquareTerminal, StickyNote, Flag, ChevronDown, Sparkles } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GridItem, Project, ProjectCapabilities, WidgetInstance } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import { navigate } from "@/stores/router";
import { toastError } from "@/stores/toast";
import { useWhiteboards } from "@/hooks/data";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { confirm } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Controls";
import { deriveLayouts, newWidgetId } from "@/features/dashboard/templates";
import { WidgetCatalogue, WidgetGrid, useWidgetDoc, useWidth, type WidgetDoc } from "@/features/dashboard/WidgetGrid";
import { openNewTask } from "@/features/tasks/creation";
import { createNote, createWhiteboard } from "@/features/search/commands";
import { createMilestone } from "@/features/milestones/actions";
import { StartSessionButton } from "@/features/sessions/SessionUi";
import { openTerminal, runInTerminal } from "@/features/terminal/store";
import { openCatchup } from "@/features/catchup/open";
import { useCapabilities, useCommands, useRepos } from "@/features/dev/hooks";
import { openWorktreeDialog } from "@/features/dev/worktreeDialog";
import { recordWorkspace } from "@/features/workspace/store";
import { DEV_WIDGETS, PRESETS, PROJECT_WIDGETS, PROJECT_WIDGET_MAP } from "./widgets";
import { ProjectWidgetContext } from "./context";

export function buildPreset(id: (typeof PRESETS)[number]["id"]): WidgetDoc {
  const preset = PRESETS.find((p) => p.id === id) ?? PRESETS[0];
  const widgets: WidgetInstance[] = [];
  const lg: GridItem[] = [];
  for (const s of preset.slots) {
    const def = PROJECT_WIDGET_MAP.get(s.type);
    if (!def) continue;
    const wid = newWidgetId();
    widgets.push({ id: wid, type: s.type, config: structuredClone(def.defaultConfig) });
    lg.push({ i: wid, x: s.x, y: s.y, w: s.w, h: s.h, minW: def.minSize.w, minH: def.minSize.h });
  }
  return { widgets, layouts: deriveLayouts(lg) };
}

export function defaultPreset(caps: ProjectCapabilities | undefined): "general" | "hybrid" {
  return caps && (caps.repositories > 0 || caps.commands > 0 || caps.services > 0) ? "hybrid" : "general";
}

export function CommandCentre({ project }: { project: Project }) {
  const { data: caps } = useCapabilities(project.id);
  const { data: layout, isLoading } = useQuery({ queryKey: ["layouts", project.id], queryFn: () => api.workspace.layout(project.id), staleTime: Infinity });
  if (isLoading || caps === undefined) return <div className="page-loading"><Skeleton height={160} /></div>;
  const preset = layout ? null : defaultPreset(caps);
  return <CentreView key={layout ? "saved" : preset!} project={project} caps={caps} saved={layout ? { widgets: layout.widgets, layouts: layout.layouts } : null} preset={layout?.preset ?? preset} />;
}

function CentreView({ project, caps, saved, preset }: { project: Project; caps: ProjectCapabilities; saved: WidgetDoc | null; preset: string | null }) {
  const [editing, setEditing] = useState(false);
  const [catalogue, setCatalogue] = useState(false);
  const { ref, width } = useWidth();
  const initial = useMemo(() => saved ?? buildPreset((preset as "general") ?? "general"), [saved, preset]);
  // The latest full document, so a partial change can be saved whole.
  const latest = useRef<WidgetDoc>(initial);
  const persist = useCallback(
    (p: Partial<WidgetDoc>) => {
      const widgets = p.widgets ?? latest.current.widgets;
      const layouts = p.layouts ?? latest.current.layouts;
      queryClient.setQueryData(["layouts", project.id], { projectId: project.id, preset, widgets, layouts, updatedAt: Date.now() });
      void api.workspace.saveLayout(project.id, preset, widgets, layouts).catch((e) => toastError(describeError(e, "Couldn't save the layout.")));
    },
    [project.id, preset],
  );
  const doc = useWidgetDoc(initial, PROJECT_WIDGET_MAP, persist, editing);
  latest.current = { widgets: doc.widgets, layouts: doc.layouts };
  const visible = doc.widgets.filter((w) => !w.hidden && PROJECT_WIDGET_MAP.has(w.type));

  const reset = async (id: (typeof PRESETS)[number]["id"]) => {
    const p = PRESETS.find((x) => x.id === id)!;
    if (!(await confirm({ title: `Use the ${p.name} layout?`, message: `${p.description} Your current widgets and their settings on this overview are replaced.`, confirmLabel: "Use layout" }))) return;
    doc.replace(buildPreset(id));
  };

  const layoutMenu: MenuItems = [
    { type: "label", label: "Layouts" },
    ...PRESETS.map((p) => ({ label: p.name, icon: RotateCcw, onSelect: () => void reset(p.id) })),
    { type: "separator" },
    {
      label: "Restore default",
      icon: RotateCcw,
      onSelect: async () => {
        if (!(await confirm({ title: "Restore the default overview?", message: "Your customised layout for this project is removed.", confirmLabel: "Restore" }))) return;
        await api.workspace.resetLayout(project.id).catch((e) => toastError(describeError(e)));
        queryClient.setQueryData(["layouts", project.id], null);
      },
    },
  ];

  return (
    <div className="page-body command-centre" ref={ref}>
      <ProjectWidgetContext.Provider value={{ project, caps }}>
        <div className="cc-bar">
          <MainActions project={project} caps={caps} />
          <span className="spacer" />
          {editing ? (
            <>
              <Button size="sm" icon={Plus} onClick={() => setCatalogue(true)}>
                Add widget
              </Button>
              <Button size="sm" variant="primary" icon={Check} onClick={() => setEditing(false)}>
                Done
              </Button>
            </>
          ) : (
            <IconButton icon={Pencil} label="Customise overview" size="sm" onClick={() => setEditing(true)} />
          )}
          <Dropdown items={layoutMenu} align="end">
            <IconButton icon={Ellipsis} label="Overview layouts" size="sm" noTooltip />
          </Dropdown>
        </div>
        <div className="dash" data-editing={editing}>
          {visible.length === 0 ? (
            <div className="empty" style={{ marginTop: 40 }}>
              <div className="empty__title">This overview is empty</div>
              <Button icon={Plus} onClick={() => (setEditing(true), setCatalogue(true))}>
                Add a widget
              </Button>
            </div>
          ) : (
            <WidgetGrid doc={doc} defs={PROJECT_WIDGET_MAP} editing={editing} onEditLayout={() => setEditing(true)} width={width} />
          )}
        </div>
        <WidgetCatalogue
          open={catalogue}
          onOpenChange={setCatalogue}
          doc={doc}
          groups={[
            { title: "Project", defs: PROJECT_WIDGETS },
            { title: "Development (optional)", defs: DEV_WIDGETS },
          ]}
        />
      </ProjectWidgetContext.Provider>
    </div>
  );
}

/** The project's main actions; development actions only when they apply. */
function MainActions({ project, caps }: { project: Project; caps: ProjectCapabilities }) {
  const { data: whiteboards } = useWhiteboards(project.id);
  const dev = caps.repositories > 0 || caps.commands > 0;
  const { data: repos } = useRepos(project.id, dev);
  const { data: commands } = useCommands(project.id, caps.commands > 0);
  const localTrusted = (repos ?? []).filter((r) => r.localStatus === "ok" && r.trust === "trusted");
  const pinned = (commands ?? []).filter((c) => c.pinned);
  const goto = (tab: Parameters<typeof navigate>[0] & { name: "project" }) => navigate(tab, { replace: true });
  return (
    <div className="cc-actions">
      <Button size="sm" variant="primary" icon={Plus} onClick={() => openNewTask({ projectId: project.id })}>
        Task
      </Button>
      <Button size="sm" icon={SquareKanban} onClick={() => goto({ name: "project", id: project.id, tab: "board" })}>
        Board
      </Button>
      <Button
        size="sm"
        icon={Presentation}
        onClick={() => (whiteboards?.length ? goto({ name: "project", id: project.id, tab: "whiteboard" }) : void createWhiteboard(project.id))}
      >
        Whiteboard
      </Button>
      <Button size="sm" icon={StickyNote} onClick={() => void createNote(project.id)}>
        Note
      </Button>
      <Button size="sm" icon={Flag} onClick={() => void createMilestone({ projectId: project.id })}>
        Milestone
      </Button>
      <StartSessionButton projectId={project.id} label="Session" />
      <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => openCatchup(project.id)}>
        Catch up
      </Button>
      {(dev || project.folderPath) && <span className="cc-actions__sep" aria-hidden />}
      {(dev || project.folderPath) && (
        <Button size="sm" variant="ghost" icon={SquareTerminal} onClick={() => void openTerminal({ projectId: project.id, cwd: localTrusted[0] && !project.folderPath ? { kind: "repository", repositoryId: localTrusted[0].id } : undefined })}>
          Terminal
        </Button>
      )}
      {localTrusted.length > 0 && (
        <Button size="sm" variant="ghost" icon={FolderGit2} onClick={() => openWorktreeDialog({ projectId: project.id, repositoryId: localTrusted[0].id })}>
          Worktree
        </Button>
      )}
      {(caps.commands > 0 || localTrusted.length > 0) && (
        <Dropdown
          align="start"
          items={[
            ...pinned.map((c) => ({ label: c.name, icon: Play, onSelect: () => void runInTerminal(project.id, { commandId: c.id }, undefined, c.name) })),
            pinned.length > 0 && { type: "separator" },
            {
              label: "All commands…",
              icon: SquareTerminal,
              onSelect: () => {
                recordWorkspace(project.id, { codeSection: "run" });
                goto({ name: "project", id: project.id, tab: "code" });
              },
            },
          ]}
        >
          <Button size="sm" variant="ghost" icon={Play}>
            Run <ChevronDown size={12} />
          </Button>
        </Dropdown>
      )}
    </div>
  );
}
