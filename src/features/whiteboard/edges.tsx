import { BaseEdge, EdgeLabelRenderer, MarkerType, getBezierPath, getSmoothStepPath, getStraightPath, type EdgeProps } from "@xyflow/react";
import { memo, useContext, useState } from "react";
import type { WbEdge } from "./model";
import { EdgeApiContext } from "./edgeContext";

export const WbEdgeView = memo(function WbEdgeView(props: EdgeProps<WbEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd, markerStart } = props;
  const api = useContext(EdgeApiContext);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(data?.label ?? "");
  const pathKind = data?.path ?? "smooth";
  const [path, labelX, labelY] =
    pathKind === "straight"
      ? getStraightPath({ sourceX, sourceY, targetX, targetY })
      : pathKind === "step"
        ? getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 8 })
        : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const dash = data?.line === "dashed" ? "7 5" : data?.line === "dotted" ? "1.5 5" : undefined;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={{ stroke: selected ? "var(--text)" : "var(--text-3)", strokeDasharray: dash, strokeLinecap: "round" }}
        interactionWidth={18}
      />
      {(data?.label || editing) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              fontSize: "var(--fs-xs)",
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--bg)",
              color: "var(--text-2)",
              border: selected ? "1px solid var(--border-strong)" : "1px solid transparent",
            }}
            onDoubleClick={() => {
              setLabel(data?.label ?? "");
              setEditing(true);
            }}
          >
            {editing ? (
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onBlur={() => {
                  setEditing(false);
                  api.updateEdge(id, { label: label.trim() || undefined });
                }}
                onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && (e.target as HTMLInputElement).blur()}
                style={{ border: "none", background: "transparent", width: Math.max(60, label.length * 7), fontSize: "inherit", color: "var(--text)" }}
              />
            ) : (
              data?.label
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const EDGE_TYPES = { wb: WbEdgeView };

/** Adds arrow markers (rendered inside React Flow's SVG so exports include them). */
export function withMarkers(e: WbEdge, color: string): WbEdge {
  const marker = { type: MarkerType.ArrowClosed, color, width: 16, height: 16 };
  const directed = e.data?.directed !== false || e.data?.both;
  return { ...e, markerEnd: directed ? marker : undefined, markerStart: e.data?.both ? marker : undefined };
}
