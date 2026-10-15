/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Milestone details (inspector): status, target date, progress, its tasks,
// dependencies and, when it's a release, version, repository, linked pull
// requests and issues, notes and a changelog draft. Publishing a release is
// always done by the user on GitHub; Kern only opens a prefilled draft.

import { CalendarDays, Check, CircleDashed, ClipboardCopy, ExternalLink, FileText, Flag, GitPullRequest, Link2, ListPlus, Plus, Rocket, ScrollText, Trash, X, CircleDot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Milestone, MilestoneStatus, Task } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { useTasks } from "@/hooks/data";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { Dialog, prompt } from "@/components/ui/Dialog";
import { EmptyState, Popover, Progress, Segmented, Select, Skeleton, Slider, Switch } from "@/components/ui/Controls";
import { DuePopover, FilterList } from "@/features/tasks/pickers";
import { MiniTaskList } from "@/features/dashboard/MiniTaskList";
import { createTask, updateTask } from "@/features/tasks/actions";
import { openLink } from "@/features/links/links";
import { copyText } from "@/features/projects/folders";
import { toastError } from "@/stores/toast";
import { formatDue } from "@/lib/dates";
import { useMilestone, useMilestones, useRepos } from "@/features/dev/hooks";
import { STATUS_LABEL, deleteMilestone, openMilestone, updateMilestone } from "./actions";
import { milestoneLabel, MilestoneStatusIcon } from "./MilestonesTab";

export function MilestoneDetail({ id }: { id: string }) {
  const { data: m, isError } = useMilestone(id);
  if (isError) return <EmptyState icon={Flag} title="This milestone is no longer available" />;
  if (!m) return <Skeleton height={80} />;
  return <Body key={m.id} m={m} />;
}

function useField(remote: string, save: (v: string) => void) {
  const [v, setV] = useState(remote);
  useEffect(() => setV(remote), [remote]);
  return { value: v, onChange: setV, commit: () => v !== remote && save(v) };
}

function Body({ m }: { m: Milestone }) {
  const patch = (p: Parameters<typeof updateMilestone>[1]) => void updateMilestone(m.id, p);
  const title = useField(m.title, (v) => v.trim() && patch({ title: v.trim() }));
  const desc = useField(m.description, (v) => patch({ description: v }));
  const [manual, setManual] = useState(m.manualProgress);
  useEffect(() => setManual(m.manualProgress), [m.manualProgress]);
  return (
    <div className="task-detail milestone-detail">
      <div className="task-detail__title">
        <MilestoneStatusIcon m={m} size={18} />
        <textarea rows={1} value={title.value} aria-label="Milestone title" onChange={(e) => title.onChange(e.target.value.replace(/\n/g, " "))} onBlur={title.commit} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())} />
      </div>
      <div className="props">
        <span className="props__label">
          <CircleDashed /> Status
        </span>
        <div>
          <Dropdown items={(["planned", "active", "completed", "cancelled"] as MilestoneStatus[]).map((s) => ({ label: STATUS_LABEL[s], checked: m.status === s, onSelect: () => patch({ status: s }) }))}>
            <button type="button" className="prop-btn">
              {STATUS_LABEL[m.status]}
            </button>
          </Dropdown>
        </div>
        <span className="props__label">
          <CalendarDays /> Target
        </span>
        <div className="row" style={{ gap: 0 }}>
          <DuePopover
            date={m.targetDate}
            withTime={false}
            onChange={(d) => patch({ targetDate: d })}
            trigger={
              <button type="button" className="prop-btn" data-empty={!m.targetDate} data-overdue={m.overdue || undefined}>
                {m.targetDate ? formatDue(m.targetDate) : "Set date"}
                {m.overdue && <span className="faint">· overdue</span>}
              </button>
            }
          />
          {m.targetDate && <IconButton icon={X} label="Remove target date" size="sm" onClick={() => patch({ targetDate: null })} />}
        </div>
        <span className="props__label">
          <Check /> Progress
        </span>
        <div className="col" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <Progress value={m.progress} style={{ flex: 1 }} />
            <span className="tabular faint" style={{ fontSize: "var(--fs-xs)" }}>
              {Math.round(m.progress * 100)}%
            </span>
          </div>
          <Segmented
            size="sm"
            value={m.progressMode}
            onChange={(v) => patch({ progressMode: v })}
            ariaLabel="Progress from"
            options={[
              { value: "tasks", label: `From tasks (${m.taskDone}/${m.taskTotal})` },
              { value: "manual", label: "Manual" },
            ]}
          />
          {m.progressMode === "manual" && <Slider value={manual} min={0} max={100} step={5} onChange={setManual} onCommit={(v) => patch({ manualProgress: v })} ariaLabel="Manual progress" />}
        </div>
        <span className="props__label">
          <Link2 /> Depends on
        </span>
        <div>
          <DependsOn m={m} />
        </div>
        <span className="props__label">
          <Rocket /> Release
        </span>
        <div className="row" style={{ gap: 8 }}>
          <Switch checked={m.isRelease} onChange={(v) => patch({ isRelease: v })} label="This milestone is a release" />
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
            {m.isRelease ? "Planned release" : "Not a release"}
          </span>
        </div>
      </div>
      <textarea className="textarea desc-area" placeholder="Description" value={desc.value} onChange={(e) => desc.onChange(e.target.value)} onBlur={desc.commit} aria-label="Description" />
      <MilestoneTasks m={m} />
      {m.isRelease && <ReleaseSection m={m} />}
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {m.status !== "completed" ? (
          <Button size="sm" icon={Check} onClick={() => patch({ status: "completed" })}>
            Mark completed
          </Button>
        ) : (
          <Button size="sm" icon={Flag} onClick={() => patch({ status: "active" })}>
            Reopen
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={Trash} onClick={() => void deleteMilestone(m)}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function DependsOn({ m }: { m: Milestone }) {
  const { data: all } = useMilestones(m.projectId);
  const [open, setOpen] = useState(false);
  const others = (all ?? []).filter((x) => x.id !== m.id);
  const deps = others.filter((x) => m.dependsOn.includes(x.id));
  const toggle = async (id: string) => {
    const next = m.dependsOn.includes(id) ? m.dependsOn.filter((d) => d !== id) : [...m.dependsOn, id];
    try {
      await api.milestones.setDeps(m.id, next);
      invalidate("milestones", "health");
    } catch (e) {
      toastError(describeError(e));
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="prop-btn" data-empty={!deps.length}>
          {deps.length ? deps.map((d) => <span key={d.id} className="chip" data-done={d.status === "completed" || undefined}>{d.title}</span>) : others.length ? "None" : "No other milestones"}
        </button>
      }
    >
      <FilterList
        items={others}
        placeholder="Depends on…"
        getKey={(x) => x.id}
        getText={(x) => x.title}
        onPick={(x) => void toggle(x.id)}
        render={(x) => (
          <>
            <MilestoneStatusIcon m={x} />
            <span className="truncate grow">{milestoneLabel(x)}</span>
            {m.dependsOn.includes(x.id) && <Check size={14} className="menu__check" />}
          </>
        )}
      />
    </Popover>
  );
}

function MilestoneTasks({ m }: { m: Milestone }) {
  const { data: tasks } = useTasks({ milestoneIds: [m.id], topLevelOnly: true, includeCompleted: true, order: "manual" });
  const { data: candidates } = useTasks({ projectIds: [m.projectId], topLevelOnly: true, noMilestone: true, order: "updated", limit: 200 });
  const [adding, setAdding] = useState("");
  const [pick, setPick] = useState(false);
  const open = (tasks ?? []).filter((t) => t.status !== "completed");
  const done = (tasks ?? []).filter((t) => t.status === "completed");
  const add = async () => {
    const title = adding.trim();
    if (!title) return;
    setAdding("");
    await createTask({ title, projectId: m.projectId, milestoneId: m.id, status: "todo" }, { quiet: true });
    invalidate("milestones");
  };
  return (
    <div className="col" style={{ gap: 2 }}>
      <div className="section-title" style={{ marginBottom: 4 }}>
        Tasks
        <span className="count">
          {m.taskDone}/{m.taskTotal}
        </span>
        <span className="spacer" />
        <Popover
          open={pick}
          onOpenChange={setPick}
          align="end"
          trigger={<IconButton icon={ListPlus} label="Add existing tasks" size="sm" />}
        >
          <FilterList<Task>
            items={candidates ?? []}
            placeholder="Add a task from this project…"
            getKey={(t) => t.id}
            getText={(t) => t.title}
            onPick={(t) => void updateTask(t.id, { milestoneId: m.id }).then(() => invalidate("milestones"))}
            render={(t) => <span className="truncate grow">{t.title}</span>}
          />
        </Popover>
      </div>
      {tasks === undefined ? <Skeleton height={30} /> : <MiniTaskList tasks={[...open, ...done]} max={30} />}
      <div className="subtask-row">
        <Plus size={14} className="faint" style={{ margin: "0 1px" }} />
        <input placeholder="Add a task to this milestone" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void add())} aria-label="Add task to milestone" />
      </div>
    </div>
  );
}

function ReleaseSection({ m }: { m: Milestone }) {
  const { data: repos } = useRepos(m.projectId);
  const github = (repos ?? []).filter((r) => r.github);
  const repo = (repos ?? []).find((r) => r.id === m.repositoryId);
  const [version, setVersion] = useState(m.version ?? "");
  const notes = useField(m.releaseNotes, (v) => void updateMilestone(m.id, { releaseNotes: v }));
  const [changelog, setChangelog] = useState<string | null>(null);
  useEffect(() => setVersion(m.version ?? ""), [m.version]);
  const addLink = async (kind: "pull" | "issue") => {
    const raw = await prompt({ title: kind === "pull" ? "Link a pull request" : "Link an issue", placeholder: "#123", confirmLabel: "Link" });
    if (!raw) return;
    const n = raw.trim().replace(/^#/, "");
    if (!/^\d+$/.test(n)) return toastError("Enter a number, like #123.");
    const slug = repo?.github;
    const cached = slug && kind === "pull" ? (await api.github.cached(m.projectId).catch(() => [])).find((c) => c.repository === slug.toLowerCase())?.pulls?.find((p) => String(p.number) === n) : undefined;
    try {
      await api.milestones.addLink({
        milestoneId: m.id,
        kind,
        ref: n,
        title: cached?.title ?? null,
        url: slug ? `https://github.com/${slug}/${kind === "pull" ? "pull" : "issues"}/${n}` : null,
      });
      invalidate("milestones");
    } catch (e) {
      toastError(describeError(e));
    }
  };
  const draft = async () => {
    try {
      setChangelog(await api.milestones.changelog(m.id));
    } catch (e) {
      toastError(describeError(e, "Couldn't draft the changelog."));
    }
  };
  const releaseDraftUrl = (body: string) => {
    if (!repo?.github) return null;
    const tag = (m.version ?? "").trim();
    const q = new URLSearchParams({ title: milestoneLabel(m), body: body.slice(0, 6000), ...(tag ? { tag } : {}) });
    return `https://github.com/${repo.github}/releases/new?${q}`;
  };
  return (
    <div className="col release-section" style={{ gap: 8 }}>
      <div className="section-title">Release</div>
      <div className="props">
        <span className="props__label">Version</span>
        <input className="input input--sm" placeholder="v1.0.0" value={version} onChange={(e) => setVersion(e.target.value)} onBlur={() => version.trim() !== (m.version ?? "") && void updateMilestone(m.id, { version: version.trim() || null })} aria-label="Version" />
        <span className="props__label">Repository</span>
        <div>
          {repos?.length ? (
            <Select
              value={m.repositoryId ?? "none"}
              onChange={(v) => void updateMilestone(m.id, { repositoryId: v === "none" ? null : v })}
              options={[{ value: "none", label: "None" }, ...repos.map((r) => ({ value: r.id, label: r.name }))]}
              ariaLabel="Repository"
            />
          ) : (
            <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
              Link a repository to the project to attach one.
            </span>
          )}
        </div>
        {m.releaseUrl && (
          <>
            <span className="props__label">Published</span>
            <button type="button" className="prop-btn truncate" onClick={() => void openLink(m.releaseUrl!)}>
              <ExternalLink size={13} /> {m.releaseUrl}
            </button>
          </>
        )}
      </div>
      <div className="col" style={{ gap: 2 }}>
        <div className="row" style={{ gap: 4 }}>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            Pull requests & issues
          </span>
          <span className="spacer" />
          <IconButton icon={GitPullRequest} label="Link a pull request" size="sm" onClick={() => void addLink("pull")} />
          <IconButton icon={CircleDot} label="Link an issue" size="sm" onClick={() => void addLink("issue")} />
        </div>
        {m.links.map((l) => (
          <div key={l.id} className="attachment">
            {l.kind === "pull" ? <GitPullRequest /> : <CircleDot />}
            <button type="button" className="truncate grow" style={{ textAlign: "left" }} disabled={!l.url} onClick={() => l.url && void openLink(l.url)}>
              #{l.ref} {l.title && <span className="faint">{l.title}</span>}
            </button>
            <IconButton icon={X} label="Unlink" size="sm" onClick={() => void api.milestones.removeLink(l.id).then(() => invalidate("milestones"))} />
          </div>
        ))}
        {!m.links.length && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>None linked.</span>}
      </div>
      <textarea className="textarea" rows={3} placeholder="Release notes" value={notes.value} onChange={(e) => notes.onChange(e.target.value)} onBlur={notes.commit} aria-label="Release notes" />
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Button size="sm" icon={ScrollText} onClick={() => void draft()}>
          Draft changelog
        </Button>
        {!m.releaseUrl && repo?.github && (
          <Button
            size="sm"
            variant="ghost"
            icon={FileText}
            onClick={async () => {
              const url = await prompt({ title: "Published release link", placeholder: `https://github.com/${repo.github}/releases/tag/…`, confirmLabel: "Save" });
              if (url) void updateMilestone(m.id, { releaseUrl: url });
            }}
          >
            Add release link
          </Button>
        )}
      </div>
      <Dialog
        open={changelog !== null}
        onOpenChange={(o) => !o && setChangelog(null)}
        title="Changelog draft"
        wide
        footer={
          <>
            <Button variant="ghost" icon={ClipboardCopy} onClick={() => changelog && void copyText(changelog, "Changelog")}>
              Copy
            </Button>
            <Button
              onClick={() => {
                if (changelog) void updateMilestone(m.id, { releaseNotes: changelog });
                setChangelog(null);
              }}
            >
              Use as release notes
            </Button>
            {changelog && releaseDraftUrl(changelog) && (
              <Button variant="primary" icon={ExternalLink} onClick={() => void openLink(releaseDraftUrl(changelog)!)}>
                Review on GitHub
              </Button>
            )}
          </>
        }
      >
        <p className="dialog__desc">Drafted from completed tasks, linked pull requests and issues{repo ? " and recent commits" : ""}. Nothing is published: “Review on GitHub” opens a pre-filled release form for you to check and publish.</p>
        <textarea className="textarea mono changelog-text" rows={14} value={changelog ?? ""} onChange={(e) => setChangelog(e.target.value)} aria-label="Changelog" />
      </Dialog>
      {github.length === 0 && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Releases don't need GitHub; link a repository only if you want pull requests and commits here.</span>}
    </div>
  );
}

/** Compact list of a project's upcoming milestones (Command Centre, dashboards). */
export function UpcomingMilestones({ projectId, max = 5 }: { projectId: string; max?: number }) {
  const { data } = useMilestones(projectId);
  const list = useMemo(() => (data ?? []).filter((m) => m.status === "planned" || m.status === "active").sort((a, b) => (a.targetDate ?? "9999").localeCompare(b.targetDate ?? "9999")), [data]);
  if (!data) return <Skeleton height={40} />;
  if (!list.length) return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No upcoming milestones.</span>;
  return (
    <div className="col" style={{ gap: 2 }}>
      {list.slice(0, max).map((m) => (
        <button key={m.id} type="button" className="ms-mini" onClick={() => openMilestone(m.id)}>
          <MilestoneStatusIcon m={m} size={13} />
          <span className="truncate grow">{milestoneLabel(m)}</span>
          <span className="ms-mini__bar" aria-hidden>
            <span style={{ width: `${Math.round(m.progress * 100)}%` }} />
          </span>
          <span className="faint ms-row__date" data-overdue={m.overdue || undefined}>
            {m.targetDate ? formatDue(m.targetDate) : ""}
          </span>
        </button>
      ))}
    </div>
  );
}
