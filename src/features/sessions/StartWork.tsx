// Start Work on a task. In any project it starts a work session. When the
// project has a trusted local repository it also offers to work on the
// current branch, create a branch, create a worktree, or reuse an existing
// branch or worktree - and links the choice to the task. Nothing is
// committed, pushed or merged, and no command or assistant is started.

import { FolderGit2, GitBranch, GitBranchPlus, Play, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Repository, Task } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { useUi } from "@/stores/ui";
import { toast, toastError } from "@/stores/toast";
import { useLabelMap, useTask } from "@/hooks/data";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Checkbox, Select, Skeleton } from "@/components/ui/Controls";
import { useRepoSummary, useRepos, useWorktrees } from "@/features/dev/hooks";
import { suggestBranchName, uniqueBranch, useBranchCheck } from "@/features/dev/branches";
import { openWorktreeDialog } from "@/features/dev/worktreeDialog";
import { startSession } from "./SessionUi";

type Mode = "session" | "current" | "branch" | "worktree" | "existingBranch" | "existingWorktree";

const usable = (r: Repository) => !!r.localPath && r.localStatus === "ok" && r.trust === "trusted";

/** Start Work: a plain session unless the project has git tools to offer. */
export async function startWork(task: Pick<Task, "id" | "projectId" | "title">) {
  const repos = task.projectId ? await api.repos.list(task.projectId).catch(() => []) : [];
  if (!repos.some(usable)) {
    await startSession({ taskId: task.id, projectId: task.projectId });
    return;
  }
  useUi.getState().set({ startWorkTaskId: task.id });
}

export function StartWorkHost() {
  const id = useUi((s) => s.startWorkTaskId);
  const { data: task } = useTask(id);
  if (!id) return null;
  const close = () => useUi.getState().set({ startWorkTaskId: null });
  if (!task) return null;
  return <StartWorkDialog task={task} onClose={close} />;
}

function StartWorkDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { data: repos } = useRepos(task.projectId);
  const labelMap = useLabelMap();
  const eligible = (repos ?? []).filter(usable);
  const linkedRepo = task.devLinks?.find((l) => l.repositoryId && eligible.some((r) => r.id === l.repositoryId))?.repositoryId;
  const [repoId, setRepoId] = useState<string>("");
  const repo = eligible.find((r) => r.id === repoId) ?? eligible.find((r) => r.id === linkedRepo) ?? eligible[0];
  const { data: summary } = useRepoSummary(repo?.id);
  const { data: branches } = useQuery({ queryKey: ["git", "branches", repo?.id], queryFn: () => api.git.branches(repo!.id), enabled: !!repo, retry: false });
  const { data: worktrees } = useWorktrees(repo?.id, !!repo);
  const { data: defaultBase } = useQuery({ queryKey: ["git", "base", repo?.id], queryFn: () => api.git.defaultBase(repo!.id), enabled: !!repo, retry: false });
  const local = useMemo(() => (branches ?? []).filter((b) => !b.remote), [branches]);
  const linkedBranch = task.devLinks?.find((l) => l.kind === "branch")?.ref;
  const [mode, setMode] = useState<Mode>(linkedBranch ? "existingBranch" : "branch");
  const suggested = useMemo(
    () => uniqueBranch(suggestBranchName(task.title, task.issue?.number, task.labelIds.map((l) => labelMap.get(l)?.name ?? "")), new Set(local.map((b) => b.name))),
    [task.title, task.issue?.number, local, labelMap],
  );
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [switchTo, setSwitchTo] = useState(true);
  const [existing, setExisting] = useState(linkedBranch ?? "");
  const [wtPath, setWtPath] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(suggested), [suggested]);
  const check = useBranchCheck(repo?.id, name);
  const dirty = summary?.available ? summary.changed + summary.untracked : 0;
  const otherWorktrees = (worktrees ?? []).filter((w) => !w.isMain && !w.prunable);

  const done = (msg: string) => {
    invalidate("devlinks", "task", "tasks", "git", "worktrees");
    toast(msg);
    onClose();
  };

  const go = async () => {
    if (!repo && mode !== "session") return;
    setBusy(true);
    try {
      const link = (kind: "branch" | "worktree" | "repository", ref: string) => api.devLinks.add({ taskId: task.id, kind, repositoryId: repo!.id, ref });
      switch (mode) {
        case "session":
          await startSession({ taskId: task.id, projectId: task.projectId });
          onClose();
          return;
        case "current": {
          const b = summary?.branch ?? null;
          if (b) await link("branch", b);
          await startSession({ taskId: task.id, projectId: task.projectId, repositoryId: repo!.id, branch: b });
          return done(b ? `Working on ${b}` : "Session started");
        }
        case "branch": {
          await api.git.createBranch(repo!.id, name.trim(), base.trim() || defaultBase || null, switchTo);
          await link("branch", name.trim());
          await startSession({ taskId: task.id, projectId: task.projectId, repositoryId: repo!.id, branch: name.trim() });
          return done(switchTo ? `Created and switched to ${name.trim()}` : `Created ${name.trim()}`);
        }
        case "existingBranch": {
          if (switchTo && summary?.branch !== existing) await api.git.switch(repo!.id, existing);
          await link("branch", existing);
          await startSession({ taskId: task.id, projectId: task.projectId, repositoryId: repo!.id, branch: existing });
          return done(`Working on ${existing}`);
        }
        case "existingWorktree": {
          const w = otherWorktrees.find((x) => x.path === wtPath);
          if (!w) return;
          await api.worktrees.update(repo!.id, w.path, { taskId: task.id });
          if (w.branch) await link("branch", w.branch);
          await startSession({ taskId: task.id, projectId: task.projectId, repositoryId: repo!.id, branch: w.branch, worktreeId: w.id });
          return done(`Working in ${w.name}`);
        }
        case "worktree":
          onClose();
          openWorktreeDialog({
            projectId: task.projectId!,
            repositoryId: repo!.id,
            taskId: task.id,
            taskTitle: task.title,
            issueNumber: task.issue?.number ?? null,
            onCreated: (w) => void startSession({ taskId: task.id, projectId: task.projectId, repositoryId: repo!.id, branch: w.branch, worktreeId: w.id }),
          });
          return;
      }
    } catch (e) {
      toastError(describeError(e, "Couldn't start work."));
    } finally {
      setBusy(false);
    }
  };

  const canGo =
    mode === "session" ||
    mode === "current" ||
    mode === "worktree" ||
    (mode === "branch" && !!name.trim() && !!check?.valid && !check.exists) ||
    (mode === "existingBranch" && !!existing) ||
    (mode === "existingWorktree" && !!wtPath);

  const option = (m: Mode, icon: typeof Play, title: string, hint?: string, disabled?: boolean) => {
    const Icon = icon;
    return (
      <button type="button" className="sw-option" data-on={mode === m || undefined} disabled={disabled} onClick={() => setMode(m)}>
        <Icon size={15} />
        <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
          <span>{title}</span>
          {hint && <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>{hint}</span>}
        </span>
      </button>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Start work on “${task.title}”`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Play} disabled={!canGo || busy} onClick={() => void go()}>
            {mode === "worktree" ? "Continue…" : "Start"}
          </Button>
        </>
      }
    >
      {!repos ? (
        <Skeleton height={80} />
      ) : (
        <>
          {eligible.length > 1 && (
            <div className="field">
              <label className="field__label">Repository</label>
              <Select value={repo?.id ?? ""} onChange={setRepoId} options={eligible.map((r) => ({ value: r.id, label: r.name }))} ariaLabel="Repository" />
            </div>
          )}
          <div className="sw-options">
            {option("session", Play, "Just start a session", "Track time on this task; no git changes.")}
            {option("current", GitBranch, "Work in the current branch", summary?.available ? `${summary.branch ?? "detached HEAD"}${dirty ? ` · ${dirty} uncommitted` : ""}` : undefined)}
            {option("branch", GitBranchPlus, "Create a branch", "A new branch for this task.")}
            {option("worktree", FolderGit2, "Create an isolated worktree", "A separate folder on its own branch, leaving your checkout untouched.")}
            {option("existingBranch", GitBranch, "Use an existing branch", linkedBranch ? `Linked: ${linkedBranch}` : undefined, !local.length)}
            {otherWorktrees.length > 0 && option("existingWorktree", Workflow, "Use an existing worktree")}
          </div>
          {mode === "branch" && (
            <div className="col" style={{ gap: 8 }}>
              <div className="field">
                <label className="field__label">Branch name</label>
                <input className="input mono" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="Branch name" />
                {name.trim() && check && (check.message || !check.valid) && <span className="field__hint" data-error>{check.message ?? "That isn't a valid branch name."}</span>}
              </div>
              <div className="field">
                <label className="field__label">Start from</label>
                <input className="input mono" list="sw-bases" value={base} placeholder={defaultBase ?? "HEAD"} onChange={(e) => setBase(e.target.value)} aria-label="Base branch" />
                <datalist id="sw-bases">
                  {(branches ?? []).map((b) => (
                    <option key={b.name} value={b.name} />
                  ))}
                </datalist>
              </div>
              <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
                <Checkbox checked={switchTo} onChange={setSwitchTo} label="Switch to it now" /> Switch to it now
                {switchTo && dirty > 0 && <span className="faint">- git keeps your {dirty} uncommitted change{dirty === 1 ? "" : "s"}, or stops if they'd conflict</span>}
              </label>
            </div>
          )}
          {mode === "existingBranch" && (
            <div className="col" style={{ gap: 8 }}>
              <Select value={existing} onChange={setExisting} placeholder="Choose a branch" options={local.map((b) => ({ value: b.name, label: b.current ? `${b.name} (current)` : b.name }))} ariaLabel="Branch" />
              {existing && existing !== summary?.branch && (
                <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
                  <Checkbox checked={switchTo} onChange={setSwitchTo} label="Switch to it now" /> Switch to it now
                </label>
              )}
            </div>
          )}
          {mode === "existingWorktree" && <Select value={wtPath} onChange={setWtPath} placeholder="Choose a worktree" options={otherWorktrees.map((w) => ({ value: w.path, label: `${w.name}${w.branch ? ` · ${w.branch}` : ""}` }))} ariaLabel="Worktree" />}
        </>
      )}
    </Dialog>
  );
}
