import { Check, Inbox, Plus, Search, Tag } from "lucide-react";
import { useMemo, useState, type ReactElement } from "react";
import { Popover } from "@/components/ui/Controls";
import { DatePicker } from "@/components/ui/DatePicker";
import { useLabels, useProjects } from "@/hooks/data";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import type { Recurrence } from "@/lib/types";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { toastError } from "@/stores/toast";
import { Segmented, Switch } from "@/components/ui/Controls";
import { Button } from "@/components/ui/Button";
import { isoWeekday, parseDateStr, todayStr } from "@/lib/dates";
import { getSetting } from "@/stores/settings";

// ------------------------------------------------------------ list popover

function FilterList<T>({
  items,
  placeholder,
  render,
  onPick,
  footer,
  getKey,
  getText,
  emptyCreate,
}: {
  items: T[];
  placeholder: string;
  render: (item: T) => React.ReactNode;
  onPick: (item: T) => void;
  footer?: React.ReactNode;
  getKey: (item: T) => string;
  getText: (item: T) => string;
  emptyCreate?: (q: string) => void;
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((i) => getText(i).toLowerCase().includes(s)) : items;
  }, [q, items, getText]);
  const canCreate = !!emptyCreate && q.trim() && !items.some((i) => getText(i).toLowerCase() === q.trim().toLowerCase());
  return (
    <div style={{ width: 240, padding: 4 }}>
      <div className="input-wrap" style={{ margin: 4 }}>
        <Search />
        <input
          className="input"
          autoFocus
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (filtered[idx]) onPick(filtered[idx]);
              else if (canCreate) emptyCreate!(q.trim());
            }
          }}
        />
      </div>
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        {filtered.map((item, i) => (
          <div
            key={getKey(item)}
            className="menu__item"
            data-highlighted={i === idx ? "" : undefined}
            onMouseEnter={() => setIdx(i)}
            onClick={() => onPick(item)}
            role="option"
            aria-selected={i === idx}
          >
            {render(item)}
          </div>
        ))}
        {canCreate && (
          <div className="menu__item" data-highlighted={filtered.length === 0 ? "" : undefined} onClick={() => emptyCreate!(q.trim())}>
            <Plus size={14} />
            <span className="truncate">Create “{q.trim()}”</span>
          </div>
        )}
        {!filtered.length && !canCreate && <div className="menu__item faint">No matches</div>}
      </div>
      {footer}
    </div>
  );
}

// ------------------------------------------------------------ project

export function ProjectPicker({
  value,
  onChange,
  trigger,
  allowNone = true,
}: {
  value: string | null;
  onChange: (projectId: string | null) => void;
  trigger: ReactElement;
  allowNone?: boolean;
}) {
  const { data: projects } = useProjects();
  const [open, setOpen] = useState(false);
  type Item = { id: string | null; name: string; icon: string | null; accent: string | null };
  const items: Item[] = [
    ...(allowNone ? [{ id: null, name: "No project", icon: null, accent: null }] : []),
    ...(projects ?? []).map((p) => ({ id: p.id, name: p.name, icon: p.icon, accent: p.accent })),
  ];
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={trigger}>
      <FilterList<Item>
        items={items}
        placeholder="Move to project…"
        getKey={(i) => i.id ?? "none"}
        getText={(i) => i.name}
        onPick={(i) => {
          setOpen(false);
          onChange(i.id);
        }}
        render={(i) => (
          <>
            {i.id ? <ProjectGlyph project={i} size={14} /> : <Inbox size={14} />}
            <span className="truncate grow">{i.name}</span>
            {i.id === value && <Check size={14} className="menu__check" />}
          </>
        )}
      />
    </Popover>
  );
}

// ------------------------------------------------------------ labels

export function LabelPicker({
  value,
  onToggle,
  trigger,
}: {
  value: string[];
  onToggle: (labelId: string, on: boolean) => void;
  trigger: ReactElement;
}) {
  const { data: labels } = useLabels();
  const [open, setOpen] = useState(false);
  const create = async (name: string) => {
    try {
      const l = await api.labels.create(name);
      invalidate("labels");
      onToggle(l.id, true);
    } catch (e) {
      toastError(describeError(e));
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={trigger}>
      <FilterList
        items={labels ?? []}
        placeholder="Add label…"
        getKey={(l) => l.id}
        getText={(l) => l.name}
        onPick={(l) => onToggle(l.id, !value.includes(l.id))}
        emptyCreate={(q) => void create(q)}
        render={(l) => (
          <>
            <Tag size={14} />
            <span className="truncate grow">{l.name}</span>
            {value.includes(l.id) && <Check size={14} className="menu__check" />}
          </>
        )}
      />
    </Popover>
  );
}

// ------------------------------------------------------------ due date

export function DuePopover({
  date,
  time,
  onChange,
  trigger,
  withTime = true,
}: {
  date: string | null;
  time?: string | null;
  onChange: (date: string | null, time: string | null) => void;
  trigger: ReactElement;
  withTime?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={trigger}>
      <DatePicker
        value={date}
        time={time}
        withTime={withTime}
        onChange={(d, t) => {
          onChange(d, t);
          // Keep open while only the time changed.
          if (d !== date || !withTime) setOpen(false);
        }}
      />
    </Popover>
  );
}

// ------------------------------------------------------------ recurrence

const FREQS: { value: Recurrence["freq"] | "none"; label: string }[] = [
  { value: "none", label: "Never" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];
const WD = ["M", "T", "W", "T", "F", "S", "S"];

export function describeRecurrence(r: Recurrence | null | undefined): string {
  if (!r) return "";
  const n = r.interval ?? 1;
  const unit = { daily: "day", weekdays: "weekday", weekly: "week", monthly: "month", yearly: "year" }[r.freq];
  let base = r.freq === "weekdays" ? "Every weekday" : n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
  if (r.freq === "weekly" && r.weekdays?.length) {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    base += ` on ${r.weekdays.map((d) => names[d - 1]).join(", ")}`;
  }
  if (r.fromCompletion) base += " after completion";
  return base;
}

export function RecurrencePicker({
  value,
  dueDate,
  onChange,
  trigger,
}: {
  value: Recurrence | null;
  dueDate: string | null;
  onChange: (r: Recurrence | null) => void;
  trigger: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const base = dueDate ?? todayStr();
  const [draft, setDraft] = useState<Recurrence>(
    value ?? { freq: "weekly", interval: 1, weekdays: [isoWeekday(base)], fromCompletion: getSetting("tasks.recurrenceFromCompletion") },
  );
  const [freq, setFreq] = useState<Recurrence["freq"] | "none">(value?.freq ?? "none");
  const apply = () => {
    if (freq === "none") onChange(null);
    else {
      const r: Recurrence = { ...draft, freq, interval: Math.max(1, draft.interval || 1) };
      if (freq !== "weekly") delete r.weekdays;
      if (freq === "monthly") r.dayOfMonth = parseDateStr(base).getDate();
      else delete r.dayOfMonth;
      onChange(r);
    }
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen} trigger={trigger} pad>
      <div className="col" style={{ gap: 12, width: 264 }}>
        <div className="field">
          <span className="field__label">Repeat</span>
          <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
            {FREQS.map((f) => (
              <button
                key={f.value}
                type="button"
                className="chip chip-btn"
                data-state={freq === f.value ? "on" : undefined}
                style={freq === f.value ? { background: "var(--selection-strong)", color: "var(--text)" } : undefined}
                onClick={() => setFreq(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {freq !== "none" && freq !== "weekdays" && (
          <div className="row">
            <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>
              Every
            </span>
            <input
              className="input"
              type="number"
              min={1}
              max={365}
              style={{ width: 64 }}
              value={draft.interval}
              onChange={(e) => setDraft({ ...draft, interval: Number(e.target.value) })}
            />
            <span className="muted" style={{ fontSize: "var(--fs-sm)" }}>
              {{ daily: "days", weekly: "weeks", monthly: "months", yearly: "years" }[freq as "daily"]}
            </span>
          </div>
        )}
        {freq === "weekly" && (
          <div className="row" style={{ gap: 4 }}>
            {WD.map((d, i) => {
              const iso = i + 1;
              const on = draft.weekdays?.includes(iso);
              return (
                <button
                  key={i}
                  type="button"
                  className="icon-btn icon-btn--sm"
                  data-active={on || undefined}
                  aria-pressed={on}
                  aria-label={["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][i]}
                  onClick={() => {
                    const set = new Set(draft.weekdays ?? []);
                    if (on) set.delete(iso);
                    else set.add(iso);
                    setDraft({ ...draft, weekdays: [...set].sort() });
                  }}
                  style={{ fontSize: 12, fontWeight: 600 }}
                >
                  {d}
                </button>
              );
            })}
          </div>
        )}
        {freq !== "none" && (
          <label className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
            <span className="muted">Schedule from completion date</span>
            <Switch checked={!!draft.fromCompletion} onChange={(v) => setDraft({ ...draft, fromCompletion: v })} />
          </label>
        )}
        <Button variant="primary" size="sm" onClick={apply}>
          Done
        </Button>
      </div>
    </Popover>
  );
}

export function StatusSegmented({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Segmented
      size="sm"
      value={value}
      onChange={onChange}
      options={[
        { value: "todo", label: "To Do" },
        { value: "in_progress", label: "Doing" },
        { value: "blocked", label: "Blocked" },
      ]}
    />
  );
}
