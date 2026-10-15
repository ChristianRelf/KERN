/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Dialog as D } from "radix-ui";
import { CalendarDays, FolderKanban, Lightbulb, NotebookPen, SquareCheckBig } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useUi, type CaptureMode } from "@/stores/ui";
import { Segmented } from "@/components/ui/Controls";
import { Kbd } from "@/components/ui/Button";
import { useProjects } from "@/hooks/data";
import { parseQuickTask } from "@/features/tasks/parse";
import { ParsedTokens } from "@/features/tasks/QuickAdd";
import { buildTaskInput, contextDefaults } from "@/features/tasks/creation";
import { createTask } from "@/features/tasks/actions";
import { ProjectPicker, DuePopover } from "@/features/tasks/pickers";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { navigate } from "@/stores/router";
import { formatDue } from "@/lib/dates";

const MODES: { value: CaptureMode; label: string; icon: typeof Lightbulb }[] = [
  { value: "task", label: "Task", icon: SquareCheckBig },
  { value: "note", label: "Note", icon: NotebookPen },
  { value: "idea", label: "Idea", icon: Lightbulb },
];

export function QuickCapture() {
  const capture = useUi((s) => s.capture);
  const close = useUi((s) => s.closeCapture);
  return (
    <D.Root open={capture.open} onOpenChange={(o) => !o && close()}>
      <D.Portal>
        <D.Overlay className="dialog-overlay" />
        <D.Content className="capture" aria-describedby={undefined}>
          <D.Title className="sr-only">Quick capture</D.Title>
          {capture.open && <CaptureBody key={String(capture.open)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function CaptureBody() {
  const capture = useUi.getState().capture;
  const close = useUi((s) => s.closeCapture);
  const [mode, setMode] = useState<CaptureMode>(capture.mode);
  const [text, setText] = useState(capture.text ?? "");
  const [projectId, setProjectId] = useState<string | null>(capture.projectId ?? null);
  const [dueDate, setDueDate] = useState<string | null>(capture.dueDate ?? null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId);
  const parsed = useMemo(() => parseQuickTask(text, { projects: projects ?? [] }), [text, projects]);

  useEffect(() => {
    ref.current?.focus();
  }, [mode]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [text, mode]);

  const save = async (keepOpen: boolean) => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      if (mode === "task") {
        const input = await buildTaskInput(value, projects ?? [], contextDefaults({ projectId, dueDate }));
        const t = await createTask(input, { quiet: true });
        if (t) toast(t.status === "inbox" ? "Added to Inbox" : t.dueDate ? `Added for ${formatDue(t.dueDate)}` : "Task added");
      } else if (mode === "note") {
        const [first, ...rest] = value.split("\n");
        const n = await api.notes.create({ title: first.slice(0, 200), content: rest.join("\n").trim(), projectId });
        invalidate("notes");
        toast("Note saved", { action: { label: "Open", run: () => navigate({ name: "notes", id: n.id }) } });
      } else {
        await api.inbox.add(value);
        invalidate("inbox", "stats");
        toast("Captured to Inbox");
      }
      setText("");
      if (!keepOpen) close();
    } catch (e) {
      toastError(describeError(e, "Couldn't save that."), () => void save(keepOpen));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="capture__body"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && ["1", "2", "3"].includes(e.key)) {
          e.preventDefault();
          setMode(MODES[Number(e.key) - 1].value);
        }
      }}
    >
      <textarea
        ref={ref}
        className="capture__input"
        rows={1}
        value={text}
        placeholder={mode === "task" ? "What needs doing? Try “Call Sam tomorrow 3pm p2”" : mode === "note" ? "Title on the first line, then your note" : "Capture an idea or a link"}
        aria-label="Capture"
        onChange={(e) => setText(mode === "task" ? e.target.value.replace(/\n/g, " ") : e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const mod = e.ctrlKey || e.metaKey;
          // Shift+Enter inserts a line break in notes and ideas.
          if (mode !== "task" && e.shiftKey && !mod) return;
          e.preventDefault();
          void save(mod);
        }}
      />
      {mode === "task" && <ParsedTokens parsed={parsed} />}
      <div className="capture__foot">
        <Segmented size="sm" value={mode} onChange={setMode} options={MODES.map((m) => ({ value: m.value, label: m.label, icon: m.icon }))} ariaLabel="Capture type" />
        {mode !== "idea" && (
          <ProjectPicker
            value={projectId}
            onChange={setProjectId}
            trigger={
              <button type="button" className="chip chip-btn chip--outline">
                {project ? <ProjectGlyph project={project} size={12} /> : <FolderKanban />}
                {project?.name ?? "Project"}
              </button>
            }
          />
        )}
        {mode === "task" && !parsed.dueDate && (
          <DuePopover
            date={dueDate}
            withTime={false}
            onChange={(d) => setDueDate(d)}
            trigger={
              <button type="button" className="chip chip-btn chip--outline">
                <CalendarDays />
                {dueDate ? formatDue(dueDate) : "Date"}
              </button>
            }
          />
        )}
        <span className="spacer" />
        <span className="capture__hint">
          <Kbd combo="Enter" /> save
          <Kbd combo="Mod+Enter" /> save & add another
        </span>
      </div>
    </div>
  );
}
