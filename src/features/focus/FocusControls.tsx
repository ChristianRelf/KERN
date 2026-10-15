/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Coffee, Pause, Play, RotateCcw, SkipForward, Square, Timer } from "lucide-react";
import { useFocus, remainingOf, KIND_LABEL, type FocusKind } from "./store";
import { useNow } from "@/hooks/useToday";
import { formatClock } from "@/lib/dates";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Controls";
import { useTasks } from "@/hooks/data";
import { useToday } from "@/hooks/useToday";
import { Dropdown } from "@/components/ui/Menu";

export function useFocusClock() {
  const f = useFocus();
  const now = useNow(250, f.phase === "running");
  const remaining = remainingOf(f, now);
  const progress = f.durationSec ? 1 - remaining / f.durationSec : 0;
  return { f, remaining, progress };
}

export function KindSwitch() {
  const f = useFocus();
  return (
    <Segmented<FocusKind>
      size="sm"
      value={f.kind}
      onChange={(k) => f.setKind(k)}
      ariaLabel="Session type"
      options={[
        { value: "focus", label: "Focus", icon: Timer },
        { value: "short_break", label: "Short", icon: Coffee },
        { value: "long_break", label: "Long", icon: Coffee },
      ]}
    />
  );
}

export function TaskSelector({ compact }: { compact?: boolean }) {
  const f = useFocus();
  const today = useToday();
  const { data: tasks } = useTasks({ topLevelOnly: true, dueTo: today, hasDue: true, order: "priority", limit: 20 });
  const { data: doing } = useTasks({ topLevelOnly: true, statuses: ["in_progress"], limit: 10 });
  const options = [...(doing ?? []), ...(tasks ?? []).filter((t) => !doing?.some((d) => d.id === t.id))];
  return (
    <Dropdown
      items={[
        { label: "No task", checked: !f.taskId, onSelect: () => f.setTask(null, null) },
        ...(options.length ? [{ type: "separator" as const }] : []),
        ...options.map((t) => ({ label: t.title, checked: f.taskId === t.id, onSelect: () => f.setTask(t.id, t.title) })),
      ]}
      minWidth={240}
    >
      <button type="button" className={compact ? "chip chip-btn" : "btn btn--ghost btn--sm"} style={{ maxWidth: "100%" }}>
        <span className="truncate">{f.taskTitle ?? "Choose a task"}</span>
      </button>
    </Dropdown>
  );
}

export function TransportControls({ size = "md" }: { size?: "md" | "sm" }) {
  const f = useFocus();
  return (
    <div className="row" style={{ gap: 6, justifyContent: "center" }}>
      {f.phase === "idle" && (
        <Button variant="primary" size={size} icon={Play} onClick={() => f.start()}>
          Start
        </Button>
      )}
      {f.phase === "running" && (
        <Button size={size} icon={Pause} onClick={f.pause}>
          Pause
        </Button>
      )}
      {f.phase === "paused" && (
        <Button variant="primary" size={size} icon={Play} onClick={f.resume}>
          Resume
        </Button>
      )}
      {f.phase !== "idle" && <IconButton icon={Square} label="Stop" size={size} onClick={f.stop} />}
      {f.phase === "idle" && <IconButton icon={RotateCcw} label="Reset" size={size} onClick={f.reset} />}
      <IconButton icon={SkipForward} label={f.kind === "focus" ? "Skip to break" : "Skip break"} size={size} onClick={f.skip} />
    </div>
  );
}

export function FocusWidgetBody() {
  const { f, remaining, progress } = useFocusClock();
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <div className="focus-mini">
      <div className="row" style={{ gap: 10 }}>
        <svg width="34" height="34" viewBox="0 0 34 34" className="ring" aria-hidden>
          <circle className="ring__track" cx="17" cy="17" r={r} fill="none" strokeWidth="3" />
          <circle className="ring__bar" cx="17" cy="17" r={r} fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - progress)} />
        </svg>
        <div className="col">
          <span className="focus-mini__time">{formatClock(remaining)}</span>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {KIND_LABEL[f.kind]}
            {f.phase === "paused" ? " · paused" : ""}
            {f.cycle > 0 ? ` · ${f.cycle} done` : ""}
          </span>
        </div>
      </div>
      {f.kind === "focus" && <TaskSelector compact />}
      <TransportControls size="sm" />
    </div>
  );
}
