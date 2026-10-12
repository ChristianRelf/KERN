// Project → Code: the project's repositories. One repository is selected
// at a time (remembered per project); sections only appear when they apply
// to it: local tools (changes, history, worktrees) for a trusted local
// copy, pull requests and builds for a GitHub repository, and the run
// environment and dependencies for any local folder.

import {
  ArrowDown,
  ArrowUp,
  Box,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleX,
  Ellipsis,
  FileDiff,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Link2,
  ListTodo,
  Network,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  ShieldHalf,
  Star,
  Tag,
  TerminalSquare,
  Unlink,
  Upload,
  Workflow,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GitChangedFile, GitCommit, Project, PullInfo, Repository, TodoItem } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { Checkbox, EmptyState, Segmented, Skeleton } from "@/components/ui/Controls";
import { Dialog, confirm, prompt } from "@/components/ui/Dialog";
import { Tooltip } from "@/components/ui/Tooltip";
import { toast, toastError } from "@/stores/toast";
import { useSetting } from "@/stores/settings";
import { relativeTime } from "@/lib/dates";
import { openTask } from "@/features/tasks/menu";
import { createTask } from "@/features/tasks/actions";
import { linkFolder } from "@/features/projects/folders";
import { openLink } from "@/features/links/links";
import { renderMarkdown, safeHref } from "@/lib/markdown";
import { copyText } from "@/features/projects/folders";
import { GithubMark, cloneIntoProject, connectProject, syncProject, useProjectRepo } from "./shared";
import { layoutGraph, parseRefs, type Edge } from "./graph";
import { languageColor } from "./languages";
import { SyntaxPrompt } from "@/features/plugins/SyntaxPrompt";
import { recordWorkspace, useWorkspaceState } from "@/features/workspace/store";
import { RepositoriesPanel, linkGithubRepository, linkLocalRepository, refreshRepos, repoMenu, useSelectedRepo } from "@/features/dev/Repositories";
import { WorktreesSection } from "@/features/dev/Worktrees";
import { BuildsSection } from "@/features/dev/Builds";
import { RunSection } from "@/features/dev/RunSection";
import { openTerminal } from "@/features/terminal/store";

const DependenciesSection = lazy(() => import("@/features/dev/Dependencies"));

type Section = "overview" | "changes" | "history" | "worktrees" | "pulls" | "builds" | "run" | "deps";

export function CodeTab({ project }: { project: Project }) {
  const { repos, selected, select, isLoading } = useSelectedRepo(project.id);
  const { data: ws } = useWorkspaceState(project.id);
  const [manage, setManage] = useState(false);
  const local = !!selected?.localPath && selected.localStatus === "ok";
  const trusted = local && selected?.trust === "trusted";
  const gh = !!selected?.github;
  // Run & dependencies work on the selected repository's folder, or the project folder.
  const hasRoot = local || (!selected && !!project.folderPath);
  const sections = useMemo(() => {
    const out: { value: Section; label: string; icon: typeof GitBranch }[] = [{ value: "overview", label: "Overview", icon: Box }];
    if (selected?.localPath) out.push({ value: "changes", label: "Changes", icon: FileDiff }, { value: "history", label: "History", icon: GitBranch }, { value: "worktrees", label: "Worktrees", icon: FolderGit2 });
    if (gh) out.push({ value: "pulls", label: "Pull requests", icon: GitPullRequest }, { value: "builds", label: "Builds", icon: Workflow });
    if (hasRoot || selected?.localPath) out.push({ value: "run", label: "Run", icon: Play }, { value: "deps", label: "Dependencies", icon: Network });
    return out;
  }, [selected, gh, hasRoot]);
  const wanted = (ws?.codeSection as Section | undefined) ?? "overview";
  const section = sections.some((s) => s.value === wanted) ? wanted : "overview";
  const setSection = (v: Section) => recordWorkspace(project.id, { codeSection: v });

  if (isLoading) return <div className="page-body page-body--pad"><Skeleton height={80} /></div>;

  if (!repos.length && !project.folderPath)
    return (
      <div className="page-body page-body--pad code-tab">
        <EmptyState
          icon={FolderGit2}
          title="No code linked"
          action={
            <div className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
              <Button icon={FolderGit2} onClick={() => void linkLocalRepository(project)}>
                Link a local repository
              </Button>
              <Button icon={Plus} onClick={() => void linkGithubRepository(project)}>
                Link a GitHub repository
              </Button>
              <Button variant="ghost" icon={FolderOpen} onClick={() => void linkFolder(project)}>
                Link a folder
              </Button>
            </div>
          }
        >
          Projects don't need code. Link a repository to see its changes, branches, worktrees, pull requests and builds here — you can link several.
        </EmptyState>
      </div>
    );

  return (
    <div className="page-body page-body--pad code-tab">
      <SyntaxPrompt project={project} />
      <RepoBar project={project} repos={repos} selected={selected} onSelect={(r) => select(r.id)} onManage={() => setManage(true)} />
      <Segmented size="sm" value={section} onChange={setSection} ariaLabel="Code section" options={sections} />
      {section === "overview" && <Overview project={project} repo={selected} />}
      {(section === "changes" || section === "history" || section === "worktrees") && selected && (
        <LocalGate project={project} repo={selected} trusted={trusted}>
          {section === "changes" ? <Changes repo={selected} /> : section === "history" ? <Branches repo={selected} /> : <WorktreesSection project={project} repo={selected} />}
        </LocalGate>
      )}
      {section === "pulls" && selected?.github && <Pulls project={project} repo={selected} />}
      {section === "builds" && selected?.github && <BuildsSection project={project} repo={selected} />}
      {section === "run" && <RunSection project={project} repo={local ? selected : null} />}
      {section === "deps" && (
        <Suspense fallback={<Skeleton height={80} />}>
          <DependenciesSection project={project} repo={local ? selected : null} />
        </Suspense>
      )}
      <Dialog open={manage} onOpenChange={setManage} title="Repositories" wide>
        <RepositoriesPanel project={project} selectedId={selected?.id} onSelect={(r) => (select(r.id), setManage(false))} />
      </Dialog>
    </div>
  );
}

/** Repository switcher, issue-sync status and repository actions. */
function RepoBar({ project, repos, selected, onSelect, onManage }: { project: Project; repos: Repository[]; selected: Repository | null; onSelect: (r: Repository) => void; onManage: () => void }) {
  const { data: sync } = useProjectRepo(project.id);
  const autoSync = useSetting("github.autoSync");
  const [syncing, setSyncing] = useState(false);
  // Pull issue changes when the tab opens (at most every 10 minutes).
  useEffect(() => {
    if (!sync || !autoSync || !sync.syncIssues) return;
    if (sync.lastSyncedAt && Date.now() - sync.lastSyncedAt < 10 * 60_000) return;
    void syncProject(project.id, true);
  }, [sync?.projectId, autoSync]);
  const isSyncRepo = !!(sync && selected?.github && selected.github.toLowerCase() === sync.fullName.toLowerCase());
  if (!selected)
    return (
      <div className="code-banner">
        <FolderGit2 size={16} />
        <span className="grow">The linked folder isn't a git repository. You can still run its commands and see its dependencies.</span>
        <Button size="sm" onClick={() => void linkLocalRepository(project)}>
          Link a repository…
        </Button>
      </div>
    );
  const switcher: MenuItems = [
    ...repos.map((r) => ({ label: r.name, icon: r.localPath ? FolderGit2 : Link2, checked: r.id === selected.id, onSelect: () => onSelect(r) })),
    { type: "separator" },
    { label: "Link a local repository…", icon: FolderGit2, onSelect: () => void linkLocalRepository(project) },
    { label: "Link a GitHub repository…", icon: Plus, onSelect: () => void linkGithubRepository(project) },
    { label: "Manage repositories…", icon: Settings2, onSelect: onManage },
  ];
  return (
    <div className="code-bar">
      {selected.localPath ? <FolderGit2 size={16} className="faint" /> : <GithubMark size={16} />}
      <Dropdown items={switcher} align="start">
        <button type="button" className="code-bar__repo row" style={{ gap: 4 }}>
          {selected.name}
          {selected.isPrimary && repos.length > 1 && <Star size={11} className="faint" />}
          <ChevronDown size={13} className="faint" />
        </button>
      </Dropdown>
      {selected.github && (
        <button type="button" className="faint code-bar__meta" onClick={() => void openLink(`https://github.com/${selected.github}`)}>
          {selected.github}
        </button>
      )}
      {isSyncRepo && sync && (
        <span className="faint code-bar__meta">
          · {sync.linkedIssues} linked issue{sync.linkedIssues === 1 ? "" : "s"} · {sync.syncIssues ? (sync.lastSyncedAt ? `synced ${relativeTime(sync.lastSyncedAt)}` : "not synced yet") : "issue sync paused"}
        </span>
      )}
      {isSyncRepo && sync?.lastSyncError && (
        <Tooltip content={sync.lastSyncError}>
          <CircleX size={14} className="code-bar__error" aria-label="Last sync failed" />
        </Tooltip>
      )}
      <span className="spacer" />
      {selected.localPath && selected.localStatus === "ok" && (
        <IconButton icon={TerminalSquare} label="Open a terminal here" size="sm" onClick={() => void openTerminal({ projectId: project.id, cwd: { kind: "repository", repositoryId: selected.id } })} />
      )}
      {isSyncRepo && sync?.syncIssues && (
        <Button
          size="sm"
          icon={RefreshCw}
          className={syncing ? "spin" : undefined}
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            await syncProject(project.id);
            setSyncing(false);
          }}
        >
          Sync issues
        </Button>
      )}
      {selected.github && !sync && (
        <Button size="sm" onClick={() => void connectProject(project, selected.github!).then(refreshRepos)}>
          Sync issues…
        </Button>
      )}
      <Dropdown
        align="end"
        items={[
          ...repoMenu(project, selected),
          isSyncRepo && sync && { type: "separator" },
          isSyncRepo && sync && { label: sync.syncIssues ? "Pause issue sync" : "Resume issue sync", onSelect: () => void api.github.update(project.id, { syncIssues: !sync.syncIssues }).then(() => invalidate("github")) },
          isSyncRepo && sync && { label: "Include closed issues", checked: sync.importClosed, onSelect: () => void api.github.update(project.id, { importClosed: !sync.importClosed }).then(() => invalidate("github")) },
          isSyncRepo &&
            sync && {
              label: "Stop syncing issues…",
              icon: Unlink,
              danger: true,
              onSelect: async () => {
                if (!(await confirm({ title: `Stop syncing ${sync.fullName}'s issues?`, message: "Imported tasks stay in the project as ordinary tasks. Nothing changes on GitHub.", confirmLabel: "Stop syncing" }))) return;
                await api.github.disconnect(project.id);
                invalidate("github", "tasks", "task", "projects", "project", "repos");
              },
            },
        ]}
      >
        <IconButton icon={Ellipsis} label="Repository options" size="sm" noTooltip />
      </Dropdown>
    </div>
  );
}

/** Git tools need a local copy that's a repository and trusted. */
function LocalGate({ project, repo, trusted, children }: { project: Project; repo: Repository; trusted: boolean; children: React.ReactNode }) {
  if (!repo.localPath)
    return (
      <EmptyState compact icon={FolderOpen} action={repo.github ? <Button onClick={() => void cloneIntoProject(project.id, repo.github!).then(refreshRepos)}>Clone a local copy…</Button> : undefined}>
        Git tools work on a local copy of the code.
      </EmptyState>
    );
  if (repo.localStatus === "missing")
    return (
      <EmptyState compact icon={FolderOpen}>
        The repository folder can't be found. It may have moved; unlink it and link the new location.
      </EmptyState>
    );
  if (repo.localStatus === "not_repo")
    return (
      <EmptyState compact icon={GitBranch}>
        The linked folder isn't a git repository.
      </EmptyState>
    );
  if (!trusted)
    return (
      <EmptyState compact icon={ShieldHalf} action={<Button onClick={() => void api.repos.setTrust(repo.id, "trusted").then(refreshRepos).catch((e) => toastError(describeError(e)))}>Trust folder</Button>}>
        Git tools run git in the folder, and a repository can run its own scripts through git (hooks and filters). Trust the folder to use them.
      </EmptyState>
    );
  return <>{children}</>;
}

// ------------------------------------------------------------ overview

function Overview({ project, repo }: { project: Project; repo: Repository | null }) {
  const connected = !!repo?.github;
  const { data: ov, error, isLoading } = useQuery({
    queryKey: ["github", "overview", project.id, repo?.id],
    queryFn: () => api.github.overview(project.id, repo?.github ?? null, repo?.localPath ? repo.id : null),
    enabled: connected,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const total = ov ? ov.languages.reduce((n, [, b]) => n + b, 0) : 0;
  return (
    <div className="code-overview">
      {connected && (
        <div className="col" style={{ gap: 12, minWidth: 0 }}>
          {isLoading && <Skeleton height={80} />}
          {error && <span className="faint">{describeError(error, "Couldn't load the repository.")}</span>}
          {ov && (
            <>
              {ov.description && <p style={{ margin: 0 }}>{ov.description}</p>}
              <div className="row faint" style={{ gap: 14, fontSize: "var(--fs-sm)", flexWrap: "wrap" }}>
                <span className="row" style={{ gap: 4 }}>
                  <Star size={13} /> {ov.stars}
                </span>
                <span>{ov.openIssues} open issues & PRs</span>
                {ov.defaultBranch && (
                  <span className="row" style={{ gap: 4 }}>
                    <GitBranch size={13} /> {ov.defaultBranch}
                  </span>
                )}
                {ov.pushedAt && <span>pushed {relativeTime(Date.parse(ov.pushedAt))}</span>}
                {ov.private && <span>Private</span>}
              </div>
              {total > 0 && (
                <div className="col" style={{ gap: 6 }}>
                  <div className="lang-bar" aria-hidden>
                    {ov.languages.slice(0, 6).map(([l, b], i) => (
                      <span key={l} style={{ width: `${(b / total) * 100}%`, "--lang": languageColor(l, i) } as CSSProperties} />
                    ))}
                  </div>
                  <div className="row faint" style={{ gap: 12, fontSize: "var(--fs-xs)", flexWrap: "wrap" }}>
                    {ov.languages.slice(0, 6).map(([l, b], i) => (
                      <span key={l} className="lang-key" style={{ "--lang": languageColor(l, i) } as CSSProperties}>
                        {l} {((b / total) * 100).toFixed(b / total < 0.1 ? 1 : 0)}%
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {ov.readme && <Readme text={ov.readme} source={ov.readmeSource} />}
            </>
          )}
        </div>
      )}
      {!connected && repo?.localPath && <LocalReadme project={project} repo={repo} />}
      {project.folderPath ? <TodoScan project={project} /> : !connected && <EmptyState compact icon={ListTodo}>Link the project's folder to scan its code for TODO comments.</EmptyState>}
    </div>
  );
}

/** Links inside rendered Markdown open in the browser, never inside Kern. */
function onMarkdownClick(e: MouseEvent<HTMLElement>) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = safeHref(a.getAttribute("href"));
  if (href) void openLink(href);
}

function Readme({ text, source }: { text: string; source: "local" | "github" | null }) {
  const [raw, setRaw] = useState(false);
  const [open, setOpen] = useState(false);
  const html = useMemo(() => renderMarkdown(text), [text]);
  const long = text.split("\n").length > 30;
  return (
    <div className="readme" data-clipped={long && !open ? true : undefined}>
      <div className="readme__head">
        <span>
          README <span className="faint">· {source === "local" ? "from your local copy" : "from GitHub"}</span>
        </span>
        <span className="spacer" />
        <Segmented
          size="sm"
          value={raw ? "raw" : "preview"}
          onChange={(v) => setRaw(v === "raw")}
          ariaLabel="README view"
          options={[
            { value: "preview", label: "Preview" },
            { value: "raw", label: "Raw" },
          ]}
        />
      </div>
      <div className="readme__clip">
        {raw ? (
          <pre className="readme__body selectable">{text}</pre>
        ) : (
          <div className="readme__md prose selectable" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
      {long && (
        <button type="button" className="mini-more" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show the full README"}
        </button>
      )}
    </div>
  );
}

function TodoScan({ project }: { project: Project }) {
  const [items, setItems] = useState<TodoItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const scan = async () => {
    setBusy(true);
    try {
      const r = await api.git.scanTodos(project.id);
      setItems(r);
      setPicked(new Set(r.map((_, i) => i)));
    } catch (e) {
      toastError(describeError(e, "Couldn't scan the folder."));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (!items) return;
    const existing = new Set((await api.tasks.query({ projectIds: [project.id], includeCompleted: true })).map((t) => t.title.toLowerCase()));
    let n = 0;
    for (const i of [...picked].sort((a, b) => a - b)) {
      const it = items[i];
      const title = it.text.length > 120 ? `${it.text.slice(0, 117)}…` : it.text;
      if (existing.has(title.toLowerCase())) continue;
      const t = await createTask({ title, description: `${it.kind} in \`${it.path}\` line ${it.line}:\n\n> ${it.text}`, projectId: project.id, status: "todo" }, { quiet: true });
      if (t) n++;
    }
    toast(n ? `Created ${n} task${n === 1 ? "" : "s"}` : "Those TODOs are already tasks");
    setItems(null);
  };
  return (
    <div className="todo-scan">
      <div className="row" style={{ gap: 8 }}>
        <span className="section-title">TODO comments</span>
        <span className="spacer" />
        {items && items.length > 0 && (
          <Button size="sm" variant="primary" icon={Plus} disabled={!picked.size} onClick={() => void create()}>
            Create {picked.size} task{picked.size === 1 ? "" : "s"}
          </Button>
        )}
        <Button size="sm" icon={ListTodo} disabled={busy} onClick={() => void scan()}>
          {busy ? "Scanning…" : items ? "Scan again" : "Scan code"}
        </Button>
      </div>
      {!items ? (
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          Finds TODO, FIXME and HACK comments in the linked folder (skipping dependencies, build output and files that look like secrets) so you can turn them into tasks.
        </span>
      ) : !items.length ? (
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No TODO comments found.</span>
      ) : (
        <div className="todo-list">
          {items.map((it, i) => (
            <label key={`${it.path}:${it.line}`} className="todo-item">
              <Checkbox
                checked={picked.has(i)}
                onChange={(v) =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (v) n.add(i);
                    else n.delete(i);
                    return n;
                  })
                }
                label={it.text}
              />
              <span className="chip">{it.kind}</span>
              <span className="grow truncate">{it.text}</span>
              <span className="faint mono truncate todo-item__where">
                {it.path}:{it.line}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ changes

function fileLabel(f: GitChangedFile) {
  if (f.conflicted) return "Conflict";
  if (f.untracked) return "New";
  const c = f.code.replace(".", "")[0];
  return { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed" }[c] ?? f.code;
}

function Changes({ repo }: { repo: Repository }) {
  const { data: st, error, refetch, isFetching } = useQuery({ queryKey: ["git", "status", repo.id], queryFn: () => api.git.status(repo.id), retry: false, refetchOnWindowFocus: true });
  const [open, setOpen] = useState<{ path: string; staged: boolean; untracked: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: "fetch" | "pull" | "push") => {
    setBusy(action);
    try {
      await api.git.sync(repo.id, action);
      toast(action === "fetch" ? "Fetched" : action === "pull" ? "Pulled" : "Pushed");
      invalidate("git");
    } catch (e) {
      toastError(describeError(e, `Couldn't ${action}.`));
    } finally {
      setBusy(null);
    }
  };
  if (error) return <EmptyState compact icon={GitBranch}>{describeError(error, "Couldn't read the repository.")}</EmptyState>;
  if (!st) return <Skeleton height={80} />;
  const staged = st.files.filter((f) => f.staged);
  const unstaged = st.files.filter((f) => f.unstaged);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="code-branch">
        <GitBranch size={14} />
        <b>{st.detached ? "Detached HEAD" : st.branch}</b>
        {st.upstream ? (
          <span className="faint">
            → {st.upstream}
            {st.ahead > 0 && (
              <span className="row" style={{ display: "inline-flex", gap: 2, marginLeft: 8 }}>
                <ArrowUp size={12} />
                {st.ahead}
              </span>
            )}
            {st.behind > 0 && (
              <span className="row" style={{ display: "inline-flex", gap: 2, marginLeft: 6 }}>
                <ArrowDown size={12} />
                {st.behind}
              </span>
            )}
          </span>
        ) : (
          <span className="faint">not pushed yet</span>
        )}
        <span className="spacer" />
        <Button size="sm" icon={RefreshCw} disabled={!!busy} onClick={() => void run("fetch")}>
          {busy === "fetch" ? "Fetching…" : "Fetch"}
        </Button>
        <Button size="sm" icon={ArrowDown} disabled={!!busy || !st.upstream} onClick={() => void run("pull")}>
          {busy === "pull" ? "Pulling…" : "Pull"}
        </Button>
        <Button size="sm" icon={Upload} disabled={!!busy || st.detached} onClick={() => void run("push")}>
          {busy === "push" ? "Pushing…" : "Push"}
        </Button>
        <IconButton icon={RefreshCw} label="Refresh" size="sm" className={isFetching ? "spin" : undefined} onClick={() => void refetch()} />
      </div>
      {!st.files.length && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No local changes. The working tree is clean.</span>}
      {[
        { title: "Staged", files: staged, staged: true },
        { title: "Changes", files: unstaged, staged: false },
      ].map(
        (g) =>
          g.files.length > 0 && (
            <div key={g.title} className="col" style={{ gap: 2 }}>
              <div className="section-title">
                {g.title} <span className="count">{g.files.length}</span>
              </div>
              {g.files.map((f) => {
                const key = { path: f.path, staged: g.staged, untracked: f.untracked };
                const isOpen = open?.path === f.path && open.staged === g.staged;
                return (
                  <div key={f.path + g.title}>
                    <button type="button" className="git-file" data-open={isOpen || undefined} onClick={() => setOpen(isOpen ? null : key)}>
                      <FileDiff size={14} className="faint" />
                      <span className="truncate grow mono">{f.renamedFrom ? `${f.renamedFrom} → ${f.path}` : f.path}</span>
                      <span className="chip">{fileLabel(f)}</span>
                    </button>
                    {isOpen && <Diff repoId={repo.id} {...key} />}
                  </div>
                );
              })}
            </div>
          ),
      )}
    </div>
  );
}

function Diff({ repoId, path, staged, untracked }: { repoId: string; path: string; staged: boolean; untracked: boolean }) {
  const { data, error } = useQuery({ queryKey: ["git", "diff", repoId, path, staged], queryFn: () => api.git.diff(repoId, path, staged, untracked), retry: false });
  if (error) return <div className="diff faint">{describeError(error)}</div>;
  if (data === undefined) return <Skeleton height={60} />;
  const lines = data.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l));
  return (
    <pre className="diff selectable" aria-label={`Changes in ${path}`}>
      {lines.length ? (
        lines.map((l, i) => (
          <span key={i} className="diff__line" data-kind={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : undefined}>
            {l || " "}
            {"\n"}
          </span>
        ))
      ) : (
        <span className="faint">No text changes (mode or binary change).</span>
      )}
    </pre>
  );
}

// ------------------------------------------------------------ branches

function Branches({ repo }: { repo: Repository }) {
  const { data: branches, error } = useQuery({ queryKey: ["git", "branches", repo.id], queryFn: () => api.git.branches(repo.id), retry: false });
  const [showRemote, setShowRemote] = useState(false);
  const switchTo = async (name: string, create = false) => {
    try {
      await api.git.switch(repo.id, name, create);
      toast(create ? `Created and switched to ${name}` : `Switched to ${name}`);
    } catch (e) {
      toastError(describeError(e, "Couldn't switch branch."));
    } finally {
      invalidate("git");
    }
  };
  const local = useMemo(() => (branches ?? []).filter((b) => !b.remote), [branches]);
  const remote = useMemo(() => (branches ?? []).filter((b) => b.remote && !local.some((l) => b.name.endsWith(`/${l.name}`))), [branches, local]);
  if (error) return <EmptyState compact icon={GitBranch}>{describeError(error)}</EmptyState>;
  return (
    <div className="code-columns code-columns--graph">
      <div className="col" style={{ gap: 2, minWidth: 0 }}>
        <div className="row" style={{ marginBottom: 4 }}>
          <span className="section-title">Branches</span>
          <span className="spacer" />
          <Button
            size="sm"
            icon={Plus}
            onClick={async () => {
              const n = await prompt({ title: "New branch", placeholder: "feature/name", confirmLabel: "Create & switch" });
              if (n) void switchTo(n.trim(), true);
            }}
          >
            New branch
          </Button>
        </div>
        {!branches && <Skeleton height={60} />}
        {local.map((b) => (
          <button key={b.name} type="button" className="git-file" data-current={b.current || undefined} disabled={b.current} onClick={() => void switchTo(b.name)} title={b.current ? "Current branch" : `Switch to ${b.name}`}>
            <GitBranch size={14} className="faint" />
            <span className="truncate grow">{b.name}</span>
            {b.current && <span className="chip">Current</span>}
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
              {b.date ? relativeTime(Date.parse(b.date)) : ""}
            </span>
          </button>
        ))}
        {remote.length > 0 && (
          <button type="button" className="mini-more" style={{ alignSelf: "flex-start" }} onClick={() => setShowRemote(!showRemote)}>
            {showRemote ? "Hide" : "Show"} {remote.length} remote branch{remote.length === 1 ? "" : "es"}
          </button>
        )}
        {showRemote &&
          remote.map((b) => (
            <button key={b.name} type="button" className="git-file" onClick={() => void switchTo(b.name)} title={`Check out ${b.name}`}>
              <GitBranch size={14} className="faint" />
              <span className="truncate grow faint">{b.name}</span>
            </button>
          ))}
      </div>
      <History repo={repo} />
    </div>
  );
}

const ROW_H = 30;
const LANE_W = 14;
const hue = (n: number) => `var(--hue-${n % 8})`;
const laneX = (lane: number) => 9 + lane * LANE_W;

/** One segment of a lane line; lane changes curve smoothly. */
function segment(e: Edge, y1: number, y2: number) {
  const x1 = laneX(e.from);
  const x2 = laneX(e.to);
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const m = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${m} ${x2} ${m} ${x2} ${y2}`;
}

/** Commit history drawn as a graph: lanes, merges and branch/tag labels. */
function History({ repo }: { repo: Repository }) {
  const [all, setAll] = useState(true);
  const [limit, setLimit] = useState(80);
  const { data: log, error, isFetching } = useQuery({
    queryKey: ["git", "log", repo.id, all, limit],
    queryFn: () => api.git.log(repo.id, limit, all),
    retry: false,
    placeholderData: (prev) => prev,
  });
  const layout = useMemo(() => (log ? layoutGraph(log) : null), [log]);
  const graphW = layout ? laneX(Math.max(layout.width, 1) - 1) + 9 : 0;

  return (
    <div className="col" style={{ gap: 2, minWidth: 0 }}>
      <div className="row" style={{ marginBottom: 4, gap: 8 }}>
        <span className="section-title">History</span>
        <span className="spacer" />
        <Segmented
          size="sm"
          value={all ? "all" : "current"}
          onChange={(v) => setAll(v === "all")}
          ariaLabel="Branches shown"
          options={[
            { value: "all", label: "All branches" },
            { value: "current", label: "Current branch" },
          ]}
        />
      </div>
      {error && <span className="faint">{describeError(error, "Couldn't read the history.")}</span>}
      {!log && !error && <Skeleton height={120} />}
      {log?.length === 0 && <span className="faint">No commits yet.</span>}
      {log && layout && log.length > 0 && (
        <div className="git-graph" role="list" aria-label="Commit history">
          {log.map((c, i) => (
            <CommitRow key={c.hash} c={c} row={layout.rows[i]} width={graphW} />
          ))}
        </div>
      )}
      {log && log.length >= limit && limit < 500 && (
        <button type="button" className="mini-more" style={{ alignSelf: "flex-start" }} disabled={isFetching} onClick={() => setLimit((n) => Math.min(500, n + 120))}>
          {isFetching ? "Loading…" : "Load older commits"}
        </button>
      )}
    </div>
  );
}

function CommitRow({ c, row, width }: { c: GitCommit; row: ReturnType<typeof layoutGraph>["rows"][number]; width: number }) {
  const refs = parseRefs(c.refs);
  const merge = c.parents.length > 1;
  const mid = ROW_H / 2;
  return (
    <div className="git-graph__row" role="listitem" title={`${c.hash}\n${c.author} · ${new Date(c.date).toLocaleString()}`}>
      <svg className="git-graph__lanes" width={width} height={ROW_H} aria-hidden>
        {row.top.map((e, j) => (
          <path key={`t${j}`} d={segment(e, 0, mid)} stroke={hue(e.color)} />
        ))}
        {row.bottom.map((e, j) => (
          <path key={`b${j}`} d={segment(e, mid, ROW_H)} stroke={hue(e.color)} />
        ))}
        <circle cx={laneX(row.lane)} cy={mid} r={merge ? 3.5 : 4} fill={merge ? "var(--bg)" : hue(row.color)} stroke={hue(row.color)} strokeWidth={merge ? 2 : 0} />
      </svg>
      {refs.map((r) => (
        <span key={r.kind + r.name} className="ref-chip" data-kind={r.kind} style={{ "--chip": hue(row.color) } as CSSProperties}>
          {r.kind === "tag" ? <Tag size={10} /> : r.kind === "head" ? <GitBranch size={10} /> : null}
          {r.name}
        </span>
      ))}
      <span className="truncate grow git-graph__subject" data-merge={merge || undefined}>
        {c.subject}
      </span>
      <span className="faint truncate git-graph__author">{c.author}</span>
      <button type="button" className="faint mono git-graph__hash" onClick={() => void copyText(c.hash, "Commit hash")} title="Copy full hash">
        {c.short}
      </button>
      <span className="faint git-graph__time">{relativeTime(Date.parse(c.date))}</span>
    </div>
  );
}

// ------------------------------------------------------------ pull requests

const CHECKS: Record<PullInfo["checks"], { icon: typeof CircleCheck; label: string }> = {
  success: { icon: CircleCheck, label: "Checks passed" },
  failure: { icon: CircleX, label: "Checks failed" },
  pending: { icon: CircleDashed, label: "Checks running" },
  none: { icon: CircleDashed, label: "No checks" },
};

const REVIEW: Record<PullInfo["review"], string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  commented: "Reviewed",
  none: "Awaiting review",
};

function Pulls({ project, repo }: { project: Project; repo: Repository }) {
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ["github", "pulls", project.id, repo.github], queryFn: () => api.github.pulls(project.id, repo.github), retry: false, staleTime: 60_000 });
  if (error) return <EmptyState compact icon={GitPullRequest}>{describeError(error, "Couldn't load pull requests.")}</EmptyState>;
  if (!data) return <Skeleton height={80} />;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row">
        <span className="section-title">
          Open pull requests <span className="count">{data.length}</span>
        </span>
        <span className="spacer" />
        <IconButton icon={RefreshCw} label="Refresh" size="sm" className={isFetching ? "spin" : undefined} onClick={() => void refetch()} />
      </div>
      {!data.length && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No open pull requests.</span>}
      {data.map((p) => {
        const C = CHECKS[p.checks];
        return (
          <div key={p.number} className="pull" data-draft={p.draft || undefined}>
            <GitPullRequest size={15} className="faint" style={{ marginTop: 2 }} />
            <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
              <button type="button" className="pull__title truncate" onClick={() => void openLink(p.htmlUrl)}>
                {p.title} <span className="faint">#{p.number}</span>
              </button>
              <span className="faint pull__meta">
                {p.draft ? "Draft · " : ""}
                {p.author} · {p.head} → {p.base} · updated {relativeTime(Date.parse(p.updatedAt))}
              </span>
              {p.linkedTasks.length > 0 && (
                <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {p.linkedTasks.map((t) => (
                    <button key={t.id} type="button" className="chip chip-btn" onClick={() => openTask(t.id)}>
                      <Link2 size={11} /> {t.title}
                      {t.done && " ✓"}
                    </button>
                  ))}
                </span>
              )}
            </div>
            <Tooltip content={C.label}>
              <span className="pull__checks" data-state={p.checks}>
                <C.icon size={14} />
              </span>
            </Tooltip>
            <span className="pull__review" data-state={p.review}>
              {REVIEW[p.review]}
            </span>
          </div>
        );
      })}
      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        Pull requests link to tasks when they mention an issue (for example “Fixes #12”) or the branch starts with its number.
      </span>
    </div>
  );
}

/** README from a local repository without GitHub. */
function LocalReadme({ project, repo }: { project: Project; repo: Repository }) {
  const { data } = useQuery({
    queryKey: ["files", "readme", repo.id],
    queryFn: async () => {
      for (const n of ["README.md", "readme.md", "README.markdown", "README.txt", "README"]) {
        const r = await api.folders.read(project.id, n, repo.id).catch(() => null);
        if (r) return r.text.slice(0, 64 * 1024);
      }
      return null;
    },
    staleTime: 5 * 60_000,
  });
  return data ? <Readme text={data} source="local" /> : null;
}
