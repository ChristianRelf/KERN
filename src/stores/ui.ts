// Transient UI state (not persisted).

import { create } from "zustand";

export type InspectorTarget =
  | { kind: "task"; id: string }
  | { kind: "project"; id: string }
  | null;

export type CaptureMode = "task" | "note" | "idea";

interface UiState {
  inspector: InspectorTarget;
  /** Task detail shown in a modal (detail mode "modal"). */
  modalTaskId: string | null;
  paletteOpen: boolean;
  paletteQuery: string;
  capture: { open: boolean; mode: CaptureMode; projectId?: string | null; dueDate?: string | null; text?: string };
  createProjectOpen: boolean;
  shortcutsOpen: boolean;
  briefingPrompt: "morning" | "evening" | null;
  /** Multi-selection within the active task list. */
  selectedTaskIds: string[];
  selectionAnchor: string | null;
  openInspector: (t: InspectorTarget) => void;
  closeInspector: () => void;
  setPalette: (open: boolean, query?: string) => void;
  openCapture: (mode?: CaptureMode, opts?: { projectId?: string | null; dueDate?: string | null; text?: string }) => void;
  closeCapture: () => void;
  setSelection: (ids: string[], anchor?: string | null) => void;
  clearSelection: () => void;
  set: (p: Partial<UiState>) => void;
}

export const useUi = create<UiState>((set) => ({
  inspector: null,
  modalTaskId: null,
  paletteOpen: false,
  paletteQuery: "",
  capture: { open: false, mode: "task" },
  createProjectOpen: false,
  shortcutsOpen: false,
  briefingPrompt: null,
  selectedTaskIds: [],
  selectionAnchor: null,
  openInspector: (t) => set({ inspector: t }),
  closeInspector: () => set({ inspector: null }),
  setPalette: (open, query = "") => set({ paletteOpen: open, paletteQuery: query }),
  openCapture: (mode = "task", opts) =>
    set({ capture: { open: true, mode, projectId: opts?.projectId ?? null, dueDate: opts?.dueDate ?? null, text: opts?.text ?? "" } }),
  closeCapture: () => set((s) => ({ capture: { ...s.capture, open: false } })),
  setSelection: (ids, anchor) => set((s) => ({ selectedTaskIds: ids, selectionAnchor: anchor === undefined ? s.selectionAnchor : anchor })),
  clearSelection: () => set({ selectedTaskIds: [], selectionAnchor: null }),
  set: (p) => set(p),
}));
