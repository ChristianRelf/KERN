// Shared drag-and-drop behaviour for compact vertical lists (sidebar
// destinations, projects, groups, views, AI account priority). One feel
// everywhere: the item follows the pointer vertically, neighbours glide into
// place with a short ease (no springs), the slot being dropped into is shown
// as a faint ghost, and the list auto-scrolls near its edges.

import { GripVertical } from "lucide-react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
  PointerSensor,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
  type Announcements,
  type DropAnimation,
  type Modifier,
} from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/** Keeps dragged rows on the list's axis so they track the pointer precisely. */
export const restrictToVertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export const SORT_TRANSITION = { duration: 170, easing: "cubic-bezier(0.2, 0, 0, 1)" };

export const DROP_ANIMATION: DropAnimation = {
  duration: 150,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.35" } } }),
};

export const AUTO_SCROLL = { threshold: { x: 0, y: 0.12 }, acceleration: 8 };

/** Pointer drags start after 4px so ordinary clicks are never swallowed. */
export function useListSensors() {
  return useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
}

/** Screen-reader messages that use item names instead of internal ids. */
export function announcements(nameOf: (id: string) => string, count: () => number, indexOf: (id: string) => number): Announcements {
  return {
    onDragStart: ({ active }) => `Picked up ${nameOf(String(active.id))}.`,
    onDragOver: ({ active, over }) =>
      over ? `${nameOf(String(active.id))} is over position ${indexOf(String(over.id)) + 1} of ${count()}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `${nameOf(String(active.id))} dropped at position ${indexOf(String(over.id)) + 1} of ${count()}.` : `${nameOf(String(active.id))} dropped.`,
    onDragCancel: ({ active }) => `Moving ${nameOf(String(active.id))} was cancelled.`,
  };
}

/**
 * A sortable row. The whole row drags (after a small movement threshold);
 * an optional grip appears on hover in the left gutter so nothing shifts.
 * Alt+↑ / Alt+↓ move the row from the keyboard.
 */
export function SortableRow({
  id,
  disabled,
  handle,
  onMove,
  className = "",
  children,
}: {
  id: string;
  disabled?: boolean;
  /** Show the hover grip. */
  handle?: boolean;
  /** Keyboard reordering: -1 up, +1 down. */
  onMove?: (delta: -1 | 1) => void;
  className?: string;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled, transition: SORT_TRANSITION });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  const onKeyDown = (e: KeyboardEvent) => {
    // Independent of `disabled`: the collapsed sidebar has no pointer
    // dragging but still supports keyboard reordering.
    if (!onMove || !e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      onMove(e.key === "ArrowUp" ? -1 : 1);
    }
  };
  return (
    <div
      ref={setNodeRef}
      className={`sortable ${className}`}
      data-ghost={isDragging || undefined}
      data-draggable={!disabled || undefined}
      style={style}
      {...(disabled ? {} : listeners)}
      onKeyDown={onKeyDown}
    >
      {handle && !disabled && (
        <span className="sortable__grip" aria-hidden>
          <GripVertical />
        </span>
      )}
      {children}
    </div>
  );
}

/** Wrapper for the element rendered inside a DragOverlay. */
export function DragPreview({ children }: { children: ReactNode }) {
  return <div className="sortable-overlay">{children}</div>;
}
