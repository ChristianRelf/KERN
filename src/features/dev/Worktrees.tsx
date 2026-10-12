// Git worktrees: the list comes from git (including worktrees made outside
// Kern), creation in a compact dialog, and removal only after showing what
// would be affected. Kern never removes a dirty worktree without explicit
// confirmation, never removes a locked one and only deletes a branch with
// `git branch -d` (which refuses unmerged work).

import { Bot, Code2, Ellipsis, FolderGit2, FolderOpen, GitBranch, Lock, Pencil, Plus, Scissors, SquareCheckBig, TerminalSquare, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { useQuery } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Project, Repository, Task, Worktree, WorktreeInspection } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { useTasks } from "@/hooks/data";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { Dialog, prompt } from "@/components/ui/Dialog";
import { Checkbox, EmptyState, Popover, Segmented, Select, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { FilterList } from "@/features/tasks/pickers";
import { openTask } from "@/features/tasks/menu";
import { shortPath } from "@/features/projects/folders";
import { relativeTime } from "@/lib/dates";
import { openTerminal } from "@/features/terminal/store";
import { useRepos, useWorktrees } from "./hooks";
import { suggestBranchName, useBranchCheck } from "./branches";

const refresh = () => invalidate("worktrees", "devlinks", "task", "tasks", "capabilities", "git");

// ------------------------------------------------------------ list

export function WorktreesSection({ project, repo }: { project: Project; repo: Repository }) {
  const { data, error, isFetching, refetch } = useWorktrees(repo.id);
  const [removing, setRemoving] = useState<Worktree | null>(null);
  const prunable = (data ?? []).filter((w) => w.prunable).length;
  if (error) return <EmptyState compact icon={FolderGit2}>{describeError(error, "Couldn't list worktrees.")}</EmptyState>;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <span className="section-title">
          Worktrees <span className="count">{data?.length ?? 0}</span>
        </span>
        <span className="spacer" />
        {prunable > 0 && (
          <Tooltip content="Removes git's records of worktrees whose folders no longer exist. No files are deleted.">
            <Button size="sm" variant="ghost" icon={Scissors} onClick={() => void api.worktrees.prune(repo.id).then(refresh).catch((e) => toastError(describeError(e)))}>
              Clean up {prunable} missing
            </Button>
          </Tooltip>
        )}
        <Button size="sm" icon={Plus} onClick={() => openWorktreeDialog({ projectId: project.id, repositoryId: repo.id })}>
          New worktree
        </Button>
      </div>
      {!data ? (
        <Skeleton height={60} />
      ) : (
        <div className="col" style={{ gap: 2 }} data-loading={isFetching || undefined}>
          {data.map((w) => (
            <WorktreeRow key={w.path} project={project} repo={repo} w={w} onRemove={() => setRemoving(w)} onChanged={() => void refetch()} />
          ))}
          {data.length <= 1 && (
            <span className="faint" style={{ fontSize: "var(--fs-sm)", padding: "6px 0" }}>
              A worktree is a second working folder on its own branch, so you (or an assistant) can work on something without touching your main checkout.
            </span>
          )}
        </div>
      )}
      {removing && <RemoveWorktreeDialog repo={repo} w={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function WorktreeRow({ project, repo, w, onRemove, onChanged }: { project: Project; repo: Repository; w: Worktree; onRemove: () => void; onChanged: () => void }) {
  const [taskOpen, setTaskOpen] = useState(false);
  const { data: tasks } = useTasks({ projectIds: [project.id], topLevelOnly: true, order: "updated", limit: 200 }, { enabled: taskOpen });
  const update = async (patch: Parameters<typeof api.worktrees.update>[2]) => {
    try {
      await api.worktrees.update(repo.id, w.path, patch);
      refresh();
      onChanged();
    } catch (e) {
      toastError(describeError(e));
    }
  };
  const dirty = (w.changed ?? 0) + (w.untracked ?? 0);
  const menu: MenuItems = [
    !w.prunable && { label: "Open terminal here", icon: TerminalSquare, onSelect: () => void openTerminal({ projectId: project.id, cwd: { kind: "worktree", repositoryId: repo.id, path: w.path }, title: w.name }) },
    !w.prunable && { label: "Open in editor", icon: Code2, onSelect: () => void api.worktrees.openInEditor(w.path).catch((e) => toastError(describeError(e))) },
    !w.prunable && { label: "Reveal in Explorer", icon: FolderOpen, onSelect: () => void api.system.reveal(w.path).catch((e) => toastError(describeError(e))) },
    {
      label: "Rename…",
      icon: Pencil,
      onSelect: async () => {
        const alias = await prompt({ title: "Worktree name", initial: w.alias ?? w.name });
        if (alias !== null) void update({ alias: alias.trim() || null });
      },
    },
    {
      label: w.agent ? "Change assistant label…" : "Assign to an assistant…",
      icon: Bot,
      onSelect: async () => {
        const agent = await prompt({ title: "Assistant working here", initial: w.agent ?? "", placeholder: "e.g. Claude Code session", label: "A label only — Kern never starts assistants or commands by itself." });
        if (agent !== null) void update({ agent: agent.trim() || null });
      },
    },
    !w.isMain && { type: "separator" },
    !w.isMain && { label: "Remove…", icon: Trash2, danger: true, onSelect: onRemove },
  ];
  return (
    <div className="wt-row" data-missing={w.prunable || undefined}>
      <FolderGit2 size={15} className="faint" />
      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="row" style={{ gap: 6, minWidth: 0 }}>
          <span className="truncate" style={{ fontWeight: 550 }}>
            {w.name}
          </span>
          {w.isMain && <span className="chip">Main</span>}
          {w.locked !== null && (
            <Tooltip content={w.locked || "Locked"}>
              <Lock size={12} className="faint" />
            </Tooltip>
          )}
          {w.prunable && <span className="chip">Folder missing</span>}
          {w.agent && (
            <span className="chip">
              <Bot size={11} /> {w.agent}
            </span>
          )}
        </span>
        <span className="row faint" style={{ gap: 8, fontSize: "var(--fs-xs)", minWidth: 0 }}>
          <span className="row" style={{ gap: 4 }}>
            <GitBranch size={12} /> {w.branch ?? (w.detached ? `detached ${w.head?.slice(0, 7) ?? ""}` : "—")}
          </span>
          {dirty > 0 && <span className="dirty-dot">{dirty} changed</span>}
          {(w.ahead ?? 0) > 0 && <span>↑{w.ahead}</span>}
          {(w.behind ?? 0) > 0 && <span>↓{w.behind}</span>}
          <span className="truncate mono">{shortPath(w.path, 48)}</span>
          {w.lastActivity && <span>{relativeTime(w.lastActivity)}</span>}
        </span>
      </span>
      <Popover
        open={taskOpen}
        onOpenChange={setTaskOpen}
        align="end"
        trigger={
          <button type="button" className="prop-btn wt-row__task" data-empty={!w.taskId}>
            <SquareCheckBig size={13} />
            <span className="truncate">{w.taskTitle ?? "No task"}</span>
          </button>
        }
      >
        <FilterList<Task | { id: null; title: string }>
          items={[{ id: null, title: "No task" }, ...(tasks ?? [])]}
          placeholder="Associate a task…"
          getKey={(t) => t.id ?? "none"}
          getText={(t) => t.title}
          onPick={(t) => {
            setTaskOpen(false);
            void update({ taskId: t.id });
          }}
          render={(t) => <span className="truncate grow">{t.title}</span>}
        />
      </Popover>
      {w.taskId && <IconButton icon={SquareCheckBig} label="Open task" size="sm" onClick={() => openTask(w.taskId!)} />}
      <Dropdown items={menu} align="end">
        <IconButton icon={Ellipsis} label="Worktree actions" size="sm" noTooltip />
      </Dropdown>
    </div>
  );
}

// ------------------------------------------------------------ removal

function RemoveWorktreeDialog({ repo, w, onClose }: { repo: Repository; w: Worktree; onClose: () => void }) {
  const { data: info, error } = useQuery({ queryKey: ["worktrees", "inspect", repo.id, w.path], queryFn: () => api.worktrees.inspect(repo.id, w.path), retry: false, gcTime: 0 });
  const [discard, setDiscard] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = info ? info.modifiedCount + info.untrackedCount > 0 : false;
  const blocked = !!info && (info.isMain || info.locked !== null || info.inUse.length > 0);
  const branchDeletable = !!info?.branch && info.merged === true && (info.unpushed ?? 0) === 0;
  const remove = async () => {
    setBusy(true);
    try {
      const r = await api.worktrees.remove(repo.id, w.path, dirty && discard, deleteBranch && branchDeletable);
      refresh();
      toast(r.branchDeleted ? `Removed ${w.name} and its branch` : `Removed ${w.name}`);
      if (r.branchNote) toast(r.branchNote);
      onClose();
    } catch (e) {
      toastError(describeError(e, "Couldn't remove the worktree."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Remove the ${w.name} worktree?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!info || blocked || busy || (dirty && !discard)} onClick={() => void remove()}>
            {dirty ? "Discard changes and remove" : "Remove worktree"}
          </Button>
        </>
      }
    >
      {error && <span className="faint">{describeError(error)}</span>}
      {!info && !error && <Skeleton height={60} />}
      {info && <Inspection info={info} />}
      {info && !blocked && (
        <div className="col" style={{ gap: 8 }}>
          {dirty && (
            <label className="row danger-check" style={{ gap: 8 }}>
              <Checkbox checked={discard} onChange={setDiscard} label="Discard uncommitted work" />
              <span>
                Discard {info.modifiedCount} changed and {info.untrackedCount} untracked file{info.modifiedCount + info.untrackedCount === 1 ? "" : "s"}. This can't be undone.
              </span>
            </label>
          )}
          {info.branch && (
            <label className="row" style={{ gap: 8, opacity: branchDeletable ? 1 : 0.6 }}>
              <Checkbox checked={deleteBranch && branchDeletable} onChange={setDeleteBranch} label="Also delete the branch" disabled={!branchDeletable} />
              <span>
                Also delete the branch <span className="mono">{info.branch}</span>
                {!branchDeletable && <span className="faint"> — kept, because {info.merged === false ? "it isn't merged" : "it has commits no remote has"}</span>}
              </span>
            </label>
          )}
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            The worktree's folder is removed by git. Your main checkout and other worktrees aren't affected.
          </span>
        </div>
      )}
    </Dialog>
  );
}

function Inspection({ info }: { info: WorktreeInspection }) {
  const lines: React.ReactNode[] = [];
  if (info.isMain) lines.push("This is the repository's main working tree; it can't be removed.");
  if (info.locked !== null) lines.push(`It's locked${info.locked ? ` (${info.locked})` : ""}. Unlock it with git first if you really want to remove it.`);
  if (info.inUse.length) lines.push(`It's in use by ${info.inUse.join(", ")}. Close that first.`);
  if (info.unpushed) lines.push(`${info.unpushed} commit${info.unpushed === 1 ? "" : "s"} on ${info.branch} aren't on any remote (they stay in the repository unless the branch is deleted).`);
  return (
    <div className="col" style={{ gap: 6 }}>
      <span className="mono faint selectable" style={{ fontSize: "var(--fs-xs)" }}>
        {info.path}
      </span>
      {lines.map((l, i) => (
        <span key={i} className="row" style={{ gap: 6, alignItems: "flex-start", fontSize: "var(--fs-sm)" }}>
          <TriangleAlert size={13} style={{ flexShrink: 0, marginTop: 2 }} /> {l}
        </span>
      ))}
      {info.modifiedCount + info.untrackedCount > 0 && (
        <div className="wt-files">
          {[...info.modified.map((f) => ["M", f]), ...info.untracked.map((f) => ["?", f])].slice(0, 30).map(([k, f]) => (
            <span key={f} className="mono">
              <b className="faint">{k}</b> {f}
            </span>
          ))}
          {info.modifiedCount + info.untrackedCount > 30 && <span className="faint">…and {info.modifiedCount + info.untrackedCount - 30} more</span>}
        </div>
      )}
      {!info.modifiedCount && !info.untrackedCount && !info.isMain && <span style={{ fontSize: "var(--fs-sm)" }}>No uncommitted or untracked files.</span>}
    </div>
  );
}

// ------------------------------------------------------------ creation

interface DialogReq {
  projectId: string;
  repositoryId?: string;
  taskId?: string | null;
  taskTitle?: string | null;
  issueNumber?: number | null;
  /** Called with the new worktree. */
  onCreated?: (w: Worktree) => void;
}

const useWtDialog = create<{ req: DialogReq | null }>(() => ({ req: null }));
export const openWorktreeDialog = (req: DialogReq) => useWtDialog.setState({ req });

export function WorktreeDialogHost() {
  const req = useWtDialog((s) => s.req);
  return req ? <CreateWorktreeDialog req={req} onClose={() => useWtDialog.setState({ req: null })} /> : null;
}

function CreateWorktreeDialog({ req, onClose }: { req: DialogReq; onClose: () => void }) {
  const { data: repos } = useRepos(req.projectId);
  const eligible = (repos ?? []).filter((r) => r.localPath && r.localStatus === "ok" && r.trust === "trusted");
  const [repoId, setRepoId] = useState(req.repositoryId ?? "");
  const repo = eligible.find((r) => r.id === repoId) ?? eligible[0];
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [branch, setBranch] = useState(() => (req.taskTitle ? suggestBranchName(req.taskTitle, req.issueNumber) : ""));
  const [base, setBase] = useState("");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [alias, setAlias] = useState("");
  const [trust, setTrust] = useState(true);
  const [busy, setBusy] = useState(false);
  const { data: branches } = useQuery({ queryKey: ["git", "branches", repo?.id], queryFn: () => api.git.branches(repo!.id), enabled: !!repo, retry: false });
  const { data: defaultBase } = useQuery({ queryKey: ["git", "base", repo?.id], queryFn: () => api.git.defaultBase(repo!.id), enabled: !!repo, retry: false });
  const check = useBranchCheck(repo?.id, branch);
  const local = useMemo(() => (branches ?? []).filter((b) => !b.remote), [branches]);

  useEffect(() => {
    if (!repo || pathEdited || !branch.trim()) return;
    const t = window.setTimeout(() => void api.worktrees.defaultPath(repo.id, branch.trim()).then(setPath).catch(() => undefined), 200);
    return () => window.clearTimeout(t);
  }, [repo?.id, branch, pathEdited]);

  const valid = !!repo && !!branch.trim() && !!path.trim() && (mode === "new" ? check?.valid && !check.exists : local.some((b) => b.name === branch.trim()));

  const submit = async () => {
    if (!repo || !valid) return;
    setBusy(true);
    try {
      const w = await api.worktrees.create({ repositoryId: repo.id, branch: branch.trim(), newBranch: mode === "new", base: mode === "new" ? base.trim() || defaultBase || null : null, path: path.trim(), taskId: req.taskId ?? null, alias: alias.trim() || null, trust });
      refresh();
      toast(`Created worktree ${w.name}`);
      req.onCreated?.(w);
      onClose();
    } catch (e) {
      toastError(describeError(e, "Couldn't create the worktree."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New worktree"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create worktree"}
          </Button>
        </>
      }
    >
      {!eligible.length ? (
        <span className="faint">Worktrees need a linked local repository in a trusted folder.</span>
      ) : (
        <>
          {eligible.length > 1 && (
            <div className="field">
              <label className="field__label">Repository</label>
              <Select value={repo?.id ?? ""} onChange={setRepoId} options={eligible.map((r) => ({ value: r.id, label: r.name }))} ariaLabel="Repository" />
            </div>
          )}
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            ariaLabel="Branch"
            options={[
              { value: "new", label: "New branch" },
              { value: "existing", label: "Existing branch" },
            ]}
          />
          <div className="field">
            <label className="field__label">Branch</label>
            {mode === "new" ? (
              <>
                <input className="input mono" autoFocus value={branch} placeholder="feature/name" onChange={(e) => setBranch(e.target.value)} aria-label="Branch name" />
                {branch.trim() && check && (check.message || !check.valid) && <span className="field__hint" data-error>{check.message ?? "That isn't a valid branch name."}</span>}
              </>
            ) : (
              <Select value={branch} onChange={setBranch} placeholder="Choose a branch" options={local.map((b) => ({ value: b.name, label: b.name }))} ariaLabel="Existing branch" />
            )}
          </div>
          {mode === "new" && (
            <div className="field">
              <label className="field__label">Start from</label>
              <input className="input mono" list="wt-bases" value={base} placeholder={defaultBase ?? "HEAD"} onChange={(e) => setBase(e.target.value)} aria-label="Base branch or commit" />
              <datalist id="wt-bases">
                {(branches ?? []).map((b) => (
                  <option key={b.name} value={b.name} />
                ))}
              </datalist>
            </div>
          )}
          <div className="field">
            <label className="field__label">Folder</label>
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono grow" value={path} onChange={(e) => (setPath(e.target.value), setPathEdited(true))} aria-label="Worktree folder" />
              <IconButton
                icon={FolderOpen}
                label="Choose folder"
                onClick={async () => {
                  const picked = await openDialog({ directory: true, title: "Choose where to put the worktree" });
                  if (typeof picked === "string") {
                    const leaf = branch.trim().split("/").pop() || "worktree";
                    setPath(`${picked}${picked.includes("\\") ? "\\" : "/"}${leaf}`);
                    setPathEdited(true);
                  }
                }}
              />
            </div>
          </div>
          <div className="field">
            <label className="field__label">Name (optional)</label>
            <input className="input" value={alias} placeholder={branch.split("/").pop() || "Worktree"} onChange={(e) => setAlias(e.target.value)} aria-label="Worktree name" />
          </div>
          {req.taskTitle && (
            <span className="faint row" style={{ gap: 6, fontSize: "var(--fs-sm)" }}>
              <SquareCheckBig size={13} /> Linked to {req.taskTitle}
            </span>
          )}
          <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
            <Checkbox checked={trust} onChange={setTrust} label="Trust the new folder" />
            Trust the new folder (it shares {repo?.name}'s git configuration)
          </label>
        </>
      )}
    </Dialog>
  );
}
