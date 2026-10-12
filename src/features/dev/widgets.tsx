// Development widgets for the Project Command Centre. Loaded only when a
// project's layout includes them; everything shown comes from local git or
// data Kern already fetched, plus an explicit refresh.

import { CircleCheck, CircleX, FolderGit2, GitBranch, GitCommitHorizontal, GitPullRequest, Plus, RefreshCw, TerminalSquare, CircleDot, Workflow, SquareCheckBig } from "lucide-react";
import { useState } from "react";
import type { CachedGithub, Project, Repository } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { navigate } from "@/stores/router";
import { useSetting } from "@/stores/settings";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, Segmented, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { relativeTime } from "@/lib/dates";
import { openLink } from "@/features/links/links";
import { openTask } from "@/features/tasks/menu";
import { openTerminal } from "@/features/terminal/store";
import { recordWorkspace } from "@/features/workspace/store";
import { useProjectWidget } from "@/features/command-centre/context";
import { useGithubCached, useRepoSummary, useRepos, useServices, useWorktrees } from "./hooks";
import { RepoRow, linkGithubRepository, linkLocalRepository } from "./Repositories";
import { ServiceRow } from "./Services";
import { PinnedCommands } from "./RunSection";
import { openWorktreeDialog } from "./worktreeDialog";

function openCode(project: Pick<Project, "id">, repo?: Repository, section?: string) {
  if (repo) recordWorkspace(project.id, { repositoryId: repo.id, ...(section ? { codeSection: section } : {}) });
  else if (section) recordWorkspace(project.id, { codeSection: section });
  navigate({ name: "project", id: project.id, tab: "code" }, { replace: true });
}

function NoRepos({ project }: { project: Project }) {
  return (
    <EmptyState compact icon={FolderGit2}>
      No repositories linked.{" "}
      <button type="button" className="mini-more" onClick={() => void linkLocalRepository(project)}>
        Link one
      </button>
    </EmptyState>
  );
}

// ------------------------------------------------------------ development status

function RepoStatusLine({ project, repo, cached }: { project: Project; repo: Repository; cached?: CachedGithub }) {
  const usable = repo.localStatus === "ok" && repo.trust === "trusted";
  const { data: s } = useRepoSummary(repo.id, usable);
  const latest = cached?.actions?.latest ?? [];
  const onDefault = latest.filter((r) => !cached?.actions?.defaultBranch || r.branch === cached.actions.defaultBranch);
  const failing = onDefault.filter((r) => ["failure", "timed_out"].includes(r.conclusion ?? ""));
  const running = onDefault.some((r) => r.status !== "completed");
  return (
    <div className="dev-status">
      <button type="button" className="dev-status__name truncate" onClick={() => openCode(project, repo)}>
        {repo.name}
      </button>
      <span className="row faint dev-status__meta">
        {usable && s?.available ? (
          <>
            <span className="row" style={{ gap: 4 }}>
              <GitBranch size={12} /> {s.detached ? "detached" : s.branch}
            </span>
            {s.changed + s.untracked > 0 ? (
              <button type="button" className="dirty-dot" onClick={() => openCode(project, repo, "changes")}>
                {s.changed + s.untracked} uncommitted
              </button>
            ) : (
              <span>clean</span>
            )}
            {s.ahead > 0 && <span>↑{s.ahead}</span>}
            {s.behind > 0 && <span>↓{s.behind}</span>}
          </>
        ) : (
          <span>{repo.localStatus === "none" ? "GitHub only" : repo.trust !== "trusted" ? "Restricted folder" : repo.localStatus === "ok" ? "…" : "Folder unavailable"}</span>
        )}
        {onDefault.length > 0 && (
          <Tooltip content={failing.length ? failing.map((f) => f.workflow).join(", ") : running ? "Running" : "All workflows passed on the default branch"}>
            <button type="button" className="row build-chip" data-state={failing.length ? "failure" : running ? "running" : "success"} onClick={() => (failing[0] ? void openLink(failing[0].htmlUrl) : openCode(project, repo, "builds"))}>
              {failing.length ? <CircleX size={12} /> : <CircleCheck size={12} />}
              {failing.length ? `${failing.length} failing` : running ? "running" : "passing"}
            </button>
          </Tooltip>
        )}
      </span>
      {usable && s?.lastCommit && (
        <span className="faint truncate dev-status__commit">
          <GitCommitHorizontal size={12} /> {s.lastCommit.subject} · {relativeTime(Date.parse(s.lastCommit.date))}
        </span>
      )}
    </div>
  );
}

export function DevStatusWidget() {
  const { project } = useProjectWidget();
  const { data: repos } = useRepos(project.id);
  const { data: cached } = useGithubCached(project.id);
  const poll = useSetting("services.pollWhileOpen");
  const { data: services } = useServices(project.id, poll);
  if (!repos) return <Skeleton height={60} />;
  if (!repos.length && !services?.length) return <NoRepos project={project} />;
  const running = (services ?? []).filter((s) => s.status === "running").length;
  return (
    <div className="col" style={{ gap: 8 }}>
      {repos.slice(0, 4).map((r) => (
        <RepoStatusLine key={r.id} project={project} repo={r} cached={cached?.find((c) => c.repository === r.github?.toLowerCase())} />
      ))}
      {(services?.length ?? 0) > 0 && (
        <button type="button" className="row faint dev-status__services" onClick={() => openCode(project, undefined, "run")}>
          <span className="svc-dot" data-status={running === services!.length ? "running" : running ? "degraded" : "stopped"} aria-hidden />
          {running}/{services!.length} services running
        </button>
      )}
      <div className="row" style={{ gap: 4 }}>
        {repos.some((r) => r.localStatus === "ok") && (
          <Button size="sm" variant="ghost" icon={TerminalSquare} onClick={() => void openTerminal({ projectId: project.id, cwd: repos[0].localPath ? { kind: "repository", repositoryId: repos[0].id } : { kind: "project", projectId: project.id } })}>
            Terminal
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={FolderGit2} onClick={() => openCode(project)}>
          Code
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ GitHub activity

type GhTab = "pulls" | "issues" | "builds" | "commits";

export function GithubActivityWidget() {
  const { project } = useProjectWidget();
  const { data: repos } = useRepos(project.id);
  const { data: cached, refetch } = useGithubCached(project.id);
  const network = useSetting("privacy.network");
  const [tab, setTab] = useState<GhTab>("pulls");
  const [busy, setBusy] = useState(false);
  const gh = (repos ?? []).filter((r) => r.github);
  const refresh = async () => {
    setBusy(true);
    try {
      for (const r of gh.slice(0, 4)) {
        await Promise.allSettled([api.github.pulls(project.id, r.github), api.github.issues(project.id, r.github), api.github.actions(project.id, r.github), api.github.commits(project.id, r.github)]);
      }
      await refetch();
      invalidate("health", "github");
    } catch (e) {
      toastError(describeError(e, "Couldn't refresh from GitHub."));
    } finally {
      setBusy(false);
    }
  };
  if (!repos) return <Skeleton height={60} />;
  if (!gh.length)
    return (
      <EmptyState compact icon={GitPullRequest}>
        No GitHub repository linked.{" "}
        <button type="button" className="mini-more" onClick={() => void linkGithubRepository(project)}>
          Link one
        </button>
      </EmptyState>
    );
  const all = cached ?? [];
  const fetchedAt = Math.max(0, ...all.map((c) => c.fetchedAt ?? 0));
  const pulls = all.flatMap((c) => (c.pulls ?? []).map((p) => ({ ...p, repo: c.repository })));
  const issues = all.flatMap((c) => (c.issues ?? []).map((i) => ({ ...i, repo: c.repository })));
  const runs = all.flatMap((c) => c.actions?.latest ?? []);
  const commits = all.flatMap((c) => c.commits ?? []).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  return (
    <div className="col" style={{ gap: 8, height: "100%" }}>
      <div className="row" style={{ gap: 6 }}>
        <Segmented
          size="sm"
          value={tab}
          onChange={setTab}
          ariaLabel="GitHub"
          options={[
            { value: "pulls", label: `PRs ${pulls.length || ""}`.trim() },
            { value: "issues", label: `Issues ${issues.length || ""}`.trim() },
            { value: "builds", label: "Builds" },
            { value: "commits", label: "Commits" },
          ]}
        />
        <span className="spacer" />
        <Tooltip content={network ? (fetchedAt ? `Updated ${relativeTime(fetchedAt)}` : "Fetch from GitHub") : "Network requests are off in Privacy settings"}>
          <span>
            <IconButton icon={RefreshCw} label="Refresh from GitHub" size="sm" disabled={!network || busy} className={busy ? "spin" : undefined} onClick={() => void refresh()} />
          </span>
        </Tooltip>
      </div>
      <div className="col" style={{ gap: 1, overflow: "auto", minHeight: 0 }}>
        {!fetchedAt && (
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            Nothing fetched yet.{" "}
            {network && (
              <button type="button" className="mini-more" onClick={() => void refresh()}>
                Fetch now
              </button>
            )}
          </span>
        )}
        {tab === "pulls" &&
          pulls.map((p) => (
            <button key={`${p.repo}${p.number}`} type="button" className="gh-row" onClick={() => void openLink(p.htmlUrl)}>
              <GitPullRequest size={13} className="faint" />
              <span className="truncate grow">{p.title}</span>
              {p.linkedTasks[0] && (
                <span role="button" className="chip chip-btn" onClick={(e) => (e.stopPropagation(), openTask(p.linkedTasks[0].id))}>
                  <SquareCheckBig size={11} />
                </span>
              )}
              <span className="faint gh-row__meta" data-state={p.checks}>
                #{p.number} · {p.review === "approved" ? "approved" : p.review === "changes_requested" ? "changes" : p.draft ? "draft" : "review"}
              </span>
            </button>
          ))}
        {tab === "issues" &&
          issues.map((i) => (
            <button key={`${i.repo}${i.number}`} type="button" className="gh-row" onClick={() => (i.taskId ? openTask(i.taskId) : void openLink(i.htmlUrl))}>
              <CircleDot size={13} className="faint" />
              <span className="truncate grow">{i.title}</span>
              <span className="faint gh-row__meta">#{i.number}</span>
            </button>
          ))}
        {tab === "builds" &&
          runs.map((r) => (
            <button key={r.id} type="button" className="gh-row" onClick={() => void openLink(r.htmlUrl)}>
              <Workflow size={13} className="faint" />
              <span className="truncate grow">{r.workflow}</span>
              <span className="faint gh-row__meta" data-state={r.status !== "completed" ? "pending" : r.conclusion === "success" ? "success" : r.conclusion === "failure" ? "failure" : "none"}>
                {r.status !== "completed" ? "running" : r.conclusion} · {r.branch}
              </span>
            </button>
          ))}
        {tab === "commits" &&
          commits.slice(0, 20).map((c) => (
            <button key={c.sha} type="button" className="gh-row" onClick={() => void openLink(c.htmlUrl)}>
              <GitCommitHorizontal size={13} className="faint" />
              <span className="truncate grow">{c.subject}</span>
              <span className="faint gh-row__meta">{relativeTime(Date.parse(c.date))}</span>
            </button>
          ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ services, commands, repositories, worktrees

export function ServicesWidget() {
  const { project } = useProjectWidget();
  const poll = useSetting("services.pollWhileOpen");
  const { data } = useServices(project.id, poll);
  if (!data) return <Skeleton height={40} />;
  if (!data.length)
    return (
      <EmptyState compact icon={Workflow}>
        No services.{" "}
        <button type="button" className="mini-more" onClick={() => openCode(project, undefined, "run")}>
          Add one
        </button>
      </EmptyState>
    );
  return (
    <div className="col" style={{ gap: 1 }}>
      {data.map((s) => (
        <ServiceRow key={s.id} project={project} s={s} compact />
      ))}
    </div>
  );
}

export function CommandsWidget() {
  const { project } = useProjectWidget();
  return <PinnedCommands project={project} />;
}

export function ReposWidget() {
  const { project } = useProjectWidget();
  const { data: repos } = useRepos(project.id);
  if (!repos) return <Skeleton height={40} />;
  return (
    <div className="col" style={{ gap: 2 }}>
      {repos.map((r) => (
        <RepoRow key={r.id} project={project} r={r} onSelect={() => openCode(project, r)} />
      ))}
      <div className="row" style={{ gap: 4 }}>
        <Button size="sm" variant="ghost" icon={Plus} onClick={() => void linkLocalRepository(project)}>
          Local
        </Button>
        <Button size="sm" variant="ghost" icon={Plus} onClick={() => void linkGithubRepository(project)}>
          GitHub
        </Button>
      </div>
    </div>
  );
}

function RepoWorktrees({ project, repo }: { project: Project; repo: Repository }) {
  const { data } = useWorktrees(repo.id, repo.localStatus === "ok" && repo.trust === "trusted");
  const extra = (data ?? []).filter((w) => !w.isMain);
  if (!extra.length) return null;
  return (
    <>
      {extra.map((w) => (
        <div key={w.path} className="gh-row">
          <FolderGit2 size={13} className="faint" />
          <span className="col grow" style={{ minWidth: 0 }}>
            <span className="truncate">{w.name}</span>
            <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>
              {w.branch ?? "detached"}
              {(w.changed ?? 0) + (w.untracked ?? 0) > 0 && ` · ${(w.changed ?? 0) + (w.untracked ?? 0)} changed`}
              {w.taskTitle && ` · ${w.taskTitle}`}
            </span>
          </span>
          {w.taskId && <IconButton icon={SquareCheckBig} label="Open task" size="sm" onClick={() => openTask(w.taskId!)} />}
          <IconButton icon={TerminalSquare} label="Open terminal here" size="sm" onClick={() => void openTerminal({ projectId: project.id, cwd: { kind: "worktree", repositoryId: repo.id, path: w.path }, title: w.name })} />
        </div>
      ))}
    </>
  );
}

export function WorktreesWidget() {
  const { project } = useProjectWidget();
  const { data: repos } = useRepos(project.id);
  const local = (repos ?? []).filter((r) => r.localStatus === "ok" && r.trust === "trusted");
  if (!repos) return <Skeleton height={40} />;
  if (!local.length) return <NoRepos project={project} />;
  return (
    <div className="col" style={{ gap: 1 }}>
      {local.map((r) => (
        <RepoWorktrees key={r.id} project={project} repo={r} />
      ))}
      <Button size="sm" variant="ghost" icon={Plus} style={{ alignSelf: "flex-start" }} onClick={() => openWorktreeDialog({ projectId: project.id, repositoryId: local[0].id })}>
        New worktree
      </Button>
    </div>
  );
}
