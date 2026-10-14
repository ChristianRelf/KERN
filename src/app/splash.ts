/** Fades out and removes the startup splash painted by index.html. */
export function hideSplash() {
  const el = document.getElementById("splash");
  if (!el || el.dataset.hidden !== undefined) return;
  el.dataset.hidden = "";
  window.setTimeout(() => el.remove(), 200);
}
