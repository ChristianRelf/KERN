import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Animates rows to their new positions when list data changes (FLIP), so a
 * completed task leaving the list doesn't make its neighbours jump. Rows are
 * marked with `data-flip-id`. Positions are measured once per data change,
 * never per frame; `resetKey` re-measures without animating (e.g. after a
 * drag, which already animated the move).
 */
export function useFlip(container: RefObject<HTMLElement | null>, dataKey: unknown, resetKey?: unknown, duration = 190) {
  const tops = useRef<Map<string, number> | null>(null);
  const keys = useRef<{ data: unknown; reset: unknown }>({ data: dataKey, reset: resetKey });

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const animate = keys.current.data !== dataKey && keys.current.reset === resetKey;
    keys.current = { data: dataKey, reset: resetKey };
    const base = el.getBoundingClientRect().top - el.scrollTop;
    const next = new Map<string, number>();
    const rows = el.querySelectorAll<HTMLElement>("[data-flip-id]");
    const motion = document.documentElement.dataset.motion;
    const enabled = animate && tops.current && motion !== "off" && motion !== "reduced" && rows.length <= 400;
    rows.forEach((row) => {
      const id = row.dataset.flipId!;
      const top = row.getBoundingClientRect().top - base;
      next.set(id, top);
      const prev = enabled ? tops.current!.get(id) : undefined;
      if (prev !== undefined && Math.abs(prev - top) > 1) {
        row.animate([{ transform: `translateY(${prev - top}px)` }, { transform: "translateY(0)" }], {
          duration,
          easing: "cubic-bezier(0.2, 0, 0, 1)",
        });
      }
    });
    tops.current = next;
  }, [container, dataKey, resetKey, duration]);
}
