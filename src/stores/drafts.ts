// Text edits whose save failed. Kept in memory (not persisted) so closing a
// panel or a failed write never silently discards what the user typed; the
// editor restores the draft and offers to retry.

import { create } from "zustand";

type Field = "title" | "description";
type Drafts = Record<string, Partial<Record<Field, string>>>;

export const useDrafts = create<{ drafts: Drafts }>(() => ({ drafts: {} }));

export function setDraft(id: string, field: Field, value: string) {
  useDrafts.setState((s) => ({ drafts: { ...s.drafts, [id]: { ...s.drafts[id], [field]: value } } }));
}

export function clearDraft(id: string, field: Field) {
  useDrafts.setState((s) => {
    const cur = { ...s.drafts[id] };
    delete cur[field];
    const next = { ...s.drafts };
    if (Object.keys(cur).length) next[id] = cur;
    else delete next[id];
    return { drafts: next };
  });
}

export const getDraft = (id: string, field: Field) => useDrafts.getState().drafts[id]?.[field];
