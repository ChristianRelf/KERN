import { Pin, Plus, Presentation, Upload } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Whiteboard } from "@/lib/types";
import { useProjectMap, useProjects, useWhiteboards } from "@/hooks/data";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { navigate } from "@/stores/router";
import { toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { ContextMenu } from "@/components/ui/Menu";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { createWhiteboard } from "@/features/search/commands";
import { WhiteboardThumb } from "@/features/dashboard/widgets/ProjectWidgets";
import { whiteboardMenu } from "./actions";
import { relativeTime } from "@/lib/dates";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import "./whiteboard.css";

function Thumb({ w }: { w: Whiteboard }) {
  // Static SVG previews; no canvas is initialised on this page.
  const { data } = useQuery({ queryKey: ["whiteboard", "preview", w.id], queryFn: () => api.whiteboards.preview(w.id), staleTime: 60_000 });
  return data ? <WhiteboardThumb scene={data} /> : <Skeleton height={130} />;
}

export default function WhiteboardsPage() {
  const { data: boards, isLoading } = useWhiteboards();
  const { data: projects } = useProjects();
  const projectMap = useProjectMap();
  const importJson = async () => {
    const f = await openDialog({ filters: [{ name: "Whiteboard JSON", extensions: ["json"] }] });
    if (typeof f !== "string") return;
    try {
      const doc = JSON.parse(await api.system.readText(f));
      const w = await api.whiteboards.import(doc);
      invalidate("whiteboards");
      navigate({ name: "whiteboard", id: w.id });
    } catch (e) {
      toastError(describeError(e, "That file isn't a whiteboard export."));
    }
  };
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <Presentation /> Whiteboards
        </h1>
        <div className="page-header__actions">
          <IconButton icon={Upload} label="Import whiteboard JSON" onClick={() => void importJson()} />
          <Button size="sm" variant="primary" icon={Plus} onClick={() => void createWhiteboard()}>
            New whiteboard
          </Button>
        </div>
      </header>
      <div className="page-body page-body--pad">
        {isLoading && <Skeleton height={180} />}
        {!isLoading && !boards?.length && (
          <EmptyState icon={Presentation} title="No whiteboards yet" action={<Button icon={Plus} onClick={() => void createWhiteboard()}>Create a whiteboard</Button>}>
            An open canvas for planning: cards, tasks, images and connections.
          </EmptyState>
        )}
        <div className="project-grid">
          {boards?.map((w) => {
            const p = w.projectId ? projectMap.get(w.projectId) : undefined;
            return (
              <ContextMenu key={w.id} items={() => whiteboardMenu(w, projects ?? [])}>
                <button type="button" className="wb-thumb-card" onClick={() => navigate({ name: "whiteboard", id: w.id })}>
                  <div className="wb-thumb-card__img">
                    <Thumb w={w} />
                  </div>
                  <div className="wb-thumb-card__foot">
                    <span className="row" style={{ gap: 6, fontWeight: 600 }}>
                      {w.pinned && <Pin size={12} className="faint" />}
                      <span className="truncate">{w.name}</span>
                    </span>
                    <span className="row faint" style={{ gap: 6, fontSize: "var(--fs-xs)" }}>
                      {p && (
                        <>
                          <ProjectGlyph project={p} size={11} /> {p.name} ·
                        </>
                      )}
                      {w.nodeCount} object{w.nodeCount === 1 ? "" : "s"} · {relativeTime(w.updatedAt)}
                    </span>
                  </div>
                </button>
              </ContextMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}
