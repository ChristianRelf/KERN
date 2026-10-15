/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// One dialog for every AI action. It first shows exactly what would be sent
// (the instructions and the content, with its size) and why it can't be
// sent when it can't; nothing leaves the computer until "Send" is pressed.
// Suggestions come back ticked and are only applied on request.

import { Ban, Bot, ChevronDown, ChevronRight, Loader2, Send, Settings2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AssistResult } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { navigate } from "@/stores/router";
import { toastError } from "@/stores/toast";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Checkbox, Skeleton } from "@/components/ui/Controls";
import { formatDue, formatDuration } from "@/lib/dates";
import { openTask } from "@/features/tasks/menu";
import { useUi } from "@/stores/ui";
import { closeAssist, useAssist } from "./open";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function openSource(kind: string, refId: string) {
  if (kind.includes("task")) openTask(refId);
  else if (kind === "note") navigate({ name: "notes", id: refId });
  else if (kind === "milestone") useUi.getState().openInspector({ kind: "milestone", id: refId });
}

/** Answer text with [S3] citations turned into links to their sources. */
function Cited({ text, result }: { text: string; result: AssistResult }) {
  const byId = new Map(result.sources.map((s) => [s.id, s]));
  const parts = text.split(/(\[S\d+\])/g);
  return (
    <p style={{ whiteSpace: "pre-wrap", margin: 0, lineHeight: 1.6 }} className="selectable">
      {parts.map((p, i) => {
        const m = /^\[(S\d+)\]$/.exec(p);
        const s = m ? byId.get(m[1]) : undefined;
        return s ? (
          <button key={i} type="button" className="chip chip--outline" style={{ height: 20, margin: "0 2px", fontSize: "var(--fs-2xs)" }} title={`${s.kind}: ${s.title}`} onClick={() => openSource(s.kind, s.refId)}>
            {s.title.length > 28 ? `${s.title.slice(0, 27)}…` : s.title}
          </button>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </p>
  );
}

export default function AssistHost() {
  const req = useAssist((s) => s.req);
  const [question, setQuestion] = useState(req?.input.question ?? "");
  const [showSent, setShowSent] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AssistResult | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);
  const requestId = useRef<string | null>(null);
  const isAsk = req?.input.action === "ask";
  const q = useDebounced(question, 400);
  const input = req ? { ...req.input, ...(isAsk ? { question: q } : {}) } : null;
  const preview = useQuery({
    queryKey: ["assist", "preview", input],
    queryFn: () => api.assist.preview(input!),
    enabled: !!input && (!isAsk || q.trim().length > 0),
    retry: false,
  });

  if (!req) return null;
  const close = () => {
    if (requestId.current) void api.ai.cancel(requestId.current).catch(() => undefined);
    closeAssist();
  };

  const run = async () => {
    if (!input) return;
    setRunning(true);
    setResult(null);
    const id = crypto.randomUUID();
    requestId.current = id;
    try {
      const r = await api.assist.run({ ...input, question: isAsk ? question : input.question }, id);
      if (requestId.current !== id) return;
      setResult(r);
      setPicked(new Set(r.suggestions.map((_, i) => i)));
    } catch (e) {
      if (requestId.current === id) toastError(describeError(e, "The AI request failed."));
    } finally {
      if (requestId.current === id) {
        requestId.current = null;
        setRunning(false);
      }
    }
  };

  const apply = async () => {
    if (!result || !req.onApply) return;
    setApplying(true);
    try {
      await req.onApply(result.suggestions.filter((_, i) => picked.has(i)));
      closeAssist();
    } catch (e) {
      toastError(describeError(e));
    } finally {
      setApplying(false);
    }
  };

  const p = preview.data;
  const blocked = p && !p.allowed;
  const suggestions = result?.suggestions ?? [];
  const footer = result ? (
    <>
      <span className="faint grow" style={{ fontSize: "var(--fs-xs)" }}>
        {[result.accountName, result.model, result.inputTokens !== null && result.outputTokens !== null ? `${(result.inputTokens ?? 0) + (result.outputTokens ?? 0)} tokens` : null, result.estimatedCost !== null ? `~$${result.estimatedCost.toFixed(4)}` : null].filter(Boolean).join(" · ")}
      </span>
      <Button variant="ghost" onClick={() => void run()} disabled={running}>
        Try again
      </Button>
      {req.onApply && suggestions.length > 0 && (
        <Button variant="primary" disabled={!picked.size || applying} onClick={() => void apply()}>
          {req.applyLabel ?? "Add"} {picked.size > 0 ? picked.size : ""}
        </Button>
      )}
      {req.onText && result.text && (
        <Button
          variant="primary"
          onClick={() => {
            req.onText!(result.text!);
            closeAssist();
          }}
        >
          {req.textActionLabel ?? "Use this"}
        </Button>
      )}
      {!req.onApply && !req.onText && (
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      )}
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={close}>
        Cancel
      </Button>
      <Button variant="primary" icon={running ? Loader2 : Send} disabled={!p?.allowed || running || (isAsk && !question.trim())} onClick={() => void run()}>
        {running ? "Asking…" : isAsk ? "Ask" : "Send to AI"}
      </Button>
    </>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={<span className="row" style={{ gap: 8 }}><Sparkles size={16} /> {req.title}</span>} wide footer={footer}>
      <div className="col" style={{ gap: 12 }}>
        {req.intro && !result && <p className="muted" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>{req.intro}</p>}
        {isAsk && !result && (
          <textarea
            className="textarea"
            autoFocus
            rows={2}
            placeholder="e.g. What's blocking the next milestone? What did we finish last week? What should I do first?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && p?.allowed) {
                e.preventDefault();
                void run();
              }
            }}
          />
        )}
        {!result && (
          <div className="panel" style={{ gap: 8 }}>
            {preview.isLoading && (!isAsk || q.trim()) && <Skeleton height={36} />}
            {preview.isError && <span className="faint">{describeError(preview.error, "Couldn't prepare the request.")}</span>}
            {blocked && (
              <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                <Ban size={16} className="faint" style={{ marginTop: 2 }} />
                <div className="col grow" style={{ gap: 6 }}>
                  <span style={{ fontSize: "var(--fs-sm)" }}>{p.blockedReason}</span>
                  <div className="row" style={{ gap: 6 }}>
                    <Button size="sm" icon={Settings2} onClick={() => (close(), navigate({ name: "settings", section: "privacy" }))}>
                      Privacy settings
                    </Button>
                    <Button size="sm" variant="ghost" icon={Bot} onClick={() => (close(), navigate({ name: "api", tab: "accounts" }))}>
                      AI accounts
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {p && (
              <>
                <button type="button" className="row" style={{ gap: 6, fontSize: "var(--fs-sm)" }} onClick={() => setShowSent(!showSent)} aria-expanded={showSent}>
                  {showSent ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  What will be sent
                  <span className="faint">· {p.chars.toLocaleString()} characters, about {p.approxTokens.toLocaleString()} tokens</span>
                </button>
                {showSent && (
                  <pre className="selectable" style={{ maxHeight: 260, overflow: "auto", fontSize: "var(--fs-2xs)", whiteSpace: "pre-wrap", margin: 0, padding: 10, background: "var(--bg-sunken)", borderRadius: "var(--r-sm)" }}>
                    {`Instructions:\n${p.system}\n\n${p.prompt}`}
                  </pre>
                )}
                {!showSent && p.allowed && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Key-like strings are removed. Nothing is sent until you press {isAsk ? "Ask" : "Send"}.</span>}
              </>
            )}
          </div>
        )}
        {running && (
          <div className="row" style={{ gap: 8 }}>
            <Loader2 size={16} className="spin" /> <span className="muted">Waiting for the AI…</span>
          </div>
        )}
        {result && suggestions.length > 0 && (
          <div className="col" style={{ gap: 2 }}>
            {suggestions.map((s, i) => (
              <label key={i} className="row" style={{ gap: 10, padding: "6px 4px", alignItems: "flex-start", borderRadius: "var(--r-sm)" }}>
                <Checkbox
                  checked={picked.has(i)}
                  label={s.title}
                  onChange={(v) => {
                    const next = new Set(picked);
                    if (v) next.add(i);
                    else next.delete(i);
                    setPicked(next);
                  }}
                />
                <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
                  <span>{s.title}</span>
                  {(s.detail || s.dueDate || s.estimateMinutes) && (
                    <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                      {[s.dueDate ? `Due ${formatDue(s.dueDate)}` : null, s.estimateMinutes ? formatDuration(s.estimateMinutes * 60) : null, s.detail ? `“${s.detail}”` : null].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
        {result && !suggestions.length && !result.text && <p className="muted" style={{ margin: 0 }}>The AI didn't find anything to suggest.</p>}
        {result?.text && <Cited text={result.text} result={result} />}
        {result && result.dropped > 0 && (
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {result.dropped} item{result.dropped === 1 ? " was" : "s were"} left out because {result.dropped === 1 ? "it" : "they"} didn't match what was sent.
          </span>
        )}
      </div>
    </Dialog>
  );
}
