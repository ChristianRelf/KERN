/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// Opens the AI action dialog (its code loads on first use).

import { create } from "zustand";
import type { AssistInput, AssistSuggestion } from "@/lib/types";

export interface AssistRequest {
  input: AssistInput;
  title: string;
  /** What the action does, shown above the preview. */
  intro?: string;
  /** Suggestions (breakdown, extract): what happens to the ticked ones. */
  applyLabel?: string;
  onApply?: (items: AssistSuggestion[]) => Promise<void> | void;
  /** Text results (weekly, ask): an optional action such as "Use as summary". */
  textActionLabel?: string;
  onText?: (text: string) => void;
}

export const useAssist = create<{ req: AssistRequest | null }>(() => ({ req: null }));

export function openAssist(req: AssistRequest) {
  useAssist.setState({ req });
}

export function closeAssist() {
  useAssist.setState({ req: null });
}
