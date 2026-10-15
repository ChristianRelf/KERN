// Notes that link here (with [[ links in the note editor).

import { Link2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/ipc";
import { relativeTime } from "@/lib/dates";
import { navigate } from "@/stores/router";

export function Backlinks({ kind, id, title = "Linked from" }: { kind: "note" | "task" | "project"; id: string; title?: string }) {
  const { data } = useQuery({ queryKey: ["backlinks", kind, id], queryFn: () => api.notes.backlinks(kind, id), staleTime: 30_000 });
  if (!data?.length) return null;
  return (
    <div className="col backlinks" style={{ gap: 2 }}>
      <div className="section-title">
        <Link2 size={13} /> {title} <span className="count">{data.length}</span>
      </div>
      {data.map((b) => (
        <button key={b.id} type="button" className="backlink" onClick={() => navigate({ name: "notes", id: b.id })}>
          <span className="backlink__title truncate">{b.title || "Untitled"}</span>
          {b.context && <span className="backlink__context">{b.context}</span>}
          <span className="faint backlink__when">{relativeTime(b.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}
