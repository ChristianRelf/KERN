import { createContext, useContext } from "react";
import type { Project, ProjectCapabilities } from "@/lib/types";

/** The project a Command Centre widget belongs to. */
export interface ProjectCtx {
  project: Project;
  caps: ProjectCapabilities | undefined;
}

export const ProjectWidgetContext = createContext<ProjectCtx | null>(null);

export function useProjectWidget(): ProjectCtx {
  const ctx = useContext(ProjectWidgetContext);
  if (!ctx) throw new Error("Project widget rendered outside the Command Centre");
  return ctx;
}
