/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Opens the "New worktree" dialog from anywhere; the dialog itself (and the
// worktree manager) load only when it's used.

import { create } from "zustand";
import type { Worktree } from "@/lib/types";

export interface WorktreeDialogReq {
  projectId: string;
  repositoryId?: string;
  taskId?: string | null;
  taskTitle?: string | null;
  issueNumber?: number | null;
  /** Called with the new worktree. */
  onCreated?: (w: Worktree) => void;
}

export const useWorktreeDialog = create<{ req: WorktreeDialogReq | null }>(() => ({ req: null }));
export const openWorktreeDialog = (req: WorktreeDialogReq) => useWorktreeDialog.setState({ req });
