/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Repositories linked to a project (zero, one or many): link a local clone
// or a GitHub repository, choose the primary one, rename, trust, reveal and
// unlink. Unlinking only removes Kern's record; nothing on disk or on
// GitHub changes.

import { Code2, Ellipsis, ExternalLink, FolderGit2, FolderOpen, GitBranch, Pencil, Plus, RefreshCw, ShieldCheck, ShieldHalf, Star, Unlink } from "lucide-react";
import type { Project, Repository } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { confirm, prompt } from "@/components/ui/Dialog";
import { Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { askTrust, pickFolder, shortPath } from "@/features/projects/folders";
import { GithubMark, pickRepo, syncProject } from "@/features/github/shared";
import { openLink } from "@/features/links/links";
import { recordWorkspace, useWorkspaceState } from "@/features/workspace/store";
import { useRepoSummary, useRepos } from "./hooks";

export const refreshRepos = () => invalidate("repos", "capabilities", "git", "github", "health", "projects", "project");

/** The repository the project's tools currently act on (remembered per project). */
export function useSelectedRepo(projectId: string) {
  const { data: repos, isLoading } = useRepos(projectId);
  const { data: ws } = useWorkspaceState(projectId);
  const selected = (repos ?? []).find((r) => r.id === ws?.repositoryId) ?? repos?.[0] ?? null;
  return { repos: repos ?? [], selected, isLoading, select: (id: string) => recordWorkspace(projectId, { repositoryId: id }) };
}

export async function linkLocalRepository(project: Pick<Project, "id" | "name">) {
  const picked = await pickFolder(`Choose a git repository for ${project.name}`);
  if (!picked) return null;
  try {
    const r = await api.repos.linkLocal(project.id, picked.info.path, picked.trust);
    refreshRepos();
    recordWorkspace(project.id, { repositoryId: r.id });
    toast(`Linked ${r.name}`);
    return r;
  } catch (e) {
    toastError(describeError(e, "Couldn't link the repository."));
    return null;
  }
}

export async function linkGithubRepository(project: Pick<Project, "id" | "name" | "githubRepo">) {
  const picked = await pickRepo({ title: `Link a GitHub repository to ${project.name}`, confirmLabel: "Link", offerClone: false });
  if (!picked) return null;
  try {
    const r = await api.repos.linkGithub(project.id, picked.repo);
    refreshRepos();
    recordWorkspace(project.id, { repositoryId: r.id });
    if (!project.githubRepo) {
      const sync = await confirm({
        title: `Sync ${picked.repo}'s issues with tasks?`,
        message: "Issues become tasks in this project and edits flow both ways. You can turn this off at any time. Without it, you still see issues, pull requests and builds.",
        confirmLabel: "Sync issues",
      });
      if (sync) {
        await api.github.connect(project.id, picked.repo, picked.importClosed);
        await syncProject(project.id);
        refreshRepos();
      }
    }
    return r;
  } catch (e) {
    toastError(describeError(e, "Couldn't link the repository."));
    return null;
  }
}

async function unlinkRepository(project: Pick<Project, "id">, r: Repository) {
  const ok = await confirm({
    title: `Unlink ${r.name}?`,
    message: `Only Kern's link is removed.${r.localPath ? " The folder and its files stay exactly where they are." : ""} Tasks linked to its branches keep their other details.${r.issueSync ? " Issue sync with tasks stays on until you disconnect it in the Code tab." : ""}`,
    confirmLabel: "Unlink",
  });
  if (!ok) return;
  try {
    await api.repos.unlink(r.id);
    refreshRepos();
  } catch (e) {
    toastError(describeError(e));
  }
  void project;
}

async function setRepoTrust(r: Repository, trust: "trusted" | "restricted") {
  if (trust === "trusted" && r.localPath) {
    const t = await askTrust({ path: r.localPath, name: r.name, trust: "restricted", linkedProjects: [] });
    if (t !== "trusted") return;
  }
  try {
    await api.repos.setTrust(r.id, trust);
    refreshRepos();
  } catch (e) {
    toastError(describeError(e));
  }
}

export function repoMenu(project: Pick<Project, "id">, r: Repository): MenuItems {
  return [
    !r.isPrimary && { label: "Make primary", icon: Star, onSelect: () => void api.repos.update(r.id, { primary: true }).then(refreshRepos) },
    {
      label: "Rename…",
      icon: Pencil,
      onSelect: async () => {
        const alias = await prompt({ title: "Display name", initial: r.alias ?? r.name, placeholder: r.name });
        if (alias !== null) void api.repos.update(r.id, { alias: alias.trim() || null }).then(refreshRepos);
      },
    },
    !!r.localPath && { label: "Show in folder", icon: FolderOpen, onSelect: () => void api.repos.reveal(r.id).catch((e) => toastError(describeError(e))) },
    !!r.localPath && { label: "Open in editor", icon: Code2, onSelect: () => void api.worktrees.openInEditor(r.localPath!).catch((e) => toastError(describeError(e))) },
    !!r.github && { label: "Open on GitHub", icon: ExternalLink, onSelect: () => void openLink(`https://github.com/${r.github}`) },
    !!r.localPath && r.trust !== "trusted" && { label: "Trust folder…", icon: ShieldCheck, onSelect: () => void setRepoTrust(r, "trusted") },
    !!r.localPath && r.trust === "trusted" && { label: "Restrict folder", icon: ShieldHalf, onSelect: () => void setRepoTrust(r, "restricted") },
    { type: "separator" },
    { label: "Unlink…", icon: Unlink, danger: true, onSelect: () => void unlinkRepository(project, r) },
  ];
}

function RepoStatus({ r }: { r: Repository }) {
  const usable = r.localStatus === "ok" && r.trust === "trusted";
  const { data: s } = useRepoSummary(r.id, usable);
  if (r.localStatus === "none") return <span className="faint">GitHub only</span>;
  if (r.localStatus === "missing") return <span className="faint">Folder missing</span>;
  if (r.localStatus === "not_repo") return <span className="faint">Not a git repository</span>;
  if (r.trust !== "trusted")
    return (
      <span className="faint row" style={{ gap: 4 }}>
        <ShieldHalf size={12} /> Restricted
      </span>
    );
  if (!s) return <Skeleton height={12} width={80} />;
  if (!s.available) return <span className="faint">{s.reason}</span>;
  const dirty = s.changed + s.untracked;
  return (
    <span className="row faint" style={{ gap: 8 }}>
      <span className="row" style={{ gap: 4 }}>
        <GitBranch size={12} /> {s.detached ? "detached" : s.branch}
      </span>
      {dirty > 0 && <span className="dirty-dot" title={`${dirty} changed file${dirty === 1 ? "" : "s"}`}>{dirty} changed</span>}
      {s.ahead > 0 && <span>↑{s.ahead}</span>}
      {s.behind > 0 && <span>↓{s.behind}</span>}
    </span>
  );
}

export function RepoRow({ project, r, onSelect, selected }: { project: Pick<Project, "id">; r: Repository; onSelect?: () => void; selected?: boolean }) {
  return (
    <div className="repo-row" data-selected={selected || undefined} onClick={onSelect} role={onSelect ? "button" : undefined}>
      {r.localPath ? <FolderGit2 size={15} className="faint" /> : <GithubMark size={15} />}
      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          <span className="truncate" style={{ fontWeight: 550 }}>
            {r.name}
          </span>
          {r.isPrimary && (
            <Tooltip content="Primary repository (the default for new branches, worktrees and commands)">
              <Star size={11} className="faint" />
            </Tooltip>
          )}
          {r.issueSync && <span className="chip">Issues synced</span>}
        </span>
        <span className="row faint truncate" style={{ gap: 8, fontSize: "var(--fs-xs)" }}>
          <RepoStatus r={r} />
          {r.localPath && <span className="truncate mono">{shortPath(r.localPath, 44)}</span>}
          {!r.localPath && r.github && <span className="truncate">{r.github}</span>}
        </span>
      </span>
      <span onClick={(e) => e.stopPropagation()}>
        <Dropdown items={repoMenu(project, r)} align="end">
          <IconButton icon={Ellipsis} label="Repository options" size="sm" noTooltip />
        </Dropdown>
      </span>
    </div>
  );
}

/** Repository management (Code tab and project settings). */
export function RepositoriesPanel({ project, onSelect, selectedId }: { project: Project; onSelect?: (r: Repository) => void; selectedId?: string | null }) {
  const { data: repos, isLoading, refetch, isFetching } = useRepos(project.id);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <span className="section-title">
          Repositories <span className="count">{repos?.length ?? 0}</span>
        </span>
        <span className="spacer" />
        <IconButton icon={RefreshCw} label="Refresh" size="sm" className={isFetching ? "spin" : undefined} onClick={() => (invalidate("git"), void refetch())} />
        <Dropdown
          align="end"
          items={[
            { label: "Local repository…", icon: FolderGit2, onSelect: () => void linkLocalRepository(project) },
            { label: "GitHub repository…", icon: Plus, onSelect: () => void linkGithubRepository(project) },
          ]}
        >
          <Button size="sm" icon={Plus}>
            Link
          </Button>
        </Dropdown>
      </div>
      {isLoading ? (
        <Skeleton height={40} />
      ) : !repos?.length ? (
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          No repositories. Link a local clone for git tools, or a GitHub repository for issues, pull requests and builds.
        </span>
      ) : (
        repos.map((r) => <RepoRow key={r.id} project={project} r={r} selected={selectedId === r.id} onSelect={onSelect ? () => onSelect(r) : undefined} />)
      )}
    </div>
  );
}
