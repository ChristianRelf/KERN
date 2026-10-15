/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// App-wide undo for reversible actions (completion, moves, reorders,
// rescheduling, deletion to trash). Each entry knows how to revert itself;
// the toast offers an Undo button and Ctrl+Z pops the latest entry.

import { create } from "zustand";
import { toast, toastError, useToasts } from "./toast";
import { describeError } from "@/lib/ipc";

interface UndoEntry {
  label: string;
  undo: () => Promise<void> | void;
  toastId?: number;
}

interface UndoState {
  stack: UndoEntry[];
  push: (label: string, undo: UndoEntry["undo"], opts?: { silent?: boolean }) => void;
  undoLast: () => Promise<boolean>;
}

export const useUndo = create<UndoState>((set, get) => ({
  stack: [],
  push: (label, undo, opts) => {
    const entry: UndoEntry = { label, undo };
    if (!opts?.silent) {
      entry.toastId = toast(label, {
        action: {
          label: "Undo",
          run: () => {
            void runEntry(entry);
          },
        },
      });
    }
    set({ stack: [...get().stack.slice(-29), entry] });
  },
  undoLast: async () => {
    const stack = get().stack;
    const last = stack[stack.length - 1];
    if (!last) return false;
    await runEntry(last);
    return true;
  },
}));

async function runEntry(entry: UndoEntry) {
  const { stack } = useUndo.getState();
  if (!stack.includes(entry)) return; // already undone
  useUndo.setState({ stack: stack.filter((e) => e !== entry) });
  if (entry.toastId) useToasts.getState().dismiss(entry.toastId);
  try {
    await entry.undo();
  } catch (e) {
    toastError(describeError(e, "Couldn't undo that."));
  }
}

export const pushUndo = (label: string, undo: UndoEntry["undo"], opts?: { silent?: boolean }) =>
  useUndo.getState().push(label, undo, opts);
