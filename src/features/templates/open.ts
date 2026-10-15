/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

import { create } from "zustand";
import { useUi } from "@/stores/ui";

export type TemplateRequest =
  | { mode: "save-project"; projectId: string; name: string }
  | { mode: "pick"; kind: "note" | "task"; projectId?: string | null };

export const useTemplateDialogs = create<{ req: TemplateRequest | null; /** Preselected in the next "New project" dialog. */ projectTemplate: string | null }>(() => ({ req: null, projectTemplate: null }));

/** Opens "New project" with a template already chosen. */
export function newProjectFromTemplate(templateId: string) {
  useTemplateDialogs.setState({ projectTemplate: templateId });
  useUi.getState().set({ createProjectOpen: true });
}

export const openSaveProjectTemplate = (projectId: string, name: string) => useTemplateDialogs.setState({ req: { mode: "save-project", projectId, name } });

/** Picks a note or task template and creates one from it. */
export const openTemplatePicker = (kind: "note" | "task", projectId?: string | null) => useTemplateDialogs.setState({ req: { mode: "pick", kind, projectId } });
