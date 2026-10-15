/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { FolderKanban, Presentation } from "lucide-react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WidgetProps } from "../types";
import type { WbNodeRecord, WhiteboardScene } from "@/lib/types";
import { useProjects, useWhiteboards } from "@/hooks/data";
import { api } from "@/lib/ipc";
import { navigate } from "@/stores/router";
import { EmptyState, Progress, Select } from "@/components/ui/Controls";
import { Button } from "@/components/ui/Button";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { relativeTime } from "@/lib/dates";
import { useUi } from "@/stores/ui";
import { ToggleRow } from "./RundownWidget";
import { colorVar, type WbColor } from "@/features/whiteboard/model";
import { inkPath } from "@/features/whiteboard/ink";

// ------------------------------------------------------------- Projects

export type ProjectsConfig = { mode: "pinned-recent" | "selected" | "all"; projectIds: string[]; max: number; showStats: boolean };

export function ProjectsWidget({ config }: WidgetProps<ProjectsConfig>) {
  const { data: projects } = useProjects();
  const list = useMemo(() => {
    const all = projects ?? [];
    if (config.mode === "selected") return config.projectIds.map((id) => all.find((p) => p.id === id)).filter(Boolean) as typeof all;
    if (config.mode === "all") return all;
    const pinned = all.filter((p) => p.pinned);
    const recent = all
      .filter((p) => !p.pinned)
      .sort((a, b) => (b.lastOpenedAt ?? b.lastActivityAt ?? 0) - (a.lastOpenedAt ?? a.lastActivityAt ?? 0));
    return [...pinned, ...recent];
  }, [projects, config.mode, config.projectIds]);
  if (!projects?.length)
    return (
      <EmptyState compact icon={FolderKanban} action={<Button size="sm" onClick={() => useUi.getState().set({ createProjectOpen: true })}>New project</Button>}>
        No projects yet.
      </EmptyState>
    );
  return (
    <div className="col">
      {list.slice(0, config.max).map((p) => {
        const open = p.taskTotal - p.taskDone;
        return (
          <div key={p.id} className="proj-row" role="button" tabIndex={0} onClick={() => navigate({ name: "project", id: p.id })} onKeyDown={(e) => e.key === "Enter" && navigate({ name: "project", id: p.id })}>
            <ProjectGlyph project={p} size={18} />
            <div className="proj-row__main">
              <div className="proj-row__top">
                <span className="truncate grow">{p.name}</span>
                <span className="faint tabular" style={{ fontSize: "var(--fs-xs)" }}>
                  {p.taskTotal ? `${Math.round((p.taskDone / p.taskTotal) * 100)}%` : "-"}
                </span>
              </div>
              <Progress value={p.taskTotal ? p.taskDone / p.taskTotal : 0} />
              {config.showStats && (
                <div className="proj-row__stats">
                  <span>{open} open</span>
                  {p.taskOverdue > 0 && <span style={{ color: "var(--text)", fontWeight: 600 }}>{p.taskOverdue} overdue</span>}
                  {p.lastActivityAt && <span>{relativeTime(p.lastActivityAt)}</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ProjectsConfigForm({ config, setConfig }: { config: ProjectsConfig; setConfig: (p: Partial<ProjectsConfig>) => void }) {
  const { data: projects } = useProjects();
  return (
    <div className="col" style={{ gap: 10, width: 260 }}>
      <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
        <span className="muted">Show</span>
        <Select
          value={config.mode}
          onChange={(mode) => setConfig({ mode })}
          options={[
            { value: "pinned-recent", label: "Pinned & recent" },
            { value: "selected", label: "Selected projects" },
            { value: "all", label: "All projects" },
          ]}
        />
      </div>
      {config.mode === "selected" && (
        <div className="col" style={{ gap: 4, maxHeight: 180, overflowY: "auto" }}>
          {(projects ?? []).map((p) => (
            <ToggleRow
              key={p.id}
              label={p.name}
              value={config.projectIds.includes(p.id)}
              onChange={(on) => setConfig({ projectIds: on ? [...config.projectIds, p.id] : config.projectIds.filter((x) => x !== p.id) })}
            />
          ))}
        </div>
      )}
      <ToggleRow label="Details" value={config.showStats} onChange={(v) => setConfig({ showStats: v })} />
      <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
        <span className="muted">Maximum</span>
        <Select value={String(config.max)} onChange={(v) => setConfig({ max: Number(v) })} options={[3, 5, 8, 12].map((n) => ({ value: String(n), label: String(n) }))} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------- Whiteboard preview

/** Absolute bounds of nodes, resolving parent-relative positions. */
export function absoluteNodes(nodes: WbNodeRecord[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const abs = (n: WbNodeRecord): { x: number; y: number } => {
    const p = n.parentId ? byId.get(n.parentId) : undefined;
    if (!p) return { x: n.x, y: n.y };
    const pa = abs(p);
    return { x: pa.x + n.x, y: pa.y + n.y };
  };
  return nodes.map((n) => ({ ...n, ...abs(n), w: n.width ?? 200, h: n.height ?? 100 }));
}

export function WhiteboardThumb({ scene, height = "100%" }: { scene: WhiteboardScene; height?: number | string }) {
  const nodes = useMemo(() => absoluteNodes(scene.nodes), [scene.nodes]);
  if (!nodes.length)
    return (
      <div className="wb-preview" style={{ height, display: "grid", placeItems: "center" }}>
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Empty whiteboard</span>
      </div>
    );
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  const pad = 40;
  const vb = `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
  const center = new Map(nodes.map((n) => [n.id, { x: n.x + n.w / 2, y: n.y + n.h / 2 }]));
  return (
    <svg className="wb-preview" style={{ height }} viewBox={vb} preserveAspectRatio="xMidYMid meet" aria-label={`Preview of ${scene.whiteboard.name}`}>
      {scene.edges.map((e) => {
        const a = center.get(e.source);
        const b = center.get(e.target);
        if (!a || !b) return null;
        return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--text-4)" strokeWidth={3} vectorEffect="non-scaling-stroke" />;
      })}
      {nodes
        .slice()
        .sort((a, b) => (a.type === "area" ? -1 : 0) - (b.type === "area" ? -1 : 0) || a.z - b.z)
        .map((n) => {
          const common = { x: n.x, y: n.y, width: n.w, height: n.h, rx: 10 };
          if (n.type === "area")
            return <rect key={n.id} {...common} fill="var(--hover)" stroke="var(--border-strong)" strokeDasharray="8 6" vectorEffect="non-scaling-stroke" />;
          const ink = colorVar(n.data.color as WbColor | undefined, "var(--text-3)");
          if (n.type === "draw") {
            const vw = (n.data.vw as number) || n.w;
            const vh = (n.data.vh as number) || n.h;
            return <path key={n.id} transform={`translate(${n.x} ${n.y})`} d={inkPath((n.data.points as number[]) ?? [], n.w / vw, n.h / vh)} fill="none" stroke={ink} strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
          }
          if (n.type === "shape") {
            const shape = (n.data.shape as string) ?? "rect";
            if (shape === "circle") return <ellipse key={n.id} cx={n.x + n.w / 2} cy={n.y + n.h / 2} rx={n.w / 2} ry={n.h / 2} fill="none" stroke={ink} vectorEffect="non-scaling-stroke" />;
            if (shape === "line" || shape === "arrow") {
              const [x1, y1, x2, y2] = n.data.flip ? [0, n.h, n.w, 0] : n.h < 24 ? [0, n.h / 2, n.w, n.h / 2] : n.w < 24 ? [n.w / 2, 0, n.w / 2, n.h] : [0, 0, n.w, n.h];
              return <line key={n.id} x1={n.x + x1} y1={n.y + y1} x2={n.x + x2} y2={n.y + y2} stroke={ink} strokeWidth={2} vectorEffect="non-scaling-stroke" />;
            }
            return <rect key={n.id} {...common} rx={shape === "rounded" ? 16 : 2} fill="none" stroke={ink} vectorEffect="non-scaling-stroke" />;
          }
          const fill = n.type === "sticky" ? "var(--surface-3)" : n.type === "image" ? "var(--border-strong)" : "var(--surface-2)";
          return <rect key={n.id} {...common} fill={fill} stroke="var(--border)" vectorEffect="non-scaling-stroke" />;
        })}
    </svg>
  );
}

export type WhiteboardPreviewConfig = { whiteboardId: string | null };

export function WhiteboardPreviewWidget({ config, setConfig }: WidgetProps<WhiteboardPreviewConfig>) {
  const { data: boards } = useWhiteboards();
  const id = config.whiteboardId ?? boards?.[0]?.id ?? null;
  // A static SVG preview: no interactive canvas is initialised here.
  const { data: scene } = useQuery({ queryKey: ["whiteboard", "preview", id], queryFn: () => api.whiteboards.preview(id!), enabled: !!id });
  if (!boards?.length)
    return (
      <EmptyState compact icon={Presentation}>
        No whiteboards yet.
      </EmptyState>
    );
  if (!scene) return null;
  return (
    <div className="col" style={{ height: "100%", gap: 6 }}>
      <div onClick={() => navigate({ name: "whiteboard", id: scene.whiteboard.id })} style={{ flex: 1, minHeight: 0 }} role="button" aria-label={`Open ${scene.whiteboard.name}`}>
        <WhiteboardThumb scene={scene} />
      </div>
      {!config.whiteboardId && boards.length > 1 && (
        <button type="button" className="mini-more" onClick={() => setConfig({ whiteboardId: scene.whiteboard.id })}>
          Pin “{scene.whiteboard.name}” to this widget
        </button>
      )}
    </div>
  );
}

export function WhiteboardPreviewConfigForm({ config, setConfig }: { config: WhiteboardPreviewConfig; setConfig: (p: Partial<WhiteboardPreviewConfig>) => void }) {
  const { data: boards } = useWhiteboards();
  return (
    <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)", gap: 12 }}>
      <span className="muted">Whiteboard</span>
      <Select
        value={config.whiteboardId ?? "latest"}
        onChange={(v) => setConfig({ whiteboardId: v === "latest" ? null : v })}
        options={[{ value: "latest", label: "Most recent" }, ...(boards ?? []).map((b) => ({ value: b.id, label: b.name }))]}
      />
    </div>
  );
}

export function useWhiteboardTitle(config: WhiteboardPreviewConfig) {
  const { data: boards } = useWhiteboards();
  return boards?.find((b) => b.id === config.whiteboardId)?.name;
}
