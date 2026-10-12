// Dashboard layout templates. "Daily" is the default home.

import type { GridItem, GridLayouts, WidgetInstance } from "@/lib/types";
import { WIDGET_MAP } from "./registry";

type Slot = { type: string; x: number; y: number; w: number; h: number; config?: Record<string, unknown> };

export interface Template {
  id: string;
  name: string;
  description: string;
  slots: Slot[];
}

export const TEMPLATES: Template[] = [
  {
    id: "daily",
    name: "Daily",
    description: "Rundown, today's tasks, projects, upcoming, notes and focus.",
    slots: [
      { type: "rundown", x: 0, y: 0, w: 6, h: 9 },
      { type: "today", x: 6, y: 0, w: 6, h: 9 },
      { type: "projects", x: 0, y: 9, w: 4, h: 7 },
      { type: "upcoming", x: 4, y: 9, w: 4, h: 7 },
      { type: "focus", x: 8, y: 9, w: 4, h: 4 },
      { type: "sticky", x: 8, y: 13, w: 4, h: 3, config: { title: "Quick Notes", text: "" } },
    ],
  },
  {
    id: "projects",
    name: "Projects",
    description: "Progress across projects with deadlines and a whiteboard.",
    slots: [
      { type: "projects", x: 0, y: 0, w: 5, h: 10, config: { mode: "all", projectIds: [], max: 8, showStats: true } },
      { type: "upcoming", x: 5, y: 0, w: 4, h: 10, config: { days: 14, max: 14, showProject: true } },
      { type: "progress", x: 9, y: 0, w: 3, h: 5 },
      { type: "recent", x: 9, y: 5, w: 3, h: 5 },
      { type: "whiteboard", x: 0, y: 10, w: 6, h: 7 },
      { type: "tasklist", x: 6, y: 10, w: 6, h: 7 },
    ],
  },
  {
    id: "focus",
    name: "Focus",
    description: "Timer, today's list and a scratchpad. Nothing else.",
    slots: [
      { type: "focus", x: 0, y: 0, w: 4, h: 5 },
      { type: "today", x: 4, y: 0, w: 8, h: 10, config: { includeOverdue: true, showCompleted: false, max: 20, showAdd: true, sort: "manual" } },
      { type: "sticky", x: 0, y: 5, w: 4, h: 5, config: { title: "Scratchpad", text: "" } },
    ],
  },
  {
    id: "planning",
    name: "Planning",
    description: "Calendar, upcoming deadlines, weekly activity and capture.",
    slots: [
      { type: "calendar", x: 0, y: 0, w: 4, h: 10 },
      { type: "upcoming", x: 4, y: 0, w: 4, h: 10, config: { days: 30, max: 20, showProject: true } },
      { type: "weekly", x: 8, y: 0, w: 4, h: 4 },
      { type: "capture", x: 8, y: 4, w: 4, h: 3 },
      { type: "bookmarks", x: 8, y: 7, w: 4, h: 3 },
    ],
  },
  { id: "blank", name: "Blank", description: "Start from nothing.", slots: [] },
];

export const newWidgetId = () => `w_${crypto.randomUUID().slice(0, 8)}`;

/** Derives smaller-breakpoint layouts by stacking widgets in reading order. */
export function deriveLayouts(lg: GridItem[]): GridLayouts {
  const order = [...lg].sort((a, b) => a.y - b.y || a.x - b.x);
  const stack = (cols: number) => {
    let y = 0;
    let row: GridItem[] = [];
    let rowX = 0;
    const out: GridItem[] = [];
    for (const item of order) {
      const w = Math.min(cols, Math.max(item.minW ?? 1, Math.round((item.w / 12) * cols)));
      if (rowX + w > cols) {
        y += Math.max(...row.map((r) => r.h));
        row = [];
        rowX = 0;
      }
      const placed = { ...item, x: rowX, y, w };
      out.push(placed);
      row.push(placed);
      rowX += w;
    }
    return out;
  };
  return { lg, md: stack(8), sm: stack(4).map((i) => ({ ...i, x: 0, w: 4 })) };
}

export function buildTemplate(t: Template): { widgets: WidgetInstance[]; layouts: GridLayouts } {
  const widgets: WidgetInstance[] = [];
  const lg: GridItem[] = [];
  for (const s of t.slots) {
    const def = WIDGET_MAP.get(s.type);
    if (!def) continue;
    const id = newWidgetId();
    widgets.push({ id, type: s.type, config: { ...def.defaultConfig, ...(s.config ?? {}) } });
    lg.push({ i: id, x: s.x, y: s.y, w: s.w, h: s.h, minW: def.minSize.w, minH: def.minSize.h });
  }
  return { widgets, layouts: deriveLayouts(lg) };
}
