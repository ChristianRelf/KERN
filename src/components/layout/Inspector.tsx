/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Maximize2, PanelRightClose, Pin, PinOff } from "lucide-react";
import { lazy, Suspense, useRef, useState, type CSSProperties } from "react";
import { Skeleton } from "@/components/ui/Controls";

const MilestoneDetail = lazy(() => import("@/features/milestones/MilestoneDetail").then((m) => ({ default: m.MilestoneDetail })));
import { useOutsideDismiss } from "@/hooks/useOutsideDismiss";
import { useUi } from "@/stores/ui";
import { useSetting, setSetting } from "@/stores/settings";
import { IconButton } from "@/components/ui/Button";
import { TaskDetail } from "@/features/tasks/TaskDetail";
import { ProjectSummary } from "@/features/projects/ProjectSummary";

import { navigate } from "@/stores/router";
import { useTask } from "@/hooks/data";
import { resolveBindings } from "@/lib/shortcuts";

/** Right-hand contextual panel; resizable and only present when needed. */
export function Inspector() {
  const target = useUi((s) => s.inspector);
  const close = useUi((s) => s.closeInspector);
  const width = useSetting("appearance.inspectorWidth");
  const shortcuts = resolveBindings(useSetting("keyboard.shortcuts"));
  const [live, setLive] = useState<number | null>(null);
  const pinned = useUi((s) => s.inspectorPinned);
  const allowPin = useSetting("interaction.inspectorPinning");
  const outsideClick = useSetting("interaction.closePanelsOnOutsideClick");
  const ref = useRef<HTMLElement>(null);
  const { data: task } = useTask(target?.kind === "task" ? target.id : null);
  // Pinning takes precedence over outside-click dismissal.
  useOutsideDismiss(ref, !!target && outsideClick && !(allowPin && pinned), close, () => useUi.getState().inspector);
  if (!target) return null;

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    let w = width;
    const move = (ev: PointerEvent) => {
      w = Math.max(300, Math.min(680, width - (ev.clientX - startX)));
      setLive(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      void setSetting("appearance.inspectorWidth", Math.round(w));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <aside ref={ref} className="inspector" data-pinned={(allowPin && pinned) || undefined} style={{ "--inspector-w": `${live ?? width}px` } as CSSProperties} aria-label="Details">
      <div className="resize-handle inspector-resize" data-dragging={live !== null} onPointerDown={startResize} role="separator" aria-label="Resize details panel" />
      <div className="inspector__head">
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          {target.kind === "task" ? (task?.parentId ? "Subtask" : "Task") : target.kind === "milestone" ? "Milestone" : "Project"}
        </span>
        <span className="spacer" />
        {target.kind === "task" && (
          <IconButton
            icon={Maximize2}
            label="Open as page"
            size="sm"
            onClick={() => {
              close();
              navigate({ name: "task", id: target.id });
            }}
          />
        )}
        {allowPin && (
          <IconButton
            icon={pinned ? PinOff : Pin}
            label={pinned ? "Unpin panel" : "Pin panel open while you work elsewhere"}
            size="sm"
            active={pinned}
            aria-pressed={pinned}
            onClick={() => useUi.getState().set({ inspectorPinned: !pinned })}
          />
        )}
        <IconButton icon={PanelRightClose} label="Close panel" shortcut={shortcuts.closeInspector} size="sm" onClick={close} />
      </div>
      <div className="inspector__body">
        {target.kind === "task" ? <TaskDetail id={target.id} onClose={close} /> : target.kind === "milestone" ? (
          <Suspense fallback={<Skeleton height={80} />}>
            <MilestoneDetail id={target.id} />
          </Suspense>
        ) : <ProjectSummary id={target.id} />}
      </div>
    </aside>
  );
}

