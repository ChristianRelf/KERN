// Transient UI state (not persisted).

import { create } from "zustand";
import type { TaskStatus } from "@/lib/types";

export type InspectorTarget =
  | { kind: "task"; id: string }
  | { kind: "project"; id: string }
  | null;

export type CaptureMode = "task" | "note" | "idea";

/** Where a new task is being created from; becomes its defaults. */
export interface ComposerContext {
  projectId?: string | null;
  columnId?: string | null;
  status?: TaskStatus;
  dueDate?: string | null;
  labelIds?: string[];
  parentId?: string | null;
  title?: string;
}

interface UiState {
  inspector: InspectorTarget;
  /** Task detail shown in a modal (detail mode "modal"). */
  modalTaskId: string | null;
  paletteOpen: boolean;
  paletteQuery: string;
  capture: { open: boolean; mode: CaptureMode; projectId?: string | null; dueDate?: string | null; text?: string };
  createProjectOpen: boolean;
  /** Full task composer (modal). */
  composer: { open: boolean; ctx: ComposerContext };
  /** Keeps the inspector open while working elsewhere. */
  inspectorPinned: boolean;
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
  openComposer: (ctx?: ComposerContext) => void;
  closeComposer: () => void;
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
  composer: { open: false, ctx: {} },
  inspectorPinned: false,
  shortcutsOpen: false,
  briefingPrompt: null,
  selectedTaskIds: [],
  selectionAnchor: null,
  openInspector: (t) => set({ inspector: t }),
  closeInspector: () => set({ inspector: null, inspectorPinned: false }),
  setPalette: (open, query = "") => set({ paletteOpen: open, paletteQuery: query }),
  openCapture: (mode = "task", opts) =>
    set({ capture: { open: true, mode, projectId: opts?.projectId ?? null, dueDate: opts?.dueDate ?? null, text: opts?.text ?? "" } }),
  closeCapture: () => set((s) => ({ capture: { ...s.capture, open: false } })),
  openComposer: (ctx = {}) => set({ composer: { open: true, ctx } }),
  closeComposer: () => set((s) => ({ composer: { ...s.composer, open: false } })),
  setSelection: (ids, anchor) => set((s) => ({ selectedTaskIds: ids, selectionAnchor: anchor === undefined ? s.selectionAnchor : anchor })),
  clearSelection: () => set({ selectedTaskIds: [], selectionAnchor: null }),
  set: (p) => set(p),
}));
