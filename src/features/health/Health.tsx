/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Project health: a compact state chip (On track / Needs attention /
// Blocked / No recent data) with an actionable breakdown, and the rules
// that decide it. No scores.

import { CircleAlert, CircleCheck, CircleDashed, CircleSlash, Settings2 } from "lucide-react";
import { useState } from "react";
import type { HealthItem, HealthPrefs, Project, ProjectHealth } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import { navigate } from "@/stores/router";
import { useUi } from "@/stores/ui";
import { toastError } from "@/stores/toast";
import { IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Popover, Skeleton, Switch } from "@/components/ui/Controls";
import { openLink } from "@/features/links/links";
import { useCapabilities, useHealth, useRepos } from "@/features/dev/hooks";

export const HEALTH_LABEL: Record<ProjectHealth["state"], string> = {
  on_track: "On track",
  needs_attention: "Needs attention",
  blocked: "Blocked",
  no_data: "No recent data",
};

const ICON = { on_track: CircleCheck, needs_attention: CircleAlert, blocked: CircleSlash, no_data: CircleDashed };

/** Where a health item leads. */
export function openHealthItem(project: Pick<Project, "id">, item: HealthItem) {
  switch (item.target) {
    case "tasks":
      navigate({ name: "project", id: project.id, tab: "tasks" });
      break;
    case "milestones":
      if (item.targetRef) useUi.getState().openInspector({ kind: "milestone", id: item.targetRef });
      else navigate({ name: "project", id: project.id, tab: "milestones" });
      break;
    case "build":
      if (item.targetRef) void openLink(item.targetRef);
      else navigate({ name: "project", id: project.id, tab: "code" });
      break;
    default:
      navigate({ name: "project", id: project.id, tab: "code" });
  }
}

export function HealthItems({ project, health }: { project: Pick<Project, "id">; health: ProjectHealth }) {
  if (!health.items.length)
    return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{health.state === "no_data" ? "Add tasks or milestones to track this project." : "Nothing needs attention."}</span>;
  return (
    <div className="col" style={{ gap: 1 }}>
      {health.items.map((i) => (
        <button key={i.key} type="button" className="health-item" data-severity={i.severity} onClick={() => openHealthItem(project, i)}>
          <span className="health-item__dot" aria-hidden />
          <span className="truncate grow">{i.label}</span>
        </button>
      ))}
    </div>
  );
}

export function HealthBadge({ project }: { project: Project }) {
  const { data: h } = useHealth(project.id);
  const [prefsOpen, setPrefsOpen] = useState(false);
  if (!h) return null;
  const Icon = ICON[h.state];
  return (
    <>
      <Popover
        align="end"
        pad
        trigger={
          <button type="button" className="health-chip" data-state={h.state} aria-label={`Project health: ${HEALTH_LABEL[h.state]}`}>
            <Icon size={13} />
            <span>{HEALTH_LABEL[h.state]}</span>
          </button>
        }
      >
        <div className="col" style={{ gap: 8, width: 280 }}>
          <div className="row" style={{ gap: 6 }}>
            <Icon size={14} className="health-icon" data-state={h.state} />
            <b style={{ fontSize: "var(--fs-sm)" }}>{HEALTH_LABEL[h.state]}</b>
            <span className="spacer" />
            <IconButton icon={Settings2} label="Health rules" size="sm" onClick={() => setPrefsOpen(true)} />
          </div>
          <HealthItems project={project} health={h} />
        </div>
      </Popover>
      {prefsOpen && <HealthPrefsDialog project={project} prefs={h.prefs} onClose={() => setPrefsOpen(false)} />}
    </>
  );
}

/** Command Centre widget body. */
export function HealthPanel({ project }: { project: Project }) {
  const { data: h } = useHealth(project.id);
  if (!h) return <Skeleton height={40} />;
  const Icon = ICON[h.state];
  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="health-state" data-state={h.state}>
        <Icon size={15} /> {HEALTH_LABEL[h.state]}
      </span>
      <HealthItems project={project} health={h} />
    </div>
  );
}

function HealthPrefsDialog({ project, prefs, onClose }: { project: Project; prefs: HealthPrefs; onClose: () => void }) {
  const { data: caps } = useCapabilities(project.id);
  const { data: repos } = useRepos(project.id, !!caps?.repositories);
  const [p, setP] = useState(prefs);
  const dev = !!caps && (caps.repositories > 0 || caps.services > 0);
  const save = async () => {
    try {
      const h = await api.health.setPrefs(project.id, p);
      queryClient.setQueryData(["health", project.id], h);
      onClose();
    } catch (e) {
      toastError(describeError(e));
    }
  };
  const row = (label: string, k: keyof HealthPrefs, extra?: React.ReactNode) => (
    <label className="row health-rule">
      <Switch checked={p[k] as boolean} onChange={(v) => setP({ ...p, [k]: v })} label={label} />
      <span className="grow">{label}</span>
      {extra}
    </label>
  );
  const num = (k: "dueSoonDays" | "staleDays", min: number, max: number) => (
    <input className="input input--sm tabular" type="number" min={min} max={max} value={p[k]} style={{ width: 64 }} onChange={(e) => setP({ ...p, [k]: Math.max(min, Math.min(max, Number(e.target.value) || min)) })} aria-label="Days" />
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Health rules"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="dialog__desc">Choose what counts towards this project's health. Not opening a project never counts against it.</p>
      <div className="col" style={{ gap: 4 }}>
        {row("Overdue tasks", "overdue")}
        {row("Blocked tasks", "blocked")}
        {row("Tasks due soon (days)", "dueSoon", num("dueSoonDays", 0, 60))}
        {row("Stalled tasks in progress (days)", "stale", num("staleDays", 1, 365))}
        {row("Milestones past their target or waiting", "milestones")}
        {dev && (
          <>
            <div className="section-title" style={{ marginTop: 8 }}>
              Development
            </div>
            {row("Failing CI on the default branch", "ci")}
            {row("Pull requests awaiting review or changes", "pulls")}
            {row("Dependency advisories", "dependencies")}
            {row("Local services down or degraded", "services")}
            {repos && repos.length > 1 && (
              <div className="col" style={{ gap: 4, marginTop: 4 }}>
                <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                  Repositories included (none selected = all)
                </span>
                {repos.map((r) => (
                  <label key={r.id} className="row health-rule">
                    <Switch
                      checked={p.repositories.includes(r.id)}
                      onChange={(v) => setP({ ...p, repositories: v ? [...p.repositories, r.id] : p.repositories.filter((x) => x !== r.id) })}
                      label={r.name}
                    />
                    <span className="grow">{r.name}</span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
