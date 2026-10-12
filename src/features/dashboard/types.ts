import type { LucideIcon } from "lucide-react";
import type { FC } from "react";

// Widget configs are JSON documents persisted with the dashboard layout.
export type WidgetConfig = Record<string, unknown>;

export interface WidgetProps<C extends WidgetConfig = WidgetConfig> {
  id: string;
  config: C;
  setConfig: (patch: Partial<C>) => void;
  size: { w: number; h: number };
  editing: boolean;
}

export interface WidgetDef<C extends WidgetConfig = WidgetConfig> {
  type: string;
  name: string;
  description: string;
  icon: LucideIcon;
  defaultConfig: C;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
  Component: FC<WidgetProps<C>>;
  Config?: FC<{ config: C; setConfig: (patch: Partial<C>) => void }>;
  /** Title shown in the header (defaults to config.title or name). */
  title?: (config: C) => string;
  /** Extra header controls (outside edit mode). */
  HeaderActions?: FC<WidgetProps<C>>;
  flush?: boolean;
  /** Only one instance is useful (e.g. focus timer). */
  single?: boolean;
}
