import { useEffect, useRef, type RefObject } from "react";

/** Elements rendered in portals that belong to whatever opened them. */
const LAYER_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='menu']",
  ".menu",
  ".popover",
  ".dialog",
  ".dialog-overlay",
  ".capture",
  ".toasts",
  ".toast",
  ".tooltip",
].join(",");

const inLayer = (t: EventTarget | null) => t instanceof Element && !!t.closest(LAYER_SELECTOR);
/** An open menu, popover, select or dialog (tooltips don't count). */
const layerOpen = () =>
  !!document.querySelector(".dialog-overlay") ||
  Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]")).some((w) => !w.querySelector(".tooltip"));

/** Pointer travel beyond this is a drag, pan, resize or selection — not a click. */
const CLICK_SLOP = 6;

/**
 * Calls `onDismiss` for a genuine click outside `ref`.
 *
 * A press counts only when it starts and ends outside the element and every
 * portal layer, no menu/popover/dialog was open at press time (that click
 * just closes the layer), the pointer barely moved, it wasn't cancelled and
 * it didn't select text. The decision is deferred one tick and skipped if
 * `stillCurrent` reports the target changed — so clicking another item
 * replaces the panel instead of closing it.
 */
export function useOutsideDismiss(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDismiss: () => void,
  snapshot: () => unknown,
) {
  const latest = useRef({ onDismiss, snapshot });
  latest.current = { onDismiss, snapshot };

  useEffect(() => {
    if (!enabled) return;
    let press: { x: number; y: number; id: number; selection: string } | null = null;

    const down = (e: PointerEvent) => {
      press = null;
      if (e.button !== 0 || !e.isPrimary) return;
      const el = ref.current;
      if (!el || el.contains(e.target as Node) || inLayer(e.target) || layerOpen()) return;
      press = { x: e.clientX, y: e.clientY, id: e.pointerId, selection: String(window.getSelection() ?? "") };
    };
    const up = (e: PointerEvent) => {
      const p = press;
      press = null;
      if (!p || e.pointerId !== p.id) return;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) return;
      if (ref.current?.contains(e.target as Node) || inLayer(e.target)) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && String(sel) !== p.selection) return;
      const before = latest.current.snapshot();
      window.setTimeout(() => {
        if (latest.current.snapshot() === before) latest.current.onDismiss();
      }, 0);
    };
    const cancel = () => {
      press = null;
    };

    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
    };
  }, [enabled, ref]);
}
