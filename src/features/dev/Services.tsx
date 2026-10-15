/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Local services: endpoints the user configured (a dev server, an API, a
// database). They're checked only while the project is open, on each
// service's interval. "Running" means it answered; "healthy" only when a
// configured health check passed. Start/Stop is offered only when a saved
// command controls the service.

import { Box, Container as ContainerIcon, Ellipsis, ExternalLink, Pencil, Play, Plus, RefreshCw, Square, Trash } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LocalService, Project, ServiceInput } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { useSetting } from "@/stores/settings";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { Dialog, confirm, confirmDelete } from "@/components/ui/Dialog";
import { EmptyState, Select, Skeleton, Switch } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { openLink } from "@/features/links/links";
import { relativeTime } from "@/lib/dates";
import { runInTerminal, useTerminal, closeTab } from "@/features/terminal/store";
import { useCommands, useServices } from "./hooks";

export const SERVICE_LABEL: Record<LocalService["status"], string> = { running: "Running", stopped: "Stopped", degraded: "Degraded", unknown: "Unknown" };

export function ServiceDot({ s }: { s: Pick<LocalService, "status" | "healthy"> }) {
  return <span className="svc-dot" data-status={s.status} data-healthy={s.healthy === true || undefined} aria-hidden />;
}

function statusText(s: LocalService) {
  if (s.status === "running") return s.healthy ? "Healthy" : "Running";
  return SERVICE_LABEL[s.status];
}

export function ServicesSection({ project }: { project: Project }) {
  const poll = useSetting("services.pollWhileOpen");
  const { data, isFetching, refetch } = useServices(project.id, poll);
  const [editing, setEditing] = useState<Partial<ServiceInput> | null>(null);
  const [docker, setDocker] = useState(false);
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 6 }}>
        <span className="section-title">
          Services <span className="count">{data?.length ?? 0}</span>
        </span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon={ContainerIcon} onClick={() => setDocker(true)}>
          Docker
        </Button>
        <IconButton icon={RefreshCw} label="Check now" size="sm" className={isFetching ? "spin" : undefined} onClick={() => void api.services.checkProject(project.id).then((r) => queryClient.setQueryData(["services", project.id, poll], r)).then(() => invalidate("health"))} />
        <Button size="sm" icon={Plus} onClick={() => setEditing({ projectId: project.id, intervalSecs: 30, enabled: true })}>
          Add service
        </Button>
      </div>
      {!data ? (
        <Skeleton height={40} />
      ) : !data.length ? (
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          Add the local endpoints this project uses (like http://localhost:5173 or tcp://localhost:5432) to see whether they're up. Only what you add is checked, and only while the project is open.
        </span>
      ) : (
        <div className="col" style={{ gap: 1 }}>
          {data.map((s) => (
            <ServiceRow key={s.id} project={project} s={s} onEdit={() => setEditing(s)} onChecked={() => void refetch()} />
          ))}
        </div>
      )}
      {editing && <ServiceDialog project={project} initial={editing} onClose={() => setEditing(null)} />}
      {docker && <DockerDialog onClose={() => setDocker(false)} />}
    </div>
  );
}

export function ServiceRow({ project, s, onEdit, onChecked, compact }: { project: Project; s: LocalService; onEdit?: () => void; onChecked?: () => void; compact?: boolean }) {
  const { data: commands } = useCommands(project.id, !!s.commandId);
  const tabs = useTerminal((t) => t.tabs);
  const cmd = commands?.find((c) => c.id === s.commandId);
  const runningTab = tabs.find((t) => t.commandId === s.commandId && t.running);
  const url = s.url.startsWith("http") ? s.url : null;
  return (
    <div className="svc-row">
      <ServiceDot s={s} />
      <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="truncate" style={{ fontWeight: 550 }}>
            {s.name}
          </span>
          <Tooltip content={s.detail ?? "Not checked yet"}>
            <span className="svc-status" data-status={s.status}>
              {statusText(s)}
            </span>
          </Tooltip>
          {s.latencyMs != null && s.status !== "stopped" && <span className="faint tabular" style={{ fontSize: "var(--fs-xs)" }}>{s.latencyMs} ms</span>}
        </span>
        {!compact && (
          <span className="faint truncate mono" style={{ fontSize: "var(--fs-xs)" }}>
            {s.url}
            {s.healthPath ? ` · ${s.healthPath}` : ""}
            {s.checkedAt ? ` · checked ${relativeTime(s.checkedAt)}` : ""}
          </span>
        )}
      </span>
      {s.history.length > 1 && !compact && (
        <span className="svc-history" aria-label="Recent checks">
          {s.history
            .slice(0, 20)
            .reverse()
            .map((h, i) => (
              <span key={i} data-status={h.status} title={`${SERVICE_LABEL[h.status]} · ${new Date(h.checkedAt).toLocaleTimeString()}`} />
            ))}
        </span>
      )}
      {cmd &&
        (runningTab ? (
          <IconButton icon={Square} label={`Stop ${cmd.name}`} size="sm" onClick={() => void closeTab(runningTab.id)} />
        ) : (
          <IconButton icon={Play} label={`Start with “${cmd.name}”`} size="sm" onClick={() => void runInTerminal(project.id, { commandId: cmd.id }, undefined, cmd.name)} />
        ))}
      {url && <IconButton icon={ExternalLink} label="Open" size="sm" onClick={() => void openLink(url)} />}
      <IconButton icon={RefreshCw} label="Check now" size="sm" onClick={() => void api.services.check(s.id).then(() => (invalidate("services", "health"), onChecked?.())).catch((e) => toastError(describeError(e)))} />
      {onEdit && (
        <Dropdown
          align="end"
          items={[
            { label: "Edit…", icon: Pencil, onSelect: onEdit },
            { label: s.enabled ? "Pause checks" : "Resume checks", onSelect: () => void api.services.save({ ...s, enabled: !s.enabled }).then(() => invalidate("services")) },
            { type: "separator" },
            {
              label: "Remove",
              icon: Trash,
              danger: true,
              onSelect: async () => {
                if (!(await confirmDelete(`Remove “${s.name}”?`, "Only Kern's entry is removed; the service itself isn't touched."))) return;
                await api.services.delete(s.id).catch((e) => toastError(describeError(e)));
                invalidate("services", "capabilities", "health");
              },
            },
          ]}
        >
          <IconButton icon={Ellipsis} label="Service actions" size="sm" noTooltip />
        </Dropdown>
      )}
    </div>
  );
}

function ServiceDialog({ project, initial, onClose }: { project: Project; initial: Partial<ServiceInput>; onClose: () => void }) {
  const { data: commands } = useCommands(project.id);
  const [f, setF] = useState<Partial<ServiceInput>>(initial);
  const set = (p: Partial<ServiceInput>) => setF({ ...f, ...p });
  const tcp = (f.url ?? "").startsWith("tcp://");
  const save = async () => {
    try {
      await api.services.save({ projectId: project.id, name: f.name ?? "", url: f.url ?? "", healthPath: f.healthPath ?? null, expectStatus: f.expectStatus ?? null, expectText: f.expectText ?? null, commandId: f.commandId ?? null, repositoryId: f.repositoryId ?? null, intervalSecs: f.intervalSecs ?? 30, enabled: f.enabled ?? true, id: f.id ?? null });
      invalidate("services", "capabilities", "health");
      onClose();
    } catch (e) {
      toastError(describeError(e, "Couldn't save the service."));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={f.id ? "Edit service" : "Add service"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!f.name?.trim() || !f.url?.trim()} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="field">
        <label className="field__label">Name</label>
        <input className="input" autoFocus value={f.name ?? ""} placeholder="Web app" onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="field">
        <label className="field__label">Address</label>
        <input className="input mono" value={f.url ?? ""} placeholder="http://localhost:3000 or tcp://localhost:5432" onChange={(e) => set({ url: e.target.value })} />
      </div>
      {!tcp && (
        <>
          <div className="row" style={{ gap: 8 }}>
            <div className="field grow">
              <label className="field__label">Health-check path</label>
              <input className="input mono" value={f.healthPath ?? ""} placeholder="/health" onChange={(e) => set({ healthPath: e.target.value })} />
            </div>
            <div className="field" style={{ width: 140 }}>
              <label className="field__label">Expected status</label>
              <input className="input mono" value={f.expectStatus ?? ""} placeholder="2xx" onChange={(e) => set({ expectStatus: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label className="field__label">Response must contain (optional)</label>
            <input className="input" value={f.expectText ?? ""} placeholder='"status":"ok"' onChange={(e) => set({ expectText: e.target.value })} />
          </div>
        </>
      )}
      <span className="field__hint">{tcp ? "A TCP check shows whether the port is open; it can't tell whether the service is healthy." : "Without a health check, Kern only reports whether the address responds."}</span>
      <div className="row" style={{ gap: 8 }}>
        <div className="field grow">
          <label className="field__label">Start with command</label>
          <Select value={f.commandId ?? "none"} onChange={(v) => set({ commandId: v === "none" ? null : v })} ariaLabel="Command" options={[{ value: "none", label: "None" }, ...(commands ?? []).map((c) => ({ value: c.id, label: c.name }))]} />
        </div>
        <div className="field" style={{ width: 140 }}>
          <label className="field__label">Check every</label>
          <Select
            value={String(f.intervalSecs ?? 30)}
            onChange={(v) => set({ intervalSecs: Number(v) })}
            ariaLabel="Interval"
            options={[15, 30, 60, 300].map((n) => ({ value: String(n), label: n < 60 ? `${n} s` : `${n / 60} min` }))}
          />
        </div>
      </div>
      <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
        <Switch checked={f.enabled ?? true} onChange={(v) => set({ enabled: v })} label="Check this service" /> Check while the project is open
      </label>
    </Dialog>
  );
}

function DockerDialog({ onClose }: { onClose: () => void }) {
  const { data, error, refetch, isFetching } = useQuery({ queryKey: ["services", "docker"], queryFn: api.services.containers, retry: false });
  const act = async (id: string, name: string, action: "start" | "stop" | "restart") => {
    if (action !== "start" && !(await confirm({ title: `${action === "stop" ? "Stop" : "Restart"} ${name}?`, confirmLabel: action === "stop" ? "Stop" : "Restart" }))) return;
    try {
      await api.services.containerAction(id, action);
      void refetch();
    } catch (e) {
      toastError(describeError(e));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Docker containers" wide>
      {error ? (
        <EmptyState compact icon={Box}>
          {describeError(error, "Docker isn't available.")} Kern works the same without it.
        </EmptyState>
      ) : !data ? (
        <Skeleton height={60} />
      ) : !data.length ? (
        <span className="faint">No containers.</span>
      ) : (
        <div className="col" style={{ gap: 1 }} data-loading={isFetching || undefined}>
          {data.map((c) => (
            <div key={c.id} className="svc-row">
              <span className="svc-dot" data-status={c.state === "running" ? "running" : "stopped"} aria-hidden />
              <span className="col grow" style={{ gap: 1, minWidth: 0 }}>
                <span className="truncate" style={{ fontWeight: 550 }}>
                  {c.name}
                </span>
                <span className="faint truncate mono" style={{ fontSize: "var(--fs-xs)" }}>
                  {c.image} · {c.status}
                  {c.ports ? ` · ${c.ports}` : ""}
                </span>
              </span>
              {c.state === "running" ? (
                <>
                  <IconButton icon={RefreshCw} label="Restart" size="sm" onClick={() => void act(c.id, c.name, "restart")} />
                  <IconButton icon={Square} label="Stop" size="sm" onClick={() => void act(c.id, c.name, "stop")} />
                </>
              ) : (
                <IconButton icon={Play} label="Start" size="sm" onClick={() => void act(c.id, c.name, "start")} />
              )}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
