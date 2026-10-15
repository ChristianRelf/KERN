/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// A project's sections, in display order.

import { Activity, File, Flag, GitBranch, LayoutDashboard, ListTodo, Presentation, SquareKanban, StickyNote } from "lucide-react";
import type { ProjectTab } from "@/lib/types";

export const PROJECT_TABS: { id: ProjectTab; label: string; icon: typeof ListTodo }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "board", label: "Board", icon: SquareKanban },
  { id: "whiteboard", label: "Whiteboard", icon: Presentation },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "milestones", label: "Milestones", icon: Flag },
  { id: "files", label: "Files", icon: File },
  { id: "code", label: "Code", icon: GitBranch },
  { id: "activity", label: "Activity", icon: Activity },
];
