/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// GitHub Actions for a repository: the latest run of each workflow and the
// recent runs. Fetched on open and on refresh; while something is running
// it re-checks every 30 seconds (only while the section is visible).

import { CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, Loader2, RefreshCw, Workflow } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Project, Repository, WorkflowRun } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { IconButton } from "@/components/ui/Button";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { openLink } from "@/features/links/links";
import { relativeTime } from "@/lib/dates";

export function runState(r: Pick<WorkflowRun, "status" | "conclusion">): "success" | "failure" | "running" | "neutral" {
  if (r.status !== "completed") return "running";
  if (r.conclusion === "success") return "success";
  if (["failure", "timed_out", "startup_failure", "action_required"].includes(r.conclusion ?? "")) return "failure";
  return "neutral";
}

export function RunIcon({ r, size = 14 }: { r: Pick<WorkflowRun, "status" | "conclusion">; size?: number }) {
  const s = runState(r);
  const Icon = s === "success" ? CircleCheck : s === "failure" ? CircleX : s === "running" ? Loader2 : r.conclusion === "skipped" || r.conclusion === "cancelled" ? CircleMinus : CircleDashed;
  return <Icon size={size} className={`run-icon ${s === "running" ? "spin" : ""}`} data-state={s} aria-label={r.conclusion ?? r.status} />;
}

export function useActions(projectId: string, repo: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["github", "actions", projectId, repo],
    queryFn: () => api.github.actions(projectId, repo),
    enabled: !!repo && enabled,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (q) => (q.state.data?.recent.some((r) => r.status !== "completed") ? 30_000 : false),
    refetchIntervalInBackground: false,
  });
}

export function BuildsSection({ project, repo }: { project: Project; repo: Repository }) {
  const { data, error, isFetching, refetch } = useActions(project.id, repo.github);
  if (error) return <EmptyState compact icon={Workflow}>{describeError(error, "Couldn't load workflow runs.")}</EmptyState>;
  if (!data) return <Skeleton height={80} />;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        <span className="section-title">
          Workflows <span className="count">{data.latest.length}</span>
        </span>
        <span className="spacer" />
        <IconButton icon={RefreshCw} label="Refresh" size="sm" className={isFetching ? "spin" : undefined} onClick={() => (void refetch(), invalidate("health"))} />
      </div>
      {!data.latest.length ? (
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No GitHub Actions runs for this repository.</span>
      ) : (
        <div className="col" style={{ gap: 2 }}>
          {data.latest.map((r) => (
            <RunRow key={r.id} r={r} prominent defaultBranch={data.defaultBranch} />
          ))}
        </div>
      )}
      {data.recent.length > data.latest.length && (
        <div className="col" style={{ gap: 2 }}>
          <div className="section-title">Recent runs</div>
          {data.recent.slice(0, 20).map((r) => (
            <RunRow key={r.id} r={r} defaultBranch={data.defaultBranch} />
          ))}
        </div>
      )}
    </div>
  );
}

export function RunRow({ r, prominent, defaultBranch }: { r: WorkflowRun; prominent?: boolean; defaultBranch?: string | null }) {
  return (
    <button type="button" className="run-row" onClick={() => void openLink(r.htmlUrl)}>
      <RunIcon r={r} />
      <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <span className="truncate" style={{ fontWeight: prominent ? 550 : undefined }}>
          {prominent ? r.workflow : r.title || r.workflow}
        </span>
        <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>
          {prominent ? `${r.title} · ` : `${r.workflow} · `}
          <Tooltip content={r.branch === defaultBranch ? "Default branch" : "Branch"}>
            <span>{r.branch}</span>
          </Tooltip>{" "}
          · #{r.runNumber} · {r.event} · {r.actor}
        </span>
      </span>
      <span className="faint" style={{ fontSize: "var(--fs-xs)", whiteSpace: "nowrap" }}>
        {relativeTime(Date.parse(r.createdAt))}
      </span>
      <ExternalLink size={12} className="faint" />
    </button>
  );
}
