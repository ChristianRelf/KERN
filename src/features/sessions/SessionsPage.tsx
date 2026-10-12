// Time reports: time per day, per project and per task, and the session
// history with edit and delete. Lazy-loaded (Chart.js ships only here).

import { Hourglass, Pencil, Play, Trash } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarElement, CategoryScale, Chart as ChartJS, LinearScale, Tooltip as ChartTooltip, type ChartOptions } from "chart.js";
import { Bar } from "react-chartjs-2";
import { format } from "date-fns";
import type { WorkSession } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { useProjects } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { addDaysStr, dayStartMs, formatDuration, parseDateStr, weekStartStr, monthStartStr, addMonthsStr } from "@/lib/dates";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, Segmented, Select, Skeleton } from "@/components/ui/Controls";
import { confirmDelete, prompt } from "@/components/ui/Dialog";
import { toastError } from "@/stores/toast";
import { navigate } from "@/stores/router";
import { openTask } from "@/features/tasks/menu";
import { startSession } from "./SessionUi";

ChartJS.register(BarElement, CategoryScale, LinearScale, ChartTooltip);

type Range = "today" | "week" | "month" | "30d";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function rangeOf(r: Range, today: string): { from: string; to: string } {
  switch (r) {
    case "today":
      return { from: today, to: addDaysStr(today, 1) };
    case "week": {
      const s = weekStartStr(today);
      return { from: s, to: addDaysStr(s, 7) };
    }
    case "month": {
      const s = monthStartStr(today);
      return { from: s, to: addMonthsStr(s, 1) };
    }
    default:
      return { from: addDaysStr(today, -29), to: addDaysStr(today, 1) };
  }
}

export default function SessionsPage({ projectId }: { projectId?: string }) {
  const today = useToday();
  const [range, setRange] = useState<Range>("week");
  const [project, setProject] = useState<string>(projectId ?? "all");
  const { data: projects } = useProjects();
  const { from, to } = rangeOf(range, today);
  const pid = project === "all" ? null : project;
  const { data: report } = useQuery({
    queryKey: ["sessions", "report", from, to, pid],
    queryFn: () => api.sessions.report(dayStartMs(from), dayStartMs(to), pid),
  });
  const { data: list } = useQuery({
    queryKey: ["sessions", "list", from, to, pid],
    queryFn: () => api.sessions.list({ from: dayStartMs(from), to: dayStartMs(to), projectId: pid, limit: 300 }),
  });

  const days = useMemo(() => {
    const out: { day: string; ms: number }[] = [];
    for (let d = from; d < to; d = addDaysStr(d, 1)) out.push({ day: d, ms: report?.byDay.find((b) => b.key === d)?.ms ?? 0 });
    return out;
  }, [from, to, report]);

  const chart = useMemo(() => {
    const text = css("--text-3") || "#808080";
    const bar = css("--accent") || "#e6e6e6";
    const options: ChartOptions<"bar"> = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { tooltip: { callbacks: { label: (c) => formatDuration((c.raw as number) * 3600) } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: text, font: { size: 11 } } },
        y: { grid: { color: css("--divider") || "rgba(255,255,255,.06)" }, ticks: { color: text, font: { size: 11 }, callback: (v) => `${v}h` }, beginAtZero: true },
      },
    };
    const data = {
      labels: days.map((d) => format(parseDateStr(d.day), days.length > 8 ? "d" : "EEE")),
      datasets: [{ data: days.map((d) => +(d.ms / 3_600_000).toFixed(2)), backgroundColor: bar, borderRadius: 3, maxBarThickness: 28 }],
    };
    return { options, data };
  }, [days]);

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <Hourglass /> Time
        </h1>
        <div className="page-header__actions">
          <Select
            value={project}
            onChange={setProject}
            options={[{ value: "all", label: "All projects" }, ...(projects ?? []).map((p) => ({ value: p.id, label: p.name }))]}
            ariaLabel="Project"
          />
          <Segmented
            size="sm"
            value={range}
            onChange={setRange}
            ariaLabel="Period"
            options={[
              { value: "today", label: "Today" },
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
              { value: "30d", label: "30 days" },
            ]}
          />
          <Button size="sm" icon={Play} onClick={() => void startSession({ projectId: pid })}>
            Start session
          </Button>
        </div>
      </header>
      <div className="page-body page-body--pad">
        <div className="sessions-report">
          <div className="rundown-stats" style={{ margin: 0 }}>
            <div className="stat">
              <span className="stat__value tabular">{report ? formatDuration(report.totalMs / 1000) : "–"}</span>
              <span className="stat__label">Tracked</span>
            </div>
            <div className="stat">
              <span className="stat__value tabular">{report?.sessions ?? "–"}</span>
              <span className="stat__label">Sessions</span>
            </div>
            <div className="stat">
              <span className="stat__value tabular">{report && report.sessions ? formatDuration(report.totalMs / 1000 / report.sessions) : "–"}</span>
              <span className="stat__label">Average</span>
            </div>
          </div>
          {range !== "today" && (
            <div className="panel" style={{ height: 200 }}>
              <Bar options={chart.options} data={chart.data} aria-label="Hours per day" />
            </div>
          )}
          <div className="sessions-report__cols">
            <Breakdown title="By project" rows={report?.byProject} total={report?.totalMs ?? 0} onOpen={(k) => k && navigate({ name: "project", id: k })} />
            <Breakdown title="By task" rows={report?.byTask} total={report?.totalMs ?? 0} onOpen={(k) => k && openTask(k)} />
          </div>
          <div className="col" style={{ gap: 2 }}>
            <div className="section-title">
              Sessions <span className="count">{list?.length ?? 0}</span>
            </div>
            {!list ? <Skeleton height={60} /> : list.length === 0 ? <EmptyState compact icon={Hourglass}>No sessions in this period.</EmptyState> : list.map((s) => <SessionRow key={s.id} s={s} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Breakdown({ title, rows, total, onOpen }: { title: string; rows?: { key: string | null; label: string; ms: number; sessions: number }[]; total: number; onOpen: (key: string | null) => void }) {
  return (
    <div className="panel">
      <div className="panel__title">{title}</div>
      {!rows ? (
        <Skeleton height={40} />
      ) : rows.length === 0 ? (
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Nothing yet.</span>
      ) : (
        rows.map((r) => (
          <button key={r.key ?? "none"} type="button" className="breakdown-row" disabled={!r.key} onClick={() => onOpen(r.key)}>
            <span className="truncate grow">{r.label}</span>
            <span className="faint tabular">{formatDuration(r.ms / 1000)}</span>
            <span className="breakdown-row__bar" style={{ width: `${total ? (r.ms / total) * 100 : 0}%` }} aria-hidden />
          </button>
        ))
      )}
    </div>
  );
}

function SessionRow({ s }: { s: WorkSession }) {
  const start = new Date(s.startedAt);
  const end = s.endedAt ? new Date(s.endedAt) : null;
  const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="session-row">
      <span className="faint tabular session-row__when">
        {format(start, "EEE d MMM")} · {time(start)}–{end ? time(end) : "now"}
      </span>
      <button type="button" className="truncate grow" style={{ textAlign: "left" }} disabled={!s.taskId} onClick={() => s.taskId && openTask(s.taskId)}>
        {s.taskTitle ?? s.projectName ?? "No project"}
        {s.note && <span className="faint"> - {s.note}</span>}
      </button>
      {s.branch && <span className="chip">{s.branch}</span>}
      <span className="tabular">{formatDuration(s.elapsedMs / 1000)}</span>
      <IconButton
        icon={Pencil}
        label="Edit note"
        size="sm"
        onClick={async () => {
          const note = await prompt({ title: "Session note", initial: s.note, placeholder: "What did you do?" });
          if (note === null) return;
          await api.sessions.update(s.id, { note }).catch((e) => toastError(describeError(e)));
          invalidate("sessions");
        }}
      />
      {s.status === "ended" && (
        <IconButton
          icon={Trash}
          label="Delete session"
          size="sm"
          onClick={async () => {
            if (!(await confirmDelete("Delete this session?", "Its time is removed from the reports and from the task's tracked time."))) return;
            await api.sessions.delete(s.id).catch((e) => toastError(describeError(e)));
            invalidate("sessions", "task", "tasks");
          }}
        />
      )}
    </div>
  );
}
