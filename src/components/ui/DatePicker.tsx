/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { ChevronLeft, ChevronRight, CalendarX, Sun, Sunrise, CalendarClock, Sofa } from "lucide-react";
import { useMemo, useState } from "react";
import {
  addDaysStr,
  addMonthsStr,
  formatDue,
  formatTime,
  monthGrid,
  monthStartStr,
  nextWeekdayStr,
  parseDateStr,
  todayStr,
  weekdayLabels,
} from "@/lib/dates";
import { format } from "date-fns";
import { IconButton } from "./Button";

/** Inline date (and optional time) picker used inside popovers. */
export function DatePicker({
  value,
  time,
  onChange,
  withTime = true,
  allowClear = true,
}: {
  value: string | null;
  time?: string | null;
  onChange: (date: string | null, time: string | null) => void;
  withTime?: boolean;
  allowClear?: boolean;
}) {
  const today = todayStr();
  const [month, setMonth] = useState(() => monthStartStr(value ?? today));
  const [timeText, setTimeText] = useState(time ? formatTime(time, "24h") : "");
  const days = useMemo(() => monthGrid(month), [month]);
  const monthIdx = parseDateStr(month).getMonth();

  const commitTime = (raw: string) => {
    const m = raw.trim().match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/i);
    if (!raw.trim()) return onChange(value, null);
    if (!m) return setTimeText(time ? formatTime(time, "24h") : "");
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (m[3]?.toLowerCase() === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) return setTimeText(time ? formatTime(time, "24h") : "");
    const t = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    setTimeText(t);
    onChange(value ?? today, t);
  };

  const quick = [
    { label: "Today", icon: Sun, date: today },
    { label: "Tomorrow", icon: Sunrise, date: addDaysStr(today, 1) },
    { label: "Next week", icon: CalendarClock, date: nextWeekdayStr(today, 1) },
    { label: "Weekend", icon: Sofa, date: nextWeekdayStr(addDaysStr(today, -1), 6) },
  ];

  return (
    <div className="datepicker" onKeyDown={(e) => e.stopPropagation()}>
      <div className="datepicker__quick">
        {quick.map((q) => (
          <button key={q.label} type="button" onClick={() => onChange(q.date, time ?? null)}>
            <q.icon size={14} strokeWidth={1.75} />
            {q.label}
            <span>{format(parseDateStr(q.date), "EEE")}</span>
          </button>
        ))}
      </div>
      <div className="datepicker__head">
        <span>{format(parseDateStr(month), "MMMM yyyy")}</span>
        <div className="row" style={{ gap: 2 }}>
          <IconButton icon={ChevronLeft} label="Previous month" size="sm" noTooltip onClick={() => setMonth(addMonthsStr(month, -1))} />
          <IconButton icon={ChevronRight} label="Next month" size="sm" noTooltip onClick={() => setMonth(addMonthsStr(month, 1))} />
        </div>
      </div>
      <div className="datepicker__grid" role="grid">
        {weekdayLabels(undefined, "narrow").map((d, i) => (
          <div key={i} className="datepicker__dow">
            {d}
          </div>
        ))}
        {days.map((d) => (
          <button
            key={d}
            type="button"
            className="datepicker__day"
            data-outside={parseDateStr(d).getMonth() !== monthIdx}
            data-today={d === today}
            data-selected={d === value}
            aria-label={formatDue(d)}
            onClick={() => onChange(d, time ?? null)}
          >
            {parseDateStr(d).getDate()}
          </button>
        ))}
      </div>
      {(withTime || allowClear) && (
        <div className="datepicker__footer">
          {withTime && (
            <input
              className="input"
              placeholder="Time"
              value={timeText}
              onChange={(e) => setTimeText(e.target.value)}
              onBlur={(e) => commitTime(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTime((e.target as HTMLInputElement).value);
              }}
              aria-label="Time"
            />
          )}
          <span className="spacer" />
          {allowClear && value && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(null, null)}>
              <CalendarX />
              No date
            </button>
          )}
        </div>
      )}
    </div>
  );
}
