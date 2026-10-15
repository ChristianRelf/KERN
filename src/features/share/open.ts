import { create } from "zustand";
import type { ShareKind } from "@/lib/types";

export interface ShareRequest {
  kind: ShareKind;
  refId: string;
  title: string;
  /** Whiteboards: renders the current board as an image. */
  render?: () => Promise<{ base64: string; mime: string; width: number; height: number; objects: number } | null>;
}

export const useShare = create<{ req: ShareRequest | null }>(() => ({ req: null }));

/** Opens the share-link dialog for a note, whiteboard or project. */
export function openShare(req: ShareRequest) {
  useShare.setState({ req });
}
