// Task inspector → Development (collapsible, only when relevant): linked
// repositories, branches, worktrees, pull requests and commits, the linked
// GitHub issue and time worked. Pull requests matched by branch name are
// labelled as inferred. Completing a task never commits, pushes, merges or
// removes anything; follow-ups here are suggestions the user can act on.

import { ChevronRight, CircleCheck, CircleDashed, CircleX, ExternalLink, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, Hourglass, Plus, TerminalSquare, X } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DevLink, Task } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { prompt } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { formatDuration, relativeTime } from "@/lib/dates";
import { openLink } from "@/features/links/links";
import { GithubMark } from "@/features/github/shared";
import { openTerminal } from "@/features/terminal/store";
import { useRepos, useTaskDevContext } from "./hooks";

const ICON: Record<DevLink["kind"], typeof GitBranch> = { repository: FolderGit2, branch: GitBranch, worktree: FolderGit2, pull: GitPullRequest, commit: GitCommitHorizontal };

const refresh = () => invalidate("devlinks", "task", "tasks");

export function TaskDevSection({ task }: { task: Task }) {
  const { data: repos } = useRepos(task.projectId, !!task.projectId);
  const relevant = !!task.issue || (task.devLinks?.length ?? 0) > 0 || (repos?.length ?? 0) > 0;
  const [open, setOpen] = useState(() => (task.devLinks?.length ?? 0) > 0 || !!task.issue);
  const { data: ctx } = useTaskDevContext(task.id, relevant && open);
  if (!relevant) return null;
  const count = (task.devLinks?.length ?? 0) + (task.issue ? 1 : 0);
  const repoOf = (id: string | null) => repos?.find((r) => r.id === id);

  const addLink = async (kind: "branch" | "pull" | "commit") => {
    const repo = repos?.find((r) => r.isPrimary) ?? repos?.[0];
    const ref = await prompt({ title: kind === "branch" ? "Link a branch" : kind === "pull" ? "Link a pull request" : "Link a commit", placeholder: kind === "branch" ? "feature/name" : kind === "pull" ? "#123" : "commit hash", confirmLabel: "Link" });
    if (!ref) return;
    const clean = ref.trim().replace(/^#/, "");
    const url = repo?.github ? (kind === "pull" ? `https://github.com/${repo.github}/pull/${clean}` : kind === "commit" ? `https://github.com/${repo.github}/commit/${clean}` : null) : null;
    try {
      await api.devLinks.add({ taskId: task.id, kind, repositoryId: repo?.id ?? null, ref: clean, url });
      refresh();
    } catch (e) {
      toastError(describeError(e));
    }
  };

  const done = task.status === "completed";
  const branchLinks = (ctx?.links ?? []).filter((l) => l.kind === "branch");
  const worktreeLinks = (ctx?.links ?? []).filter((l) => l.kind === "worktree");
  const noPull = done && branchLinks.length > 0 && !(ctx?.pulls.length ?? 0);

  return (
    <div className="col dev-section" style={{ gap: 4 }}>
      <button type="button" className="section-title section-title--toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform var(--t-hover) var(--ease)" }} />
        Development
        {count > 0 && <span className="count">{count}</span>}
        {ctx && ctx.sessionSeconds > 0 && (
          <span className="faint row" style={{ gap: 4, fontWeight: 400 }}>
            <Hourglass size={11} /> {formatDuration(ctx.sessionSeconds)}
          </span>
        )}
      </button>
      {open && (
        <div className="col" style={{ gap: 2 }}>
          {!ctx ? (
            <Skeleton height={30} />
          ) : (
            <>
              {task.issue && (
                <button type="button" className="dev-link" onClick={() => void openLink(task.issue!.url)}>
                  <GithubMark size={13} />
                  <span className="truncate grow">
                    {task.issue.repo}#{task.issue.number}
                  </span>
                  <span className="faint">synced issue</span>
                </button>
              )}
              {ctx.links.map((l) => (
                <LinkRow key={l.id} l={l} repoName={repoOf(l.repositoryId)?.name ?? l.repositoryName} projectId={task.projectId} github={repoOf(l.repositoryId)?.github ?? null} />
              ))}
              {ctx.pulls.map((p) => (
                <button key={`${p.repository}${p.number}`} type="button" className="dev-link" onClick={() => void openLink(p.url)}>
                  <GitPullRequest size={13} />
                  <span className="truncate grow">
                    #{p.number} {p.title}
                  </span>
                  <Tooltip content={p.checks === "success" ? "Checks passed" : p.checks === "failure" ? "Checks failed" : p.checks === "pending" ? "Checks running" : "No checks"}>
                    <span className="run-icon" data-state={p.checks === "success" ? "success" : p.checks === "failure" ? "failure" : "neutral"}>
                      {p.checks === "success" ? <CircleCheck size={12} /> : p.checks === "failure" ? <CircleX size={12} /> : <CircleDashed size={12} />}
                    </span>
                  </Tooltip>
                  {p.inferred && (
                    <Tooltip content="Matched by branch name or issue reference, not linked explicitly">
                      <span className="chip">inferred</span>
                    </Tooltip>
                  )}
                </button>
              ))}
              {branchLinks.map((l) => {
                const r = repoOf(l.repositoryId);
                return r && r.localStatus === "ok" && r.trust === "trusted" ? <BranchCommits key={`c${l.id}`} repoId={r.id} branch={l.ref} github={r.github} /> : null;
              })}
              {noPull && (
                <div className="dev-hint">
                  <span className="grow">This task is done; its branch has no pull request{branchLinks[0] ? ` (${branchLinks[0].ref})` : ""}.</span>
                  {repoOf(branchLinks[0].repositoryId)?.github && (
                    <button type="button" className="mini-more" onClick={() => void openLink(`https://github.com/${repoOf(branchLinks[0].repositoryId)!.github}/compare/${encodeURIComponent(branchLinks[0].ref)}?expand=1`)}>
                      Open a pull request
                    </button>
                  )}
                </div>
              )}
              {done && worktreeLinks.length > 0 && (
                <div className="dev-hint">
                  <span className="grow">Its worktree is still on disk. Remove it from Code → Worktrees when you're finished.</span>
                </div>
              )}
              {!ctx.links.length && !ctx.pulls.length && !task.issue && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Nothing linked. Use Start work to create a branch or worktree.</span>}
              <Dropdown
                align="start"
                items={[
                  { label: "Branch…", icon: GitBranch, onSelect: () => void addLink("branch") },
                  { label: "Pull request…", icon: GitPullRequest, onSelect: () => void addLink("pull") },
                  { label: "Commit…", icon: GitCommitHorizontal, onSelect: () => void addLink("commit") },
                ]}
              >
                <button type="button" className="mini-more" style={{ alignSelf: "flex-start" }}>
                  <Plus size={12} /> Link
                </button>
              </Dropdown>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LinkRow({ l, repoName, projectId, github }: { l: DevLink; repoName: string | null | undefined; projectId: string | null; github: string | null }) {
  const Icon = ICON[l.kind];
  const url = l.url ?? (github && l.kind === "branch" ? `https://github.com/${github}/tree/${encodeURIComponent(l.ref)}` : null);
  const label = l.kind === "worktree" ? l.ref.split(/[\\/]/).pop() : l.kind === "pull" ? `#${l.ref}` : l.kind === "commit" ? l.ref.slice(0, 10) : l.ref || repoName;
  return (
    <div className="dev-link">
      <Icon size={13} />
      <button type="button" className="truncate grow" style={{ textAlign: "left" }} disabled={!url} onClick={() => url && void openLink(url)}>
        <span className={l.kind === "branch" || l.kind === "commit" ? "mono" : undefined}>{label}</span>
        {l.title && <span className="faint"> {l.title}</span>}
      </button>
      {repoName && l.kind !== "repository" && <span className="faint truncate" style={{ maxWidth: 100, fontSize: "var(--fs-xs)" }}>{repoName}</span>}
      {l.kind === "worktree" && l.repositoryId && projectId && (
        <IconButton icon={TerminalSquare} label="Open terminal here" size="sm" onClick={() => void openTerminal({ projectId, cwd: { kind: "worktree", repositoryId: l.repositoryId!, path: l.ref } })} />
      )}
      {url && <ExternalLink size={11} className="faint" />}
      <IconButton icon={X} label="Unlink" size="sm" onClick={() => void api.devLinks.remove(l.id).then(refresh).catch((e) => toastError(describeError(e)))} />
    </div>
  );
}

function BranchCommits({ repoId, branch, github }: { repoId: string; branch: string; github: string | null }) {
  const [open, setOpen] = useState(false);
  const { data, error } = useQuery({ queryKey: ["git", "branchCommits", repoId, branch], queryFn: () => api.devLinks.branchCommits(repoId, branch, 15), enabled: open, retry: false });
  return (
    <div className="col" style={{ gap: 1 }}>
      <button type="button" className="dev-link faint" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={12} style={{ transform: open ? "rotate(90deg)" : undefined }} />
        <span className="grow" style={{ textAlign: "left" }}>
          Commits on <span className="mono">{branch}</span>
          {data && ` (${data.commits.length}${data.base !== "HEAD" ? ` since ${data.base}` : ""})`}
        </span>
      </button>
      {open &&
        (error ? (
          <span className="faint" style={{ fontSize: "var(--fs-xs)", paddingLeft: 20 }}>{describeError(error)}</span>
        ) : !data ? (
          <Skeleton height={20} />
        ) : !data.commits.length ? (
          <span className="faint" style={{ fontSize: "var(--fs-xs)", paddingLeft: 20 }}>No commits of its own yet.</span>
        ) : (
          data.commits.map((c) => (
            <button key={c.hash} type="button" className="dev-link dev-link--commit" disabled={!github} onClick={() => github && void openLink(`https://github.com/${github}/commit/${c.hash}`)}>
              <GitCommitHorizontal size={12} className="faint" />
              <span className="truncate grow">{c.subject}</span>
              <span className="faint mono">{c.short}</span>
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{relativeTime(Date.parse(c.date))}</span>
            </button>
          ))
        ))}
    </div>
  );
}

