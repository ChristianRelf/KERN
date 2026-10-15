/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ArrowUpRight, X, Sunrise } from "lucide-react";
import type { WidgetProps } from "../types";
import { useRundown } from "@/features/daily-briefing/useRundown";
import { Skeleton, EmptyState, TaskCheck, Switch } from "@/components/ui/Controls";
import { IconButton } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { navigate } from "@/stores/router";
import { openTask } from "@/features/tasks/menu";
import { toggleComplete } from "@/features/tasks/actions";
import { DueLabel } from "@/features/tasks/TaskRow";
import { MiniTaskList } from "../MiniTaskList";

export type RundownConfig = { showStats: boolean; showSuggestions: boolean; showLists: boolean };

export function RundownWidget({ config, size }: WidgetProps<RundownConfig>) {
  const { rundown, isLoading, setSkipped, today } = useRundown();
  if (isLoading || !rundown)
    return (
      <div className="col" style={{ gap: 8 }}>
        <Skeleton height={14} width="90%" />
        <Skeleton height={14} width="70%" />
        <Skeleton height={40} />
      </div>
    );
  const c = rundown.counts;
  const roomy = size.h >= 7;
  return (
    <div className="col" style={{ gap: 4 }}>
      <p className="rundown-summary selectable">{rundown.summary}</p>
      {config.showStats && (
        <div className="rundown-stats">
          <Stat value={c.today} label="Due today" />
          <Stat value={c.overdue} label="Overdue" />
          <Stat value={c.high} label="High priority" />
          <Stat value={c.completedToday} label="Done today" />
        </div>
      )}
      {config.showSuggestions && rundown.suggestions.length > 0 && (
        <>
          <div className="mini-head">Start with</div>
          {rundown.suggestions.map((s, i) => (
            <div key={s.task.id} className="suggest" onClick={() => openTask(s.task.id)} role="button" tabIndex={0}>
              <span className="suggest__rank">{i + 1}</span>
              <TaskCheck checked={false} onToggle={() => void toggleComplete(s.task)} priority={s.task.priority} />
              <div className="col grow">
                <span className="truncate">{s.task.title}</span>
                <Tooltip content={s.factors.map((f) => `${f.label} (+${f.points})`).join(" · ")} side="bottom">
                  <span className="suggest__reasons">{s.factors.map((f) => f.label).join(" · ")}</span>
                </Tooltip>
              </div>
              <DueLabel date={s.task.dueDate} time={s.task.dueTime} done={false} today={today} />
              <IconButton
                icon={X}
                label="Not today"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  void setSkipped(s.task.id, true);
                }}
              />
            </div>
          ))}
        </>
      )}
      {config.showLists && roomy && rundown.overdue.length > 0 && (
        <>
          <div className="mini-head">Overdue</div>
          <MiniTaskList tasks={rundown.overdue} max={4} onMore={() => navigate({ name: "rundown" })} />
        </>
      )}
      {config.showLists && roomy && rundown.carryovers.length > 0 && (
        <>
          <div className="mini-head">Carried over</div>
          <MiniTaskList tasks={rundown.carryovers} max={3} onMore={() => navigate({ name: "rundown" })} />
        </>
      )}
      {config.showLists && roomy && rundown.projects.length > 0 && (
        <>
          <div className="mini-head">Needs attention</div>
          {rundown.projects.slice(0, 3).map((p) => (
            <button
              key={p.project.id}
              type="button"
              className="mini-task"
              onClick={() => navigate({ name: "project", id: p.project.id })}
              style={{ textAlign: "left" }}
            >
              <span className="mini-task__title">{p.project.name}</span>
              <span className="mini-task__meta">{p.reasons[0]}</span>
            </button>
          ))}
        </>
      )}
      {!rundown.suggestions.length && !rundown.today.length && !rundown.overdue.length && (
        <EmptyState compact icon={Sunrise}>
          Add due dates or priorities and they'll show up here.
        </EmptyState>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="stat">
      <span className="stat__value">{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

export function RundownHeader() {
  return <IconButton icon={ArrowUpRight} label="Open full rundown" size="sm" onClick={() => navigate({ name: "rundown" })} />;
}

export function RundownConfigForm({ config, setConfig }: { config: RundownConfig; setConfig: (p: Partial<RundownConfig>) => void }) {
  return (
    <div className="col" style={{ gap: 10 }}>
      <ToggleRow label="Counts" value={config.showStats} onChange={(v) => setConfig({ showStats: v })} />
      <ToggleRow label="Suggestions" value={config.showSuggestions} onChange={(v) => setConfig({ showSuggestions: v })} />
      <ToggleRow label="Overdue, carry-overs & projects" value={config.showLists} onChange={(v) => setConfig({ showLists: v })} />
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => navigate({ name: "settings", section: "rundown" })}>
        Rundown settings…
      </button>
    </div>
  );
}

export function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
      <span className="muted">{label}</span>
      <Switch checked={value} onChange={onChange} label={label} />
    </label>
  );
}
