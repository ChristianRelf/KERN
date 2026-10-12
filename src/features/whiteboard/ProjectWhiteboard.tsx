import { ChevronDown, Maximize2, Plus, Presentation } from "lucide-react";
import { useWhiteboards, useProjects } from "@/hooks/data";
import { navigate } from "@/stores/router";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { EmptyState } from "@/components/ui/Controls";
import { createWhiteboard } from "@/features/search/commands";
import { WhiteboardCanvas } from "./Canvas";
import { whiteboardMenu } from "./actions";
import { PageFallback } from "@/components/layout/PageFallback";

/** The Whiteboard tab of a project: switch between the project's boards inline. */
export default function ProjectWhiteboard({ projectId, whiteboardId }: { projectId: string; whiteboardId?: string }) {
  const { data: boards, isLoading } = useWhiteboards(projectId);
  const { data: projects } = useProjects();
  if (isLoading) return <PageFallback />;
  if (!boards?.length)
    return (
      <EmptyState icon={Presentation} title="No whiteboard yet" action={<Button icon={Plus} onClick={() => void createWhiteboard(projectId)}>Create whiteboard</Button>}>
        Plan this project visually with cards, tasks, images and connections.
      </EmptyState>
    );
  const current = boards.find((b) => b.id === whiteboardId) ?? boards[0];
  return (
    <>
      <div className="wb-switcher">
        <Dropdown
          items={[
            ...boards.map((b) => ({
              label: b.name,
              checked: b.id === current.id,
              onSelect: () => navigate({ name: "project", id: projectId, tab: "whiteboard", whiteboardId: b.id }, { replace: true }),
            })),
            { type: "separator" },
            { label: "New whiteboard…", icon: Plus, onSelect: () => void createWhiteboard(projectId) },
            { type: "separator" },
            ...whiteboardMenu(current, projects ?? []).slice(1),
          ]}
        >
          <button type="button" className="board-select">
            <Presentation />
            {current.name}
            <ChevronDown />
          </button>
        </Dropdown>
        <span className="spacer" />
        <IconButton icon={Maximize2} label="Open full screen" size="sm" onClick={() => navigate({ name: "whiteboard", id: current.id })} />
      </div>
      <WhiteboardCanvas key={current.id} id={current.id} projectId={projectId} />
    </>
  );
}
