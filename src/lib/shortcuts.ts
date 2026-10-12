// Keyboard shortcut registry: defaults, user overrides, matching,
// formatting and conflict detection. "Mod" is Ctrl on Windows/Linux and
// Cmd on macOS.

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

export interface ShortcutDef {
  id: string;
  label: string;
  group: "General" | "Navigation" | "Tasks" | "Whiteboard" | "Lists";
  default: string | null;
  /** Fires even while typing in a text field. */
  global?: boolean;
  /** Fixed (contextual) shortcuts are documented but not remappable. */
  fixed?: boolean;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "palette", label: "Command palette", group: "General", default: "Mod+K", global: true },
  { id: "quickCapture", label: "Quick capture", group: "General", default: "Mod+Shift+Space", global: true },
  { id: "newTask", label: "New task", group: "General", default: "Mod+Shift+N", global: true },
  { id: "newNote", label: "New note", group: "General", default: "Mod+Alt+N" },
  { id: "newProject", label: "New project", group: "General", default: "Mod+Shift+P" },
  { id: "toggleSidebar", label: "Toggle sidebar", group: "General", default: "Mod+\\" },
  { id: "closeInspector", label: "Close details panel", group: "General", default: "Mod+Shift+\\" },
  { id: "focusMode", label: "Focus mode", group: "General", default: "Mod+Shift+F" },
  { id: "rundown", label: "Daily rundown", group: "General", default: "Mod+Shift+D" },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "General", default: "Mod+/" },
  { id: "undo", label: "Undo last action", group: "General", default: "Mod+Z" },
  { id: "toggleTerminal", label: "Toggle terminal", group: "General", default: "Mod+`", global: true },
  { id: "resumeWork", label: "Resume work", group: "General", default: "Mod+Shift+R" },
  { id: "goDashboard", label: "Go to Dashboard", group: "Navigation", default: "Mod+1" },
  { id: "goTasks", label: "Go to My Tasks", group: "Navigation", default: "Mod+2" },
  { id: "goInbox", label: "Go to Inbox", group: "Navigation", default: "Mod+3" },
  { id: "goProjects", label: "Go to Projects", group: "Navigation", default: "Mod+4" },
  { id: "goWhiteboards", label: "Go to Whiteboards", group: "Navigation", default: "Mod+5" },
  { id: "goNotes", label: "Go to Notes", group: "Navigation", default: "Mod+6" },
  { id: "goSettings", label: "Open settings", group: "Navigation", default: "Mod+," },
  { id: "back", label: "Back", group: "Navigation", default: "Alt+ArrowLeft" },
  { id: "forward", label: "Forward", group: "Navigation", default: "Alt+ArrowRight" },
  // Contextual, fixed
  { id: "list.move", label: "Move between tasks", group: "Lists", default: "ArrowUp / ArrowDown", fixed: true },
  { id: "list.extend", label: "Extend selection", group: "Lists", default: "Shift+ArrowDown", fixed: true },
  { id: "list.open", label: "Open task", group: "Lists", default: "Enter", fixed: true },
  { id: "list.complete", label: "Complete task", group: "Lists", default: "Space", fixed: true },
  { id: "list.select", label: "Toggle selection", group: "Lists", default: "X", fixed: true },
  { id: "list.selectAll", label: "Select all", group: "Lists", default: "Mod+A", fixed: true },
  { id: "list.priority", label: "Set priority", group: "Lists", default: "0 – 4", fixed: true },
  { id: "list.today", label: "Due today", group: "Lists", default: "T", fixed: true },
  { id: "list.tomorrow", label: "Due tomorrow", group: "Lists", default: "M", fixed: true },
  { id: "list.delete", label: "Move to trash", group: "Lists", default: "Delete", fixed: true },
  { id: "list.duplicate", label: "Duplicate", group: "Lists", default: "Mod+D", fixed: true },
  { id: "wb.select", label: "Select tool", group: "Whiteboard", default: "V", fixed: true },
  { id: "wb.hand", label: "Hand tool", group: "Whiteboard", default: "H", fixed: true },
  { id: "wb.text", label: "Text card", group: "Whiteboard", default: "T", fixed: true },
  { id: "wb.sticky", label: "Sticky note", group: "Whiteboard", default: "S", fixed: true },
  { id: "wb.shape", label: "Shape", group: "Whiteboard", default: "R", fixed: true },
  { id: "wb.connector", label: "Connector", group: "Whiteboard", default: "C", fixed: true },
  { id: "wb.task", label: "Task card", group: "Whiteboard", default: "K", fixed: true },
  { id: "wb.area", label: "Area", group: "Whiteboard", default: "A", fixed: true },
  { id: "wb.group", label: "Group selection", group: "Whiteboard", default: "Mod+G", fixed: true },
  { id: "wb.ungroup", label: "Ungroup", group: "Whiteboard", default: "Mod+Shift+G", fixed: true },
  { id: "wb.undo", label: "Undo / Redo", group: "Whiteboard", default: "Mod+Z / Mod+Y", fixed: true },
  { id: "wb.fit", label: "Fit to content", group: "Whiteboard", default: "Shift+1", fixed: true },
  { id: "wb.duplicate", label: "Duplicate", group: "Whiteboard", default: "Mod+D", fixed: true },
];

/** Text-editing shortcuts that custom bindings may never take over. */
export const RESERVED = new Set([
  "Mod+C",
  "Mod+V",
  "Mod+X",
  "Mod+A",
  "Mod+Y",
  "Mod+Shift+Z",
  "Mod+B",
  "Mod+I",
  "Mod+U",
  "Mod+Backspace",
  "Mod+Delete",
  "Mod+ArrowLeft",
  "Mod+ArrowRight",
  "Mod+Shift+ArrowLeft",
  "Mod+Shift+ArrowRight",
  "Mod+Home",
  "Mod+End",
  "Mod+F4",
  "Alt+F4",
  "Enter",
  "Escape",
  "Tab",
  "Shift+Tab",
  "Backspace",
  "Delete",
  "Space",
]);

const KEY_NAMES: Record<string, string> = {
  " ": "Space",
  Spacebar: "Space",
  Esc: "Escape",
  "+": "Plus",
};

/** Canonical combo for a keyboard event, e.g. "Mod+Shift+N". */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  let key = e.key;
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"].includes(key)) return null;
  key = KEY_NAMES[key] ?? key;
  // Use the physical key for letters/digits so Shift/Alt don't change it.
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (code === "Backslash") key = "\\";
  else if (code === "Slash") key = "/";
  else if (code === "Comma") key = ",";
  else if (code === "Period") key = ".";
  else if (code === "Backquote") key = "`";
  else if (code === "Space") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

export function resolveBindings(overrides: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of SHORTCUTS) out[s.id] = s.id in overrides && !s.fixed ? overrides[s.id] : s.default;
  return out;
}

export function findConflict(
  id: string,
  combo: string,
  bindings: Record<string, string | null>,
): { reserved: boolean; conflictWith?: ShortcutDef } {
  if (RESERVED.has(combo)) return { reserved: true };
  const other = SHORTCUTS.find((s) => s.id !== id && !s.fixed && bindings[s.id] === combo);
  return { reserved: false, conflictWith: other };
}

/** Display parts for a combo, e.g. ["Ctrl", "Shift", "N"]. */
export function comboParts(combo: string | null | undefined): string[] {
  if (!combo) return [];
  return combo.split("+").map((p) => {
    if (p === "Mod") return isMac ? "⌘" : "Ctrl";
    if (p === "Alt") return isMac ? "⌥" : "Alt";
    if (p === "Shift") return isMac ? "⇧" : "Shift";
    if (p === "ArrowLeft") return "←";
    if (p === "ArrowRight") return "→";
    if (p === "ArrowUp") return "↑";
    if (p === "ArrowDown") return "↓";
    if (p === "Escape") return "Esc";
    if (p === "Delete") return "Del";
    return p;
  });
}

export function formatCombo(combo: string | null | undefined): string {
  return comboParts(combo).join(isMac ? "" : "+");
}

export function isTextInput(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color"].includes(type);
  }
  return false;
}
