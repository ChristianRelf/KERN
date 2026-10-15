/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { useUi } from "@/stores/ui";

/** Opens the catch-up dialog for a project (the dialog itself loads lazily). */
export function openCatchup(projectId: string) {
  useUi.getState().set({ catchupProjectId: projectId });
}
