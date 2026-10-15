/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { createContext } from "react";
import type { WbEdgeData } from "./model";

export const EdgeApiContext = createContext<{
  updateEdge: (id: string, patch: Partial<WbEdgeData>) => void;
  /** The connector whose label is being edited (double-click or "Add label"). */
  editingId: string | null;
  setEditingId: (id: string | null) => void;
}>({
  updateEdge: () => undefined,
  editingId: null,
  setEditingId: () => undefined,
});
