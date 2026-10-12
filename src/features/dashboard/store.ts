import { create } from "zustand";

/** Transient dashboard UI state (edit mode). */
export const useDashboardUi = create<{ editing: boolean; setEditing: (v: boolean) => void }>((set) => ({
  editing: false,
  setEditing: (editing) => set({ editing }),
}));
