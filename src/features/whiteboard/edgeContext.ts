import { createContext } from "react";
import type { WbEdgeData } from "./model";

export const EdgeApiContext = createContext<{ updateEdge: (id: string, patch: Partial<WbEdgeData>) => void }>({
  updateEdge: () => undefined,
});
