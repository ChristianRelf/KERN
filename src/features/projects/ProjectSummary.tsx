/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ArrowUpRight, Presentation, SquareKanban } from "lucide-react";
import { useProject } from "@/hooks/data";
import { Button } from "@/components/ui/Button";
import { Progress, Skeleton } from "@/components/ui/Controls";
import { ProjectGlyph } from "./ProjectGlyph";
import { navigate } from "@/stores/router";
import { formatDue, relativeTime } from "@/lib/dates";

/** Compact project properties for the inspector. */
export function ProjectSummary({ id }: { id: string }) {
  const { data: p } = useProject(id);
  if (!p) return <Skeleton height={60} />;
  const pct = p.taskTotal ? p.taskDone / p.taskTotal : 0;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 10 }}>
        <ProjectGlyph project={p} size={22} />
        <span style={{ fontSize: "var(--fs-lg)", fontWeight: 600 }}>{p.name}</span>
      </div>
      {p.description && <p className="muted" style={{ fontSize: "var(--fs-sm)", whiteSpace: "pre-wrap" }}>{p.description}</p>}
      <div className="col" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
          <span className="muted">Progress</span>
          <span className="tabular">
            {p.taskDone}/{p.taskTotal} · {Math.round(pct * 100)}%
          </span>
        </div>
        <Progress value={pct} />
      </div>
      <div className="props">
        <span className="props__label">Overdue</span>
        <span>{p.taskOverdue}</span>
        <span className="props__label">Target</span>
        <span>{p.targetDate ? formatDue(p.targetDate) : "-"}</span>
        <span className="props__label">Last activity</span>
        <span>{p.lastActivityAt ? relativeTime(p.lastActivityAt) : "-"}</span>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Button size="sm" icon={ArrowUpRight} onClick={() => navigate({ name: "project", id })}>
          Open
        </Button>
        <Button size="sm" icon={SquareKanban} onClick={() => navigate({ name: "project", id, tab: "board" })}>
          Board
        </Button>
        <Button size="sm" icon={Presentation} onClick={() => navigate({ name: "project", id, tab: "whiteboard" })}>
          Whiteboard
        </Button>
      </div>
    </div>
  );
}
