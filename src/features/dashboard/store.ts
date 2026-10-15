/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { create } from "zustand";

/** Transient dashboard UI state (edit mode). */
export const useDashboardUi = create<{ editing: boolean; setEditing: (v: boolean) => void }>((set) => ({
  editing: false,
  setEditing: (editing) => set({ editing }),
}));
