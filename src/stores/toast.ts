/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { create } from "zustand";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
  action?: { label: string; run: () => void };
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id" | "duration" | "tone"> & Partial<Pick<Toast, "duration" | "tone">>) => number;
  dismiss: (id: number) => void;
}

let seq = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = seq++;
    const toast: Toast = { tone: "info", duration: t.action ? 6000 : 3500, ...t, id };
    // A repeat of the same message (e.g. completing several tasks) replaces
    // the older toast instead of stacking; Ctrl+Z still undoes each in turn.
    const rest = toast.tone === "error" ? get().toasts : get().toasts.filter((x) => x.tone === "error" || x.message !== toast.message);
    set({ toasts: [...rest.slice(-3), toast] });
    if (toast.duration > 0) window.setTimeout(() => get().dismiss(id), toast.duration);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (message: string, opts?: Partial<Omit<Toast, "id" | "message">>) =>
  useToasts.getState().push({ message, ...opts });

export const toastError = (message: string, retry?: () => void) =>
  useToasts.getState().push({
    message,
    tone: "error",
    duration: retry ? 8000 : 5000,
    action: retry ? { label: "Retry", run: retry } : undefined,
  });
