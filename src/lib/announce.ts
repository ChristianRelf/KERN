/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Polite screen-reader announcements for actions that change layout without
// moving focus (keyboard reordering, background account switches).

let region: HTMLElement | null = null;

export function announce(message: string) {
  if (typeof document === "undefined") return;
  if (!region) {
    region = document.createElement("div");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    region.className = "sr-only";
    document.body.appendChild(region);
  }
  // Clear first so repeating the same message is still announced.
  region.textContent = "";
  window.setTimeout(() => {
    if (region) region.textContent = message;
  }, 30);
}
