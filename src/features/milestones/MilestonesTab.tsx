/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Project → Milestones: a list (upcoming / completed / all) and a simple
// timeline. Works for any project; release details only appear for
// milestones marked as releases.

import { CalendarRange, Check, Flag, List, Milestone as MilestoneIcon, Plus, Rocket, TriangleAlert, Link2 } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactElement } from "react";
import { format } from "date-fns";
import type { Milestone } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { EmptyState, Popover, Progress, Segmented, Skeleton } from "@/components/ui/Controls";
import { ContextMenu, type MenuItems } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { FilterList } from "@/features/tasks/pickers";
import { addDaysStr, diffDays, formatDue, parseDateStr, todayStr } from "@/lib/dates";
import { useToday } from "@/hooks/useToday";
import { useMilestones } from "@/features/dev/hooks";
import { STATUS_LABEL, createMilestone, deleteMilestone, openMilestone, updateMilestone } from "./actions";

type Filter = "upcoming" | "completed" | "all";
type View = "list" | "timeline";

export function milestoneLabel(m: Pick<Milestone, "title" | "version" | "isRelease">) {
  return m.isRelease && m.version ? `${m.title} · ${m.version}` : m.title;
}

export function MilestoneStatusIcon({ m, size = 14 }: { m: Milestone; size?: number }) {
  if (m.status === "completed") return <Check size={size} className="ms-icon" data-state="done" />;
  if (m.overdue || m.blockedBy.length) return <TriangleAlert size={size} className="ms-icon" data-state="warn" />;
  return m.isRelease ? <Rocket size={size} className="ms-icon" /> : <Flag size={size} className="ms-icon" />;
}

export function milestoneMenu(m: Milestone): MenuItems {
  return [
    { label: "Open", icon: MilestoneIcon, onSelect: () => openMilestone(m.id) },
    m.status !== "completed" && { label: "Mark completed", icon: Check, onSelect: () => void updateMilestone(m.id, { status: "completed" }) },
    m.status === "completed" && { label: "Reopen", icon: Flag, onSelect: () => void updateMilestone(m.id, { status: "active" }) },
    { type: "separator" },
    { label: "Delete", danger: true, onSelect: () => void deleteMilestone(m) },
  ];
}

export function MilestoneRow({ m, compact }: { m: Milestone; compact?: boolean }) {
  const today = useToday();
  const due = m.targetDate ? diffDays(today, m.targetDate) : null;
  return (
    <ContextMenu items={() => milestoneMenu(m)}>
      <button type="button" className="ms-row" data-done={m.status === "completed" || undefined} data-cancelled={m.status === "cancelled" || undefined} onClick={() => openMilestone(m.id)}>
        <MilestoneStatusIcon m={m} />
        <span className="col grow" style={{ gap: 3, minWidth: 0 }}>
          <span className="row" style={{ gap: 6, minWidth: 0 }}>
            <span className="truncate ms-row__title">{m.title}</span>
            {m.isRelease && m.version && <span className="chip">{m.version}</span>}
          </span>
          {!compact && (
            <span className="row" style={{ gap: 8 }}>
              <Progress value={m.progress} style={{ flex: 1, maxWidth: 220 }} />
              <span className="faint tabular" style={{ fontSize: "var(--fs-xs)" }}>
                {m.progressMode === "manual" ? `${Math.round(m.progress * 100)}%` : `${m.taskDone}/${m.taskTotal}`}
              </span>
            </span>
          )}
        </span>
        {m.blockedBy.length > 0 && m.status !== "completed" && (
          <Tooltip content={`Waiting on ${m.blockedBy.length} other milestone${m.blockedBy.length === 1 ? "" : "s"}`}>
            <span className="chip">
              <Link2 size={11} /> Waiting
            </span>
          </Tooltip>
        )}
        <span className="ms-row__date" data-overdue={m.overdue || undefined}>
          {m.status === "completed" && m.completedAt ? `Done ${format(new Date(m.completedAt), "d MMM")}` : m.targetDate ? (due !== null && due < 0 ? `${formatDue(m.targetDate)} · overdue` : formatDue(m.targetDate)) : STATUS_LABEL[m.status]}
        </span>
      </button>
    </ContextMenu>
  );
}

export function MilestonesTab({ projectId }: { projectId: string }) {
  const { data: list, isLoading } = useMilestones(projectId);
  const [filter, setFilter] = useState<Filter>("upcoming");
  const [view, setView] = useState<View>("list");
  const shown = useMemo(() => {
    const all = list ?? [];
    if (filter === "all") return all;
    if (filter === "completed") return all.filter((m) => m.status === "completed" || m.status === "cancelled");
    return all.filter((m) => m.status === "planned" || m.status === "active");
  }, [list, filter]);
  const overdue = (list ?? []).filter((m) => m.overdue).length;
  return (
    <>
      <div className="toolbar">
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          ariaLabel="Milestones shown"
          options={[
            { value: "upcoming", label: "Upcoming" },
            { value: "completed", label: "Completed" },
            { value: "all", label: "All" },
          ]}
        />
        {overdue > 0 && <span className="chip chip--warn">{overdue} overdue</span>}
        <span className="spacer" />
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          ariaLabel="View"
          options={[
            { value: "list", icon: List, tooltip: "List" },
            { value: "timeline", icon: CalendarRange, tooltip: "Timeline" },
          ]}
        />
        <Button size="sm" icon={Plus} onClick={() => void createMilestone({ projectId })}>
          Milestone
        </Button>
      </div>
      <div className="page-body page-body--pad">
        {isLoading ? (
          <Skeleton height={80} />
        ) : !list?.length ? (
          <EmptyState
            icon={Flag}
            title="No milestones yet"
            action={
              <div className="row" style={{ gap: 6 }}>
                <Button icon={Plus} onClick={() => void createMilestone({ projectId })}>
                  Add a milestone
                </Button>
                <Button variant="ghost" icon={Rocket} onClick={() => void createMilestone({ projectId, isRelease: true })}>
                  Plan a release
                </Button>
              </div>
            }
          >
            Group tasks towards a goal with a target date - a launch, a deadline, a finished room.
          </EmptyState>
        ) : view === "list" ? (
          <div className="ms-list">
            {shown.map((m) => (
              <MilestoneRow key={m.id} m={m} />
            ))}
            {!shown.length && <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Nothing here.</span>}
          </div>
        ) : (
          <Timeline milestones={shown} />
        )}
      </div>
    </>
  );
}

/** Milestones placed on a month axis by target date (undated ones listed after). */
function Timeline({ milestones }: { milestones: Milestone[] }) {
  const today = todayStr();
  const dated = milestones.filter((m) => m.targetDate).sort((a, b) => a.targetDate!.localeCompare(b.targetDate!));
  const undated = milestones.filter((m) => !m.targetDate);
  if (!dated.length)
    return (
      <div className="col" style={{ gap: 8 }}>
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Give milestones a target date to place them on the timeline.</span>
        {undated.map((m) => (
          <MilestoneRow key={m.id} m={m} compact />
        ))}
      </div>
    );
  const start = [dated[0].targetDate!, today].sort()[0];
  const end = [dated[dated.length - 1].targetDate!, addDaysStr(today, 14)].sort().reverse()[0];
  const first = addDaysStr(start, -7);
  const span = Math.max(30, diffDays(first, addDaysStr(end, 7)));
  const pos = (d: string) => `${(diffDays(first, d) / span) * 100}%`;
  const months: string[] = [];
  for (let d = first.slice(0, 8) + "01"; d <= end; d = format(new Date(parseDateStr(d).getFullYear(), parseDateStr(d).getMonth() + 1, 1), "yyyy-MM-dd")) {
    if (d >= first) months.push(d);
  }
  return (
    <div className="ms-timeline">
      <div className="ms-timeline__axis">
        {months.map((m) => (
          <span key={m} className="ms-timeline__month" style={{ left: pos(m) }}>
            {format(parseDateStr(m), "MMM yyyy")}
          </span>
        ))}
        <span className="ms-timeline__today" style={{ left: pos(today) }} title="Today" />
      </div>
      <div className="ms-timeline__lanes">
        {dated.map((m) => (
          <div key={m.id} className="ms-timeline__lane">
            <button type="button" className="ms-timeline__item" style={{ left: pos(m.targetDate!) } as CSSProperties} onClick={() => openMilestone(m.id)} data-done={m.status === "completed" || undefined} data-overdue={m.overdue || undefined}>
              <MilestoneStatusIcon m={m} size={12} />
              <span className="truncate">{milestoneLabel(m)}</span>
              <span className="faint">{Math.round(m.progress * 100)}%</span>
            </button>
          </div>
        ))}
      </div>
      {undated.length > 0 && (
        <div className="col" style={{ gap: 4, marginTop: 12 }}>
          <div className="section-title">No target date</div>
          {undated.map((m) => (
            <MilestoneRow key={m.id} m={m} compact />
          ))}
        </div>
      )}
    </div>
  );
}

/** Popover to put a task in one of its project's milestones. */
export function MilestonePicker({ projectId, value, onChange, trigger }: { projectId: string; value: string | null; onChange: (id: string | null) => void; trigger: ReactElement }) {
  const { data } = useMilestones(projectId);
  const [open, setOpen] = useState(false);
  type Item = { id: string | null; title: string; m?: Milestone };
  const items: Item[] = [
    { id: null, title: "No milestone" },
    ...(data ?? []).filter((m) => m.status !== "cancelled" && (m.status !== "completed" || m.id === value)).map((m) => ({ id: m.id, title: milestoneLabel(m), m })),
  ];
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={trigger}>
      <FilterList<Item>
        items={items}
        placeholder="Milestone…"
        getKey={(i) => i.id ?? "none"}
        getText={(i) => i.title}
        onPick={(i) => {
          setOpen(false);
          onChange(i.id);
        }}
        emptyCreate={async (q) => {
          setOpen(false);
          const m = await createMilestone({ projectId, title: q }, false);
          if (m) onChange(m.id);
        }}
        render={(i) => (
          <>
            {i.m ? <MilestoneStatusIcon m={i.m} /> : <Flag size={14} className="faint" />}
            <span className="truncate grow">{i.title}</span>
            {i.m?.targetDate && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{formatDue(i.m.targetDate)}</span>}
            {i.id === value && <Check size={14} className="menu__check" />}
          </>
        )}
      />
    </Popover>
  );
}
