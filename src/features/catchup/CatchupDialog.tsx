// Project catch-up. The local digest is deterministic and needs no AI; the
// optional AI summary is built from the same numbered sources, shown first
// as a preview (what's included, roughly how big), and every line keeps
// links to the task, note, milestone, commit or pull request behind it.

import { Ban, Bot, Check, ExternalLink, FilePlus2, Loader2, NotebookText, Sparkles } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CatchupAi, CatchupDigest, CatchupInclude, CatchupLine, CatchupSource } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { useUi } from "@/stores/ui";
import { navigate } from "@/stores/router";
import { toast, toastError } from "@/stores/toast";
import { useProject } from "@/hooks/data";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Segmented, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { DatePicker } from "@/components/ui/DatePicker";
import { openTask } from "@/features/tasks/menu";
import { openLink } from "@/features/links/links";
import { addDaysStr, dayStartMs, formatDuration, todayStr } from "@/lib/dates";
import { useCapabilities } from "@/features/dev/hooks";

type Range = "today" | "yesterday" | "7d" | "30d" | "last" | "custom";

const SECTIONS: { key: "whatChanged" | "completed" | "needsAttention" | "nextSteps"; title: string }[] = [
  { key: "whatChanged", title: "What changed" },
  { key: "completed", title: "Completed" },
  { key: "needsAttention", title: "Needs attention" },
  { key: "nextSteps", title: "What to do next" },
];

function bounds(r: Range, prev: number | null, custom: [string, string]): [number, number] {
  const today = todayStr();
  const end = Date.now();
  switch (r) {
    case "today":
      return [dayStartMs(today), end];
    case "yesterday":
      return [dayStartMs(addDaysStr(today, -1)), end];
    case "7d":
      return [dayStartMs(addDaysStr(today, -7)), end];
    case "30d":
      return [dayStartMs(addDaysStr(today, -30)), end];
    case "last":
      return [prev ?? dayStartMs(addDaysStr(today, -7)), end];
    case "custom":
      return [dayStartMs(custom[0]), dayStartMs(addDaysStr(custom[1], 1))];
  }
}

export function openSource(s: CatchupSource) {
  switch (s.kind) {
    case "task":
      openTask(s.refId);
      break;
    case "note":
      navigate({ name: "notes", id: s.refId });
      break;
    case "milestone":
      useUi.getState().openInspector({ kind: "milestone", id: s.refId });
      break;
    default:
      if (s.url) void openLink(s.url);
  }
}

function toMarkdown(title: string, view: Pick<CatchupDigest, "whatChanged" | "completed" | "needsAttention" | "nextSteps">, sources: CatchupSource[], ai: boolean) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  let md = `# ${title}\n\n`;
  for (const sec of SECTIONS) {
    const lines = view[sec.key];
    if (!lines.length) continue;
    md += `## ${sec.title}${ai && sec.key === "nextSteps" ? " (suggestions)" : ""}\n\n`;
    for (const l of lines) {
      const refs = l.sources.map((id) => byId.get(id)).filter(Boolean) as CatchupSource[];
      md += `- ${l.text}${refs.length ? ` — ${refs.map((r) => (r.url ? `[${r.title}](${r.url})` : r.title)).join(", ")}` : ""}\n`;
    }
    md += "\n";
  }
  if (ai) md += "_Summarised with AI from Kern's project activity._\n";
  return md;
}

export default function CatchupHost() {
  const projectId = useUi((s) => s.catchupProjectId);
  if (!projectId) return null;
  return <CatchupDialog projectId={projectId} onClose={() => useUi.getState().set({ catchupProjectId: null })} />;
}

function CatchupDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { data: project } = useProject(projectId);
  const { data: caps } = useCapabilities(projectId);
  const [range, setRange] = useState<Range>(project?.prevOpenedAt ? "last" : "7d");
  const [custom, setCustom] = useState<[string, string]>([addDaysStr(todayStr(), -7), todayStr()]);
  const dev = !!caps && caps.repositories > 0;
  const [include, setInclude] = useState<CatchupInclude>({ tasks: true, notes: true, milestones: true, sessions: true, commits: true, github: true });
  const effective = useMemo(() => ({ ...include, commits: include.commits && dev, github: include.github && dev }), [include, dev]);
  const [from, to] = bounds(range, project?.prevOpenedAt ?? null, custom);
  // Round "now" to the minute so the query key is stable while the dialog is open.
  const toKey = Math.ceil(to / 60_000) * 60_000;
  const { data: digest, isFetching, error } = useQuery({
    queryKey: ["catchup", projectId, from, toKey, effective],
    queryFn: () => api.catchup.local(projectId, from, toKey, effective),
    staleTime: 60_000,
  });
  const [mode, setMode] = useState<"local" | "ai">("local");
  const [stage, setStage] = useState<"idle" | "preview" | "running">("idle");
  const [ai, setAi] = useState<CatchupAi | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const reqId = useRef<string | null>(null);
  const { data: preview } = useQuery({
    queryKey: ["catchup", "preview", projectId, from, toKey, effective],
    queryFn: () => api.catchup.preview(projectId, from, toKey, effective),
    enabled: stage === "preview",
  });

  const runAi = async () => {
    const id = crypto.randomUUID();
    reqId.current = id;
    setStage("running");
    try {
      const r = await api.catchup.ai(projectId, from, toKey, effective, id);
      if (reqId.current !== id) return;
      setAi(r);
      setMode("ai");
      setSavedNote(null);
    } catch (e) {
      if (reqId.current === id) toastError(describeError(e, "The AI summary failed."));
    } finally {
      if (reqId.current === id) setStage("idle");
    }
  };
  const cancelAi = () => {
    if (reqId.current) void api.ai.cancel(reqId.current);
    reqId.current = null;
    setStage("idle");
  };

  const view = mode === "ai" && ai ? ai : digest;
  const sources = view?.sources ?? [];
  const periodLabel = { today: "today", yesterday: "since yesterday", "7d": "in the last 7 days", "30d": "in the last 30 days", last: "since you last opened it", custom: `from ${custom[0]} to ${custom[1]}` }[range];

  const save = async () => {
    if (!view || !project) return;
    try {
      const title = `Catch-up: ${project.name} (${new Date().toLocaleDateString()})`;
      const n = await api.notes.create({ title, content: toMarkdown(title, view, sources, mode === "ai"), projectId });
      invalidate("notes");
      setSavedNote(n.id);
      toast("Saved as a note");
    } catch (e) {
      toastError(describeError(e, "Couldn't save the note."));
    }
  };

  const toggle = (k: keyof CatchupInclude) => setInclude((i) => ({ ...i, [k]: !i[k] }));
  const cats: [keyof CatchupInclude, string, boolean][] = [
    ["tasks", "Tasks", true],
    ["notes", "Notes", true],
    ["milestones", "Milestones", true],
    ["sessions", "Sessions", true],
    ["commits", "Commits", dev],
    ["github", "GitHub", dev],
  ];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && (cancelAi(), onClose())}
      title={`Catch up${project ? ` on ${project.name}` : ""}`}
      wide
      className="catchup-dialog"
      footer={
        <>
          {savedNote ? (
            <Button variant="ghost" icon={NotebookText} onClick={() => (navigate({ name: "notes", id: savedNote }), onClose())}>
              Open note
            </Button>
          ) : (
            <Button variant="ghost" icon={FilePlus2} disabled={!view} onClick={() => void save()}>
              Save as note
            </Button>
          )}
          <span className="spacer" />
          {stage === "running" ? (
            <Button icon={Ban} onClick={cancelAi}>
              Cancel
            </Button>
          ) : (
            <Button variant={stage === "preview" ? "primary" : "default"} icon={Sparkles} disabled={stage === "preview" && !preview?.allowed} onClick={() => (stage === "preview" ? void runAi() : setStage("preview"))}>
              {stage === "preview" ? "Send to AI" : ai ? "Summarise again" : "Summarise with AI"}
            </Button>
          )}
        </>
      }
    >
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Segmented
          size="sm"
          value={range}
          onChange={(r) => (setRange(r), setStage("idle"))}
          ariaLabel="Period"
          options={[
            { value: "today", label: "Today" },
            { value: "yesterday", label: "Since yesterday" },
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
            ...(project?.prevOpenedAt ? [{ value: "last" as Range, label: "Since last opened" }] : []),
            { value: "custom", label: "Custom" },
          ]}
        />
        {ai && (
          <Segmented
            size="sm"
            value={mode}
            onChange={setMode}
            ariaLabel="Summary"
            options={[
              { value: "local", label: "Activity" },
              { value: "ai", label: "AI summary" },
            ]}
          />
        )}
      </div>
      {range === "custom" && (
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="col" style={{ gap: 4 }}>
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>From</span>
            <DatePicker value={custom[0]} withTime={false} onChange={(d) => d && setCustom([d, custom[1]])} />
          </div>
          <div className="col" style={{ gap: 4 }}>
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>To</span>
            <DatePicker value={custom[1]} withTime={false} onChange={(d) => d && setCustom([custom[0], d])} />
          </div>
        </div>
      )}
      <div className="row catchup-include" role="group" aria-label="Include">
        {cats
          .filter(([, , show]) => show)
          .map(([k, label]) => (
            <button key={k} type="button" className="chip chip-btn" data-on={include[k] || undefined} aria-pressed={include[k]} onClick={() => (toggle(k), setStage("idle"))}>
              {include[k] && <Check size={11} />} {label}
            </button>
          ))}
      </div>

      {stage === "preview" && (
        <div className="catchup-preview">
          <Bot size={15} />
          <div className="col grow" style={{ gap: 4 }}>
            {!preview ? (
              <Skeleton height={30} />
            ) : preview.allowed ? (
              <>
                <span>
                  Sends {preview.sources} item{preview.sources === 1 ? "" : "s"} ({preview.categories.map(([c, n]) => `${n} ${c}`).join(", ")}) — about {preview.approxTokens.toLocaleString()} tokens — to your AI provider using your routing settings.
                </span>
                <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                  Titles, short descriptions and dates only. No file contents; key-like strings are redacted.
                </span>
              </>
            ) : (
              <span>{preview.blockedReason}</span>
            )}
          </div>
        </div>
      )}
      {stage === "running" && (
        <div className="catchup-preview">
          <Loader2 size={15} className="spin" /> <span>Summarising…</span>
        </div>
      )}

      {error ? (
        <span className="faint">{describeError(error, "Couldn't build the catch-up.")}</span>
      ) : !view ? (
        <Skeleton height={140} />
      ) : (
        <div className="catchup-body" data-loading={isFetching || undefined}>
          {mode === "ai" && ai && (
            <div className="faint catchup-meta">
              AI summary{ai.model ? ` · ${ai.model}` : ""}
              {ai.inputTokens != null ? ` · ${(ai.inputTokens + (ai.outputTokens ?? 0)).toLocaleString()} tokens` : ""}
              {ai.estimatedCost != null ? ` · ~$${ai.estimatedCost.toFixed(4)}` : ""}
              {ai.dropped > 0 ? ` · ${ai.dropped} uncited claim${ai.dropped === 1 ? "" : "s"} removed` : ""}
            </div>
          )}
          {SECTIONS.every((s) => !view[s.key].length) ? (
            <span className="faint">Nothing happened {periodLabel}.</span>
          ) : (
            SECTIONS.map(
              (sec) =>
                view[sec.key].length > 0 && (
                  <section key={sec.key} className="catchup-section">
                    <div className="section-title">
                      {sec.title}
                      {mode === "ai" && sec.key === "nextSteps" && <span className="chip">Suggestions</span>}
                    </div>
                    {view[sec.key].map((l, i) => (
                      <CatchupRow key={i} line={l} sources={sources} />
                    ))}
                  </section>
                ),
            )
          )}
          {mode === "local" && digest && digest.counts.sessionMs ? (
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
              {formatDuration(digest.counts.sessionMs / 1000)} tracked {periodLabel}.
            </span>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}

function CatchupRow({ line, sources }: { line: CatchupLine; sources: CatchupSource[] }) {
  const refs = line.sources.map((id) => sources.find((s) => s.id === id)).filter(Boolean) as CatchupSource[];
  return (
    <div className="catchup-line">
      <span className="grow">{line.text}</span>
      <span className="catchup-refs">
        {refs.slice(0, 6).map((s) => (
          <Tooltip key={s.id} content={`${s.title}${s.detail ? ` — ${s.detail}` : ""}`}>
            <button type="button" className="catchup-ref" onClick={() => openSource(s)} aria-label={`Open ${s.kind}: ${s.title}`}>
              {s.url && !["task", "note", "milestone"].includes(s.kind) ? <ExternalLink size={10} /> : null}
              {s.kind}
            </button>
          </Tooltip>
        ))}
      </span>
    </div>
  );
}
