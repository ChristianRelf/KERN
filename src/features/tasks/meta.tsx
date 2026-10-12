import type { TaskStatus } from "@/lib/types";

export const PRIORITY_LABELS = ["No priority", "Low", "Medium", "High", "Urgent"] as const;
export const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: "Inbox",
  todo: "To Do",
  in_progress: "In Progress",
  blocked: "Blocked",
  completed: "Completed",
};
export const STATUS_ORDER: TaskStatus[] = ["inbox", "todo", "in_progress", "blocked", "completed"];

/** Greyscale signal bars; urgent is a filled exclamation tile. */
export function PriorityIcon({ priority, size = 14 }: { priority: number; size?: number }) {
  if (priority >= 4)
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-label="Urgent" role="img">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="var(--text)" />
        <rect x="7.1" y="4" width="1.8" height="5.2" rx="0.9" fill="var(--bg)" />
        <circle cx="8" cy="11.4" r="1.05" fill="var(--bg)" />
      </svg>
    );
  const bars = [
    { x: 2, h: 5 },
    { x: 6.5, h: 8 },
    { x: 11, h: 11 },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={PRIORITY_LABELS[priority]} role="img">
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={13.5 - b.h}
          width="3"
          height={b.h}
          rx="1"
          fill={i < priority ? "var(--text-2)" : "var(--border-strong)"}
        />
      ))}
    </svg>
  );
}

export function StatusIcon({ status, size = 14 }: { status: TaskStatus; size?: number }) {
  const s = { width: size, height: size };
  switch (status) {
    case "inbox":
      return (
        <svg {...s} viewBox="0 0 16 16" aria-label="Inbox" role="img">
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--text-3)" strokeWidth="1.5" strokeDasharray="2.2 2" />
        </svg>
      );
    case "todo":
      return (
        <svg {...s} viewBox="0 0 16 16" aria-label="To do" role="img">
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--text-2)" strokeWidth="1.5" />
        </svg>
      );
    case "in_progress":
      return (
        <svg {...s} viewBox="0 0 16 16" aria-label="In progress" role="img">
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--text-2)" strokeWidth="1.5" />
          <path d="M8 4.2 A3.8 3.8 0 0 1 8 11.8 Z" fill="var(--text-2)" />
        </svg>
      );
    case "blocked":
      return (
        <svg {...s} viewBox="0 0 16 16" aria-label="Blocked" role="img">
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--text-2)" strokeWidth="1.5" />
          <path d="M4 12 L12 4" stroke="var(--text-2)" strokeWidth="1.5" />
        </svg>
      );
    case "completed":
      return (
        <svg {...s} viewBox="0 0 16 16" aria-label="Completed" role="img">
          <circle cx="8" cy="8" r="6.75" fill="var(--accent)" />
          <path d="M5.2 8.2 L7.1 10 L10.9 6.1" fill="none" stroke="var(--accent-fg)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}
