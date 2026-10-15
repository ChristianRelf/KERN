/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Run: the detected stack (from configuration files only - nothing runs
// during detection), whether its tools are installed, the scripts it
// defines, the user's saved commands, environment profiles and local
// services. Commands start only when the user clicks them, in a terminal
// tab, and need a trusted folder.

import { CircleAlert, Copy, ExternalLink, Pencil, Pin, PinOff, Play, Plus, RefreshCw, Save, ShieldHalf, Trash } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CommandInput, DetectedCommand, Project, Repository, SavedCommand } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { ContextMenu, type MenuItems } from "@/components/ui/Menu";
import { Dialog, confirm, confirmDelete } from "@/components/ui/Dialog";
import { Checkbox, EmptyState, Segmented, Select, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { openLink } from "@/features/links/links";
import { useProjectFolder } from "@/features/projects/folders";
import { runInTerminal } from "@/features/terminal/store";
import type { CwdTarget } from "@/lib/types";
import { useCommands, useEnvProfiles } from "./hooks";
import { TechIcon } from "./TechIcon";
import { EnvProfilesSection } from "./EnvProfiles";
import { ServicesSection } from "./Services";
import { joinArgs, splitArgs } from "./args";

type Part = "commands" | "environment" | "services";

export function RunSection({ project, repo }: { project: Project; repo: Repository | null }) {
  const [part, setPart] = useState<Part>("commands");
  return (
    <div className="col" style={{ gap: 14 }}>
      <Stack project={project} repo={repo} />
      <Segmented
        size="sm"
        value={part}
        onChange={setPart}
        ariaLabel="Run section"
        options={[
          { value: "commands", label: "Commands" },
          { value: "environment", label: "Environment variables" },
          { value: "services", label: "Services" },
        ]}
      />
      {part === "commands" && <Commands project={project} repo={repo} />}
      {part === "environment" && <EnvProfilesSection project={project} />}
      {part === "services" && <ServicesSection project={project} />}
    </div>
  );
}

function useDetected(project: Project, repo: Repository | null) {
  return useQuery({
    queryKey: ["devenv", project.id, repo?.id ?? null],
    queryFn: () => api.devenv.detect(project.id, repo?.id ?? null),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The trust of the folder commands run in. */
function useRootTrust(project: Project, repo: Repository | null) {
  const { data: folder } = useProjectFolder(project.id, !repo && !!project.folderPath);
  return repo ? repo.trust === "trusted" : folder?.trust === "trusted";
}

function Stack({ project, repo }: { project: Project; repo: Repository | null }) {
  const { data: env, error, isFetching, refetch } = useDetected(project, repo);
  if (error) return <span className="faint">{describeError(error, "Couldn't read the folder.")}</span>;
  if (!env) return <Skeleton height={40} />;
  const missing = env.runtimes.filter((r) => !r.available);
  const main = env.techs.filter((t) => t.kind !== "package-manager" && t.kind !== "tool");
  const tools = env.techs.filter((t) => t.kind === "package-manager" || t.kind === "tool");
  return (
    <div className="stack">
      <div className="row stack__line">
        {main.length ? (
          main.map((t, i) => (
            <Tooltip key={t.id} content={`Found in ${t.evidence}`}>
              <span className="stack__tech">
                <TechIcon id={t.id} kind={t.kind} />
                {t.name}
                {i < main.length - 1 && <span className="faint">·</span>}
              </span>
            </Tooltip>
          ))
        ) : (
          <span className="faint">No recognised project configuration in this folder.</span>
        )}
        <span className="spacer" />
        <IconButton icon={RefreshCw} label="Detect again" size="sm" className={isFetching ? "spin" : undefined} onClick={() => void refetch()} />
      </div>
      {(tools.length > 0 || env.branch) && (
        <div className="row faint stack__line" style={{ fontSize: "var(--fs-xs)" }}>
          {env.packageManager && <span>Package manager: {env.packageManager}</span>}
          {tools
            .filter((t) => t.kind === "tool")
            .map((t) => (
              <span key={t.id} className="row" style={{ gap: 4 }}>
                <TechIcon id={t.id} kind={t.kind} size={12} /> {t.name}
              </span>
            ))}
          {env.branch && <span>Git: {env.branch}</span>}
        </div>
      )}
      {missing.length > 0 && (
        <div className="stack__missing">
          <CircleAlert size={13} />
          <span className="grow">
            Not found on this computer: {missing.map((r) => r.name).join(", ")}. The project still works in Kern; its commands need these installed.
          </span>
          {missing
            .filter((r) => r.helpUrl)
            .slice(0, 3)
            .map((r) => (
              <Button key={r.id} size="sm" variant="ghost" icon={ExternalLink} onClick={() => void openLink(r.helpUrl)}>
                {r.name}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}

function cwdFor(project: Project, repo: Repository | null, rel: string): CwdTarget {
  return repo ? { kind: "repository", repositoryId: repo.id, rel: rel || null } : { kind: "project", projectId: project.id, rel: rel || null };
}

function Commands({ project, repo }: { project: Project; repo: Repository | null }) {
  const { data: env } = useDetected(project, repo);
  const { data: saved } = useCommands(project.id);
  const { data: profiles } = useEnvProfiles(project.id);
  const trusted = useRootTrust(project, repo);
  const [editing, setEditing] = useState<Partial<CommandInput> | null>(null);
  const [profileId, setProfileId] = useState<string>("none");
  const mine = (saved ?? []).filter((c) => (c.repositoryId ?? null) === (repo?.id ?? null) || !repo);
  const savedKeys = useMemo(() => new Set(mine.map((c) => `${c.program} ${c.args.join(" ")}@${c.cwd}`)), [mine]);
  const detected = (env?.commands ?? []).filter((c) => !savedKeys.has(`${c.program} ${c.args.join(" ")}@${c.cwd}`));

  const run = async (c: DetectedCommand | SavedCommand) => {
    if ("id" in c) {
      if (c.confirm && !(await confirm({ title: `Run “${c.name}”?`, message: `${c.program} ${c.args.join(" ")}`, confirmLabel: "Run" }))) return;
      void runInTerminal(project.id, { commandId: c.id, envProfileId: profileId === "none" ? c.envProfileId : profileId }, undefined, c.name);
    } else {
      void runInTerminal(project.id, { program: c.program, args: c.args, envProfileId: profileId === "none" ? null : profileId }, cwdFor(project, repo, c.cwd), c.name);
    }
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      {!trusted && (
        <div className="code-banner">
          <ShieldHalf size={15} />
          <span className="grow">Commands need a trusted folder, because package scripts and build files can run any code.</span>
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <span className="section-title">
          Saved commands <span className="count">{mine.length}</span>
        </span>
        <span className="spacer" />
        {(profiles?.length ?? 0) > 0 && (
          <Select
            value={profileId}
            onChange={setProfileId}
            ariaLabel="Environment profile"
            options={[{ value: "none", label: "Command's own profile" }, ...(profiles ?? []).map((p) => ({ value: p.id, label: `Env: ${p.name}` }))]}
          />
        )}
        <Button size="sm" icon={Plus} onClick={() => setEditing({ projectId: project.id, repositoryId: repo?.id ?? null, args: [], cwd: "", confirm: false, pinned: false })}>
          New command
        </Button>
      </div>
      {!saved ? (
        <Skeleton height={30} />
      ) : !mine.length ? (
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Save the commands you run often; pinned ones appear in the project overview.</span>
      ) : (
        <div className="col" style={{ gap: 1 }}>
          {mine.map((c) => (
            <CommandRow key={c.id} c={c} trusted={trusted} onRun={() => void run(c)} onEdit={() => setEditing(c)} />
          ))}
        </div>
      )}
      <div className="section-title">
        From the project's files <span className="count">{detected.length}</span>
      </div>
      {!env ? (
        <Skeleton height={30} />
      ) : !detected.length ? (
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No scripts found in package.json, Cargo.toml, pyproject.toml, Makefile or similar files.</span>
      ) : (
        <div className="col" style={{ gap: 1 }}>
          {detected.map((c) => (
            <div key={`${c.cwd}:${c.name}:${c.program}`} className="cmd-row">
              <span className="chip cmd-row__cat">{c.category}</span>
              <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                <span className="truncate" style={{ fontWeight: 550 }}>
                  {c.name}
                </span>
                <span className="faint truncate mono" style={{ fontSize: "var(--fs-xs)" }}>
                  {c.cwd && `${c.cwd} › `}
                  {c.program} {c.args.join(" ")}
                  {c.detail && ` - ${c.detail}`}
                </span>
              </span>
              <IconButton icon={Save} label="Save as a command" size="sm" onClick={() => setEditing({ projectId: project.id, repositoryId: repo?.id ?? null, name: c.name, program: c.program, args: c.args, cwd: c.cwd, confirm: false, pinned: false })} />
              <Tooltip content={trusted ? `Run in a terminal` : "Trust the folder to run commands"}>
                <span>
                  <Button size="sm" icon={Play} disabled={!trusted} onClick={() => void run(c)}>
                    Run
                  </Button>
                </span>
              </Tooltip>
            </div>
          ))}
        </div>
      )}
      {editing && <CommandDialog project={project} initial={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CommandRow({ c, trusted, onRun, onEdit }: { c: SavedCommand; trusted: boolean; onRun: () => void; onEdit: () => void }) {
  const toggle = (pinned: boolean) => void api.commands.save({ ...c, pinned }).then(() => invalidate("commands"));
  const menu: MenuItems = [
    { label: "Run", icon: Play, disabled: !trusted, onSelect: onRun },
    { label: "Edit…", icon: Pencil, onSelect: onEdit },
    { label: c.pinned ? "Unpin from overview" : "Pin to overview", icon: c.pinned ? PinOff : Pin, onSelect: () => toggle(!c.pinned) },
    { label: "Duplicate", icon: Copy, onSelect: () => void api.commands.save({ ...c, id: null, name: `${c.name} copy`, pinned: false }).then(() => invalidate("commands")) },
    { type: "separator" },
    {
      label: "Delete",
      icon: Trash,
      danger: true,
      onSelect: async () => {
        if (!(await confirmDelete(`Delete “${c.name}”?`, "Only the saved command is removed."))) return;
        await api.commands.delete(c.id).catch((e) => toastError(describeError(e)));
        invalidate("commands", "capabilities");
      },
    },
  ];
  return (
    <ContextMenu items={() => menu}>
      <div className="cmd-row">
        {c.pinned ? <Pin size={13} className="faint" /> : <Play size={13} className="faint" />}
        <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
          <span className="truncate" style={{ fontWeight: 550 }}>
            {c.name}
            {c.confirm && <span className="faint"> · asks first</span>}
          </span>
          <span className="faint truncate mono" style={{ fontSize: "var(--fs-xs)" }}>
            {c.cwd && `${c.cwd} › `}
            {c.program} {c.args.join(" ")}
          </span>
        </span>
        <IconButton icon={Pencil} label="Edit" size="sm" onClick={onEdit} />
        <Tooltip content={trusted ? "Run in a terminal" : "Trust the folder to run commands"}>
          <span>
            <Button size="sm" icon={Play} disabled={!trusted} onClick={onRun}>
              Run
            </Button>
          </span>
        </Tooltip>
      </div>
    </ContextMenu>
  );
}

function CommandDialog({ project, initial, onClose }: { project: Project; initial: Partial<CommandInput>; onClose: () => void }) {
  const { data: repos } = useQuery({ queryKey: ["repos", project.id], queryFn: () => api.repos.list(project.id) });
  const { data: profiles } = useEnvProfiles(project.id);
  const [name, setName] = useState(initial.name ?? "");
  const [program, setProgram] = useState(initial.program ?? "");
  const [args, setArgs] = useState(joinArgs(initial.args ?? []));
  const [cwd, setCwd] = useState(initial.cwd ?? "");
  const [repoId, setRepoId] = useState(initial.repositoryId ?? "none");
  const [profile, setProfile] = useState(initial.envProfileId ?? "none");
  const [ask, setAsk] = useState(initial.confirm ?? false);
  const [pinned, setPinned] = useState(initial.pinned ?? false);
  const local = (repos ?? []).filter((r) => r.localPath);
  const save = async () => {
    try {
      await api.commands.save({
        id: initial.id ?? null,
        projectId: project.id,
        repositoryId: repoId === "none" ? null : repoId,
        name: name.trim() || program.trim(),
        program: program.trim(),
        args: splitArgs(args),
        cwd: cwd.trim(),
        envProfileId: profile === "none" ? null : profile,
        confirm: ask,
        pinned,
      });
      invalidate("commands", "capabilities");
      toast(initial.id ? "Command saved" : "Command added");
      onClose();
    } catch (e) {
      toastError(describeError(e, "Couldn't save the command."));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={initial.id ? "Edit command" : "New command"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!program.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="field">
        <label className="field__label">Name</label>
        <input className="input" autoFocus value={name} placeholder="Dev server" onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
        <div className="field" style={{ flex: "0 0 34%" }}>
          <label className="field__label">Program</label>
          <input className="input mono" value={program} placeholder="npm" onChange={(e) => setProgram(e.target.value)} />
        </div>
        <div className="field grow">
          <label className="field__label">Arguments</label>
          <input className="input mono" value={args} placeholder="run dev" onChange={(e) => setArgs(e.target.value)} />
        </div>
      </div>
      <span className="field__hint">The program runs directly with these arguments - no shell, so pipes and && aren't interpreted.</span>
      <div className="row" style={{ gap: 8 }}>
        {local.length > 0 && (
          <div className="field grow">
            <label className="field__label">Runs in</label>
            <Select value={repoId} onChange={setRepoId} options={[{ value: "none", label: "Project folder" }, ...local.map((r) => ({ value: r.id, label: r.name }))]} ariaLabel="Runs in" />
          </div>
        )}
        <div className="field grow">
          <label className="field__label">Sub-folder</label>
          <input className="input mono" value={cwd} placeholder="(root)" onChange={(e) => setCwd(e.target.value)} />
        </div>
      </div>
      {(profiles?.length ?? 0) > 0 && (
        <div className="field">
          <label className="field__label">Environment profile</label>
          <Select value={profile} onChange={setProfile} options={[{ value: "none", label: "None" }, ...(profiles ?? []).map((p) => ({ value: p.id, label: p.name }))]} ariaLabel="Environment profile" />
          <span className="field__hint">Its variables are given to this command only. Secret values never appear in previews.</span>
        </div>
      )}
      <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
        <Checkbox checked={ask} onChange={setAsk} label="Ask before running" /> Ask before running
      </label>
      <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
        <Checkbox checked={pinned} onChange={setPinned} label="Pin to project overview" /> Pin to the project overview
      </label>
    </Dialog>
  );
}

/** Pinned commands with Run buttons (Command Centre). */
export function PinnedCommands({ project }: { project: Project }) {
  const { data } = useCommands(project.id);
  const pinned = (data ?? []).filter((c) => c.pinned);
  if (!data) return <Skeleton height={30} />;
  if (!pinned.length) return <EmptyState compact icon={Pin}>Pin commands in Code → Run to start them from here.</EmptyState>;
  return (
    <div className="col" style={{ gap: 1 }}>
      {pinned.map((c) => (
        <button
          key={c.id}
          type="button"
          className="cmd-row cmd-row--button"
          onClick={async () => {
            if (c.confirm && !(await confirm({ title: `Run “${c.name}”?`, message: `${c.program} ${c.args.join(" ")}`, confirmLabel: "Run" }))) return;
            void runInTerminal(project.id, { commandId: c.id }, undefined, c.name);
          }}
        >
          <Play size={13} />
          <span className="truncate grow">{c.name}</span>
          <span className="faint mono truncate" style={{ fontSize: "var(--fs-xs)", maxWidth: "50%" }}>
            {c.program} {c.args.join(" ")}
          </span>
        </button>
      ))}
    </div>
  );
}

