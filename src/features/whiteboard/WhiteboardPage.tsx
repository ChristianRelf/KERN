/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Ellipsis, Presentation } from "lucide-react";
import { useState } from "react";
import { useProjectMap, useProjects, useWhiteboards } from "@/hooks/data";
import { navigate } from "@/stores/router";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { WhiteboardCanvas } from "./Canvas";
import { whiteboardMenu } from "./actions";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { api } from "@/lib/ipc";
import { invalidate } from "@/lib/query";

export default function WhiteboardPage({ id }: { id: string }) {
  const { data: boards } = useWhiteboards();
  const { data: projects } = useProjects();
  const projectMap = useProjectMap();
  const wb = boards?.find((b) => b.id === id);
  const project = wb?.projectId ? projectMap.get(wb.projectId) : undefined;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title" style={{ minWidth: 0 }}>
          <Presentation />
          {project && (
            <>
              <button type="button" className="row muted" style={{ gap: 6, fontWeight: 500 }} onClick={() => navigate({ name: "project", id: project.id, tab: "whiteboard", whiteboardId: id })}>
                <ProjectGlyph project={project} size={14} />
                {project.name}
              </button>
              <span className="faint">/</span>
            </>
          )}
          {renaming && wb ? (
            <input
              className="input input--bare"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                setRenaming(false);
                if (name.trim() && name.trim() !== wb.name) void api.whiteboards.update(id, { name: name.trim() }).then(() => invalidate("whiteboards"));
              }}
              onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <span className="truncate" onDoubleClick={() => wb && (setName(wb.name), setRenaming(true))} title="Double-click to rename">
              {wb?.name ?? "Whiteboard"}
            </span>
          )}
        </h1>
        <div className="page-header__actions">
          {wb && (
            <Dropdown items={() => whiteboardMenu(wb, projects ?? []).slice(1)} align="end">
              <IconButton icon={Ellipsis} label="Whiteboard actions" noTooltip />
            </Dropdown>
          )}
        </div>
      </header>
      <WhiteboardCanvas id={id} projectId={wb?.projectId ?? null} />
    </div>
  );
}
