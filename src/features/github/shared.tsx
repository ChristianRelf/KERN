// GitHub & git: shared hooks, the repository picker and the connect /
// clone / import flows. Kern never clones without asking, and a cloned
// folder goes through the normal trust prompt like any other folder.

import { Lock, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { create } from "zustand";
import { useQuery } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { siGithub } from "simple-icons";
import type { Project, RepoSummary, SyncReport } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { BrandIcon } from "@/components/ui/BrandIcon";
import { Dialog, confirm } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Skeleton, Switch } from "@/components/ui/Controls";
import { toast, toastError, useToasts } from "@/stores/toast";
import { relativeTime } from "@/lib/dates";
import { navigate } from "@/stores/router";
import { askTrust } from "@/features/projects/folders";
import { createProject } from "@/features/projects/actions";

export function GithubMark({ size = 14 }: { size?: number }) {
  return <BrandIcon icon={siGithub} size={size} />;
}

export function useGithubStatus(enabled = true) {
  return useQuery({ queryKey: ["github", "status"], queryFn: api.github.status, staleTime: 5 * 60_000, enabled, retry: false });
}

export function useProjectRepo(projectId: string | null | undefined) {
  return useQuery({ queryKey: ["github", "project", projectId], queryFn: () => api.github.project(projectId!), enabled: !!projectId });
}

export function useGitRemote(project: Pick<Project, "id" | "folderPath"> | null | undefined) {
  return useQuery({
    queryKey: ["git", "remote", project?.id, project?.folderPath],
    queryFn: () => api.git.remote(project!.id),
    enabled: !!project?.folderPath,
    retry: false,
    staleTime: 60_000,
  });
}

export function summarize(r: SyncReport): string {
  const parts = [
    r.imported && `${r.imported} imported`,
    r.updatedInKern && `${r.updatedInKern} updated in Kern`,
    r.updatedOnGithub && `${r.updatedOnGithub} updated on GitHub`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Everything is up to date";
}

export async function syncProject(projectId: string, quiet = false) {
  try {
    const r = await api.github.sync(projectId);
    invalidate("tasks", "task", "board", "projects", "project", "labels", "github", "activity");
    if (!quiet || r.imported || r.updatedInKern) toast(`Issues synced — ${summarize(r)}.`);
    if (r.errors.length) toastError(`${r.errors.length} issue${r.errors.length === 1 ? "" : "s"} couldn't sync: ${r.errors[0]}`);
    return r;
  } catch (e) {
    if (!quiet) toastError(describeError(e, "Couldn't sync with GitHub."));
    invalidate("github");
    return null;
  }
}

/** Asks where to clone, clones, links the folder with a trust decision. */
export async function cloneIntoProject(projectId: string, repo: string) {
  const ok = await confirm({
    title: `Clone ${repo}?`,
    message: "Kern downloads a local copy of the repository with git into a folder you choose, then links it to this project.",
    confirmLabel: "Choose folder…",
  });
  if (!ok) return false;
  const parent = await openDialog({ directory: true, title: `Where should ${repo} be cloned?` });
  if (typeof parent !== "string") return false;
  const t = toast(`Cloning ${repo}…`, { duration: 60_000 });
  try {
    const path = await api.git.clone(repo, parent);
    const info = await api.folders.inspect(path);
    const trust = await askTrust(info);
    if (!trust) {
      toast(`Cloned to ${path}. It isn't linked to the project.`);
      return false;
    }
    await api.folders.link(projectId, path, trust);
    invalidate("folder", "files", "projects", "project", "git", "trusted");
    toast(`Cloned and linked ${repo}`);
    return true;
  } catch (e) {
    toastError(describeError(e, "Couldn't clone the repository."));
    return false;
  } finally {
    useToasts.getState().dismiss(t);
  }
}

// ------------------------------------------------------------ repo picker

interface PickerReq {
  title: string;
  confirmLabel: string;
  offerClone: boolean;
  resolve: (v: { repo: string; importClosed: boolean; clone: boolean } | null) => void;
}

const usePicker = create<{ req: PickerReq | null }>(() => ({ req: null }));

export function pickRepo(opts: Omit<PickerReq, "resolve">) {
  return new Promise<{ repo: string; importClosed: boolean; clone: boolean } | null>((resolve) => usePicker.setState({ req: { ...opts, resolve } }));
}

export function RepoPickerHost() {
  const req = usePicker((s) => s.req);
  return req ? <RepoPicker req={req} /> : null;
}

function RepoPicker({ req }: { req: PickerReq }) {
  const { data: status, isLoading: statusLoading } = useGithubStatus();
  const { data: repos, isLoading, error } = useQuery({ queryKey: ["github", "repos"], queryFn: api.github.repos, enabled: !!status?.connected, staleTime: 60_000, retry: false });
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [importClosed, setImportClosed] = useState(false);
  const [clone, setClone] = useState(true);
  const close = (v: { repo: string; importClosed: boolean; clone: boolean } | null) => {
    req.resolve(v);
    usePicker.setState({ req: null });
  };
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (repos ?? []).filter((r) => !s || r.fullName.toLowerCase().includes(s) || (r.description ?? "").toLowerCase().includes(s));
  }, [repos, q]);
  // Allow typing owner/name directly for repos not in the list.
  const typed = /^[\w.-]+\/[\w.-]+$/.test(q.trim()) ? q.trim() : null;
  const choice = picked ?? (list.length === 0 ? typed : null);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close(null)}
      title={req.title}
      className="repo-picker"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!choice} onClick={() => choice && close({ repo: choice, importClosed, clone })}>
            {req.confirmLabel}
          </Button>
        </>
      }
    >
      {statusLoading ? (
        <Skeleton height={40} />
      ) : !status?.connected ? (
        <div className="col" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
          <span>GitHub isn't connected yet.</span>
          <span className="faint">{status?.error ?? "Sign in with the GitHub CLI (`gh auth login`) or add a token."}</span>
          <Button
            size="sm"
            style={{ alignSelf: "flex-start" }}
            onClick={() => {
              close(null);
              navigate({ name: "settings", section: "integrations" });
            }}
          >
            Open GitHub settings
          </Button>
        </div>
      ) : (
        <>
          <div className="input-wrap">
            <Search />
            <input className="input" autoFocus placeholder="Search your repositories, or type owner/name" value={q} onChange={(e) => (setQ(e.target.value), setPicked(null))} aria-label="Repository" />
          </div>
          <div className="repo-picker__list" role="listbox" aria-label="Repositories">
            {isLoading && <Skeleton height={120} />}
            {error && <span className="faint">{describeError(error, "Couldn't list repositories.")}</span>}
            {list.slice(0, 80).map((r: RepoSummary) => (
              <button key={r.fullName} type="button" role="option" aria-selected={picked === r.fullName} className="repo-picker__item" data-active={picked === r.fullName || undefined} onClick={() => setPicked(r.fullName)} onDoubleClick={() => close({ repo: r.fullName, importClosed, clone })}>
                <span className="row" style={{ gap: 6 }}>
                  <span className="truncate" style={{ fontWeight: 550 }}>
                    {r.fullName}
                  </span>
                  {r.private && <Lock size={11} className="faint" aria-label="Private" />}
                </span>
                <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>
                  {r.description || "No description"} · {r.openIssues} open · {r.updatedAt ? `pushed ${relativeTime(Date.parse(r.updatedAt))}` : ""}
                </span>
              </button>
            ))}
            {!isLoading && !list.length && (
              <span className="faint" style={{ fontSize: "var(--fs-sm)", padding: 8 }}>
                {typed ? `Use ${typed}` : "No matching repositories."}
              </span>
            )}
          </div>
          <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
            <Switch checked={importClosed} onChange={setImportClosed} label="Also import closed issues" />
            Also import closed issues (as completed tasks)
          </label>
          {req.offerClone && (
            <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
              <Switch checked={clone} onChange={setClone} label="Clone a local copy" />
              Clone a local copy (asks where)
            </label>
          )}
        </>
      )}
    </Dialog>
  );
}

/** Connects an existing project to a repository and runs the first sync. */
export async function connectProject(project: Pick<Project, "id" | "name" | "folderPath">, repoHint?: string) {
  const picked = repoHint ? { repo: repoHint, importClosed: false, clone: false } : await pickRepo({ title: `Connect ${project.name} to GitHub`, confirmLabel: "Connect", offerClone: !project.folderPath });
  if (!picked) return;
  try {
    await api.github.connect(project.id, picked.repo, picked.importClosed);
    invalidate("github", "activity");
    toast(`Connected to ${picked.repo}`);
    if (picked.clone && !project.folderPath) await cloneIntoProject(project.id, picked.repo);
    await syncProject(project.id);
  } catch (e) {
    toastError(describeError(e, "Couldn't connect the repository."));
  }
}

/** New project from a GitHub repository: create, connect, optionally clone, import issues. */
export async function importFromGithub() {
  const picked = await pickRepo({ title: "Import a project from GitHub", confirmLabel: "Import", offerClone: true });
  if (!picked) return;
  const name = picked.repo.split("/")[1] ?? picked.repo;
  const p = await createProject({ name, description: `GitHub: ${picked.repo}` }, false);
  if (!p) return;
  try {
    await api.github.connect(p.id, picked.repo, picked.importClosed);
    navigate({ name: "project", id: p.id, tab: "code" });
    if (picked.clone) await cloneIntoProject(p.id, picked.repo);
    await syncProject(p.id);
  } catch (e) {
    toastError(describeError(e, "Couldn't connect the repository."));
    navigate({ name: "project", id: p.id });
  }
}
