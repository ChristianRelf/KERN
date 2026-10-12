// Project → Code: the connected GitHub repository and the linked local
// clone. Overview (README, languages, TODO scan), changes with diffs,
// branches and history, fetch/pull/push, and pull requests.

import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleDashed,
  CircleX,
  Ellipsis,
  FileDiff,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Link2,
  ListTodo,
  Plus,
  RefreshCw,
  ShieldHalf,
  Star,
  Unlink,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { GitChangedFile, Project, PullInfo, TodoItem } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { Checkbox, EmptyState, Segmented, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { confirm, prompt } from "@/components/ui/Dialog";
import { toast, toastError } from "@/stores/toast";
import { useSetting } from "@/stores/settings";
import { relativeTime } from "@/lib/dates";
import { openTask } from "@/features/tasks/menu";
import { createTask } from "@/features/tasks/actions";
import { linkFolder, setFolderTrust, useProjectFolder } from "@/features/projects/folders";
import { openLink } from "@/features/links/links";
import { GithubMark, cloneIntoProject, connectProject, syncProject, useGitRemote, useProjectRepo } from "./shared";

type Section = "overview" | "changes" | "branches" | "pulls";

export function CodeTab({ project }: { project: Project }) {
  const { data: repo } = useProjectRepo(project.id);
  const { data: remote } = useGitRemote(project);
  const { data: folder } = useProjectFolder(project.id, !!project.folderPath);
  const autoSync = useSetting("github.autoSync");
  const [section, setSection] = useState<Section>("overview");
  const [syncing, setSyncing] = useState(false);

  // Pull issue changes when the tab opens (at most every 10 minutes).
  useEffect(() => {
    if (!repo || !autoSync || !repo.syncIssues) return;
    if (repo.lastSyncedAt && Date.now() - repo.lastSyncedAt < 10 * 60_000) return;
    void syncProject(project.id, true);
  }, [repo?.projectId, autoSync]);

  const sync = async () => {
    setSyncing(true);
    await syncProject(project.id);
    setSyncing(false);
  };

  const localRepo = remote?.isRepo ?? false;
  const trusted = folder?.trust === "trusted" && folder.status === "ok";

  return (
    <div className="page-body page-body--pad code-tab">
      {repo ? (
        <div className="code-bar">
          <GithubMark size={16} />
          <button type="button" className="code-bar__repo" onClick={() => repo.htmlUrl && void openLink(repo.htmlUrl)}>
            {repo.fullName}
          </button>
          <span className="faint code-bar__meta">
            {repo.linkedIssues} linked issue{repo.linkedIssues === 1 ? "" : "s"}
            {" · "}
            {repo.syncIssues ? (repo.lastSyncedAt ? `synced ${relativeTime(repo.lastSyncedAt)}` : "not synced yet") : "issue sync paused"}
          </span>
          {repo.lastSyncError && (
            <Tooltip content={repo.lastSyncError}>
              <CircleX size={14} className="code-bar__error" aria-label="Last sync failed" />
            </Tooltip>
          )}
          <span className="spacer" />
          {repo.syncIssues && (
            <Button size="sm" icon={RefreshCw} className={syncing ? "spin" : undefined} disabled={syncing} onClick={() => void sync()}>
              Sync issues
            </Button>
          )}
          <Dropdown
            align="end"
            items={[
              { label: repo.syncIssues ? "Pause issue sync" : "Resume issue sync", onSelect: () => void api.github.update(project.id, { syncIssues: !repo.syncIssues }).then(() => invalidate("github")) },
              { label: "Include closed issues", checked: repo.importClosed, onSelect: () => void api.github.update(project.id, { importClosed: !repo.importClosed }).then(() => invalidate("github")) },
              !project.folderPath && { label: "Clone a local copy…", icon: FolderOpen, onSelect: () => void cloneIntoProject(project.id, repo.fullName) },
              { type: "separator" },
              {
                label: "Disconnect repository…",
                icon: Unlink,
                danger: true,
                onSelect: async () => {
                  if (!(await confirm({ title: `Disconnect ${repo.fullName}?`, message: "Imported tasks stay in the project as ordinary tasks. Nothing changes on GitHub.", confirmLabel: "Disconnect" }))) return;
                  await api.github.disconnect(project.id);
                  invalidate("github", "tasks", "task", "projects", "project");
                },
              },
            ]}
          >
            <IconButton icon={Ellipsis} label="Repository options" size="sm" noTooltip />
          </Dropdown>
        </div>
      ) : remote?.github ? (
        <div className="code-banner">
          <GithubMark size={16} />
          <span className="grow">
            This folder is a clone of <b>{remote.github}</b>. Connect it to sync issues with tasks and see pull requests.
          </span>
          <Button size="sm" variant="primary" onClick={() => void connectProject(project, remote.github!)}>
            Connect
          </Button>
        </div>
      ) : (
        <div className="code-banner">
          <GithubMark size={16} />
          <span className="grow">Connect a GitHub repository to turn its issues into tasks (in both directions) and follow pull requests.</span>
          <Button size="sm" onClick={() => void connectProject(project)}>
            Connect repository…
          </Button>
        </div>
      )}

      <Segmented
        size="sm"
        value={section}
        onChange={setSection}
        ariaLabel="Code section"
        options={[
          { value: "overview", label: "Overview" },
          { value: "changes", label: "Changes" },
          { value: "branches", label: "Branches & history" },
          { value: "pulls", label: "Pull requests" },
        ]}
      />

      {section === "overview" && <Overview project={project} connected={!!repo} />}
      {(section === "changes" || section === "branches") && (
        <LocalGate project={project} hasRepo={!!repo} repoName={repo?.fullName} localRepo={localRepo} trusted={trusted}>
          {section === "changes" ? <Changes project={project} /> : <Branches project={project} />}
        </LocalGate>
      )}
      {section === "pulls" &&
        (repo ? (
          <Pulls project={project} />
        ) : (
          <EmptyState compact icon={GitPullRequest}>
            Connect a GitHub repository to see its pull requests.
          </EmptyState>
        ))}
    </div>
  );
}

/** Git tools need a linked folder that's a repository and trusted. */
function LocalGate({
  project,
  hasRepo,
  repoName,
  localRepo,
  trusted,
  children,
}: {
  project: Project;
  hasRepo: boolean;
  repoName?: string;
  localRepo: boolean;
  trusted: boolean;
  children: React.ReactNode;
}) {
  const { data: folder } = useProjectFolder(project.id, !!project.folderPath);
  if (!project.folderPath)
    return (
      <EmptyState compact icon={FolderOpen} action={hasRepo && repoName ? <Button onClick={() => void cloneIntoProject(project.id, repoName)}>Clone a local copy…</Button> : <Button onClick={() => void linkFolder(project)}>Link a folder…</Button>}>
        Git tools work on a local copy of the code.
      </EmptyState>
    );
  if (!localRepo)
    return (
      <EmptyState compact icon={GitBranch}>
        The linked folder isn't a git repository.
      </EmptyState>
    );
  if (!trusted)
    return (
      <EmptyState compact icon={ShieldHalf} action={folder && <Button onClick={() => void setFolderTrust(project.id, "trusted", folder)}>Trust folder…</Button>}>
        Git tools run git in the folder, and a repository can run its own scripts through git (hooks and filters). Trust the folder to use them.
      </EmptyState>
    );
  return <>{children}</>;
}

// ------------------------------------------------------------ overview

function Overview({ project, connected }: { project: Project; connected: boolean }) {
  const { data: ov, error, isLoading } = useQuery({ queryKey: ["github", "overview", project.id], queryFn: () => api.github.overview(project.id), enabled: connected, staleTime: 10 * 60_000, retry: false });
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
                      <span key={l} style={{ width: `${(b / total) * 100}%`, opacity: 1 - i * 0.14 }} />
                    ))}
                  </div>
                  <div className="row faint" style={{ gap: 12, fontSize: "var(--fs-xs)", flexWrap: "wrap" }}>
                    {ov.languages.slice(0, 6).map(([l, b]) => (
                      <span key={l}>
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
      {project.folderPath ? <TodoScan project={project} /> : !connected && <EmptyState compact icon={ListTodo}>Link the project's folder to scan its code for TODO comments.</EmptyState>}
    </div>
  );
}

function Readme({ text, source }: { text: string; source: "local" | "github" | null }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const shown = open ? lines : lines.slice(0, 18);
  return (
    <div className="readme">
      <div className="readme__head">
        README <span className="faint">· {source === "local" ? "from your local copy" : "from GitHub"}</span>
      </div>
      <pre className="readme__body selectable">{shown.join("\n")}</pre>
      {lines.length > 18 && (
        <button type="button" className="mini-more" onClick={() => setOpen(!open)}>
          {open ? "Show less" : `Show all ${lines.length} lines`}
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

function Changes({ project }: { project: Project }) {
  const { data: st, error, refetch, isFetching } = useQuery({ queryKey: ["git", "status", project.id], queryFn: () => api.git.status(project.id), retry: false, refetchOnWindowFocus: true });
  const [open, setOpen] = useState<{ path: string; staged: boolean; untracked: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: "fetch" | "pull" | "push") => {
    setBusy(action);
    try {
      await api.git.sync(project.id, action);
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
                    {isOpen && <Diff projectId={project.id} {...key} />}
                  </div>
                );
              })}
            </div>
          ),
      )}
    </div>
  );
}

function Diff({ projectId, path, staged, untracked }: { projectId: string; path: string; staged: boolean; untracked: boolean }) {
  const { data, error } = useQuery({ queryKey: ["git", "diff", projectId, path, staged], queryFn: () => api.git.diff(projectId, path, staged, untracked), retry: false });
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

function Branches({ project }: { project: Project }) {
  const { data: branches, error } = useQuery({ queryKey: ["git", "branches", project.id], queryFn: () => api.git.branches(project.id), retry: false });
  const { data: log } = useQuery({ queryKey: ["git", "log", project.id], queryFn: () => api.git.log(project.id, 40), retry: false });
  const [showRemote, setShowRemote] = useState(false);
  const switchTo = async (name: string, create = false) => {
    try {
      await api.git.switch(project.id, name, create);
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
    <div className="code-columns">
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
      <div className="col" style={{ gap: 2, minWidth: 0 }}>
        <span className="section-title" style={{ marginBottom: 4 }}>
          Recent commits
        </span>
        {!log && <Skeleton height={80} />}
        {log?.length === 0 && <span className="faint">No commits yet.</span>}
        {log?.map((c) => (
          <div key={c.hash} className="git-commit">
            <GitCommitHorizontal size={14} className="faint" />
            <span className="truncate grow">{c.subject}</span>
            <span className="faint truncate" style={{ fontSize: "var(--fs-xs)", maxWidth: 120 }}>
              {c.author}
            </span>
            <span className="faint mono" style={{ fontSize: "var(--fs-xs)" }}>
              {c.short}
            </span>
            <span className="faint" style={{ fontSize: "var(--fs-xs)", width: 64, textAlign: "right" }}>
              {relativeTime(Date.parse(c.date))}
            </span>
          </div>
        ))}
      </div>
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

function Pulls({ project }: { project: Project }) {
  const { data, error, isFetching, refetch } = useQuery({ queryKey: ["github", "pulls", project.id], queryFn: () => api.github.pulls(project.id), retry: false, staleTime: 60_000 });
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
