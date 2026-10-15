/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// One stream's settings. Edits collect in a draft and are saved together
// (the save bar appears once something changed); pausing, secrets, tokens
// and the delivery log act immediately.

import { useEffect, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Eye, FlaskConical, KeyRound, Plus, RefreshCw, ShieldCheck, Trash, X } from "lucide-react";
import { api } from "@/lib/ipc";
import type { Stream, StreamConfig, StreamField, StreamFieldType, StreamPreview } from "@/lib/types";
import { navigate, type StreamTab } from "@/stores/router";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox, Segmented, Select, Switch } from "@/components/ui/Controls";
import { confirm, prompt } from "@/components/ui/Dialog";
import { errorText } from "@/features/cloud/store";
import { timeAgo } from "@/features/cloud/ui";
import { GithubMark } from "@/features/github/shared";
import { PRIORITY_LABELS, STATUS_LABELS } from "@/features/tasks/meta";
import { ACTION_TEXT, AUTH_TEXT, refreshStreams, STATUS_TEXT, streamsApi, useStreamDetail } from "./api";
import { Deliveries } from "./Deliveries";
import { samplePayload, snippet, snippetKinds, SNIPPET_LABEL, type SnippetKind } from "./snippets";
import { CopyField } from "./StreamsPage";
import { LabelDot } from "@/features/tasks/labels";

const TABS: { id: StreamTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "destination", label: "Destination" },
  { id: "fields", label: "Fields" },
  { id: "security", label: "Security" },
  { id: "github", label: "GitHub" },
  { id: "responses", label: "Responses" },
  { id: "deliveries", label: "Deliveries" },
];

interface Draft {
  name: string;
  description: string;
  config: StreamConfig;
}

const draftOf = (s: Stream): Draft => ({ name: s.name, description: s.description, config: structuredClone(s.config) });

type SetCfg = <K extends keyof StreamConfig>(key: K, patch: StreamConfig[K] extends object ? Partial<StreamConfig[K]> : StreamConfig[K]) => void;

export function StreamEditor({ space, stream, tab, onSecret }: { space: string; stream: Stream; tab: StreamTab; onSecret: (s: Stream, secret: string) => void }) {
  const [draft, setDraft] = useState(() => draftOf(stream));
  const [busy, setBusy] = useState(false);
  // When the stream changes on the server, take its version - unless there
  // are unsaved edits, which are kept. Immediate actions (pausing, blocking a
  // sender, credentials) only change the blocked senders inside the config.
  const [base, setBase] = useState(stream);
  if (base.updatedAt !== stream.updatedAt) {
    const edited = JSON.stringify(draft) !== JSON.stringify(draftOf(base));
    setBase(stream);
    setDraft(edited ? { ...draft, config: { ...draft.config, security: { ...draft.config.security, blockedSenders: stream.config.security.blockedSenders } } } : draftOf(stream));
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(stream));

  const setCfg: SetCfg = (key, patch) =>
    setDraft((d) => ({ ...d, config: { ...d.config, [key]: typeof patch === "object" && patch !== null && !Array.isArray(patch) ? { ...(d.config[key] as object), ...patch } : patch } }));

  const save = async () => {
    if (!draft.name.trim()) return toastError("Give the stream a name.");
    setBusy(true);
    try {
      await streamsApi.update(space, stream.id, { name: draft.name.trim(), description: draft.description.trim(), config: draft.config });
      await refreshStreams(space);
      toast("Stream saved");
    } catch (e) {
      toastError(errorText(e, "Couldn't save the stream."));
    } finally {
      setBusy(false);
    }
  };

  const preview: Stream = { ...stream, name: draft.name, config: draft.config };
  const props = { space, stream, draft, setDraft, setCfg, dirty, preview, onSecret };

  return (
    <div className="settings__inner streams__editor">
      <div className="streams__title">
        <span className="streams__dot" data-state={stream.enabled ? "ok" : "paused"} />
        <h2 className="settings__heading truncate" style={{ margin: 0 }}>
          {draft.name || "Untitled stream"}
        </h2>
        <span className="chip chip--outline">{ACTION_TEXT[draft.config.action]}</span>
        <span className="chip chip--outline">{AUTH_TEXT[draft.config.security.auth]}</span>
        {!stream.enabled && <span className="chip">Paused</span>}
      </div>
      <nav className="streams__tabs" aria-label="Stream sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" className="streams__tab" data-active={t.id === tab || undefined} onClick={() => navigate({ name: "streams", id: stream.id, tab: t.id }, { replace: true })}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "overview" && <Overview {...props} />}
      {tab === "destination" && <Destination {...props} />}
      {tab === "fields" && <Fields {...props} />}
      {tab === "security" && <Security {...props} />}
      {tab === "github" && <Github {...props} />}
      {tab === "responses" && <Responses {...props} />}
      {tab === "deliveries" && <Deliveries space={space} stream={stream} />}
      {dirty && (
        <div className="streams__savebar" role="region" aria-label="Unsaved changes">
          <span>Unsaved changes</span>
          <span className="spacer" />
          <Button variant="ghost" disabled={busy} onClick={() => setDraft(draftOf(stream))}>
            Discard
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      )}
    </div>
  );
}

interface SectionProps {
  space: string;
  stream: Stream;
  draft: Draft;
  setDraft: (fn: (d: Draft) => Draft) => void;
  setCfg: SetCfg;
  dirty: boolean;
  /** The stream as it would be with the draft saved. */
  preview: Stream;
  onSecret: (s: Stream, secret: string) => void;
}

// ------------------------------------------------------------ building blocks

function Group({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="set-group__title">
        {title}
        {hint && <span className="faint streams__group-hint"> · {hint}</span>}
      </div>
      <div className="set-group">{children}</div>
    </div>
  );
}

function Row({ label, hint, children, block }: { label: string; hint?: ReactNode; children?: ReactNode; block?: ReactNode }) {
  return (
    <div className="set-row" style={block ? { flexWrap: "wrap" } : undefined}>
      <div className="set-row__text">
        <span className="set-row__label">{label}</span>
        {hint && <span className="set-row__hint">{hint}</span>}
      </div>
      {children && <div className="set-row__control">{children}</div>}
      {block && <div className="streams__block">{block}</div>}
    </div>
  );
}

function NumInput({ value, onChange, min, max, suffix, width = 80, label }: { value: number; onChange: (n: number) => void; min: number; max: number; suffix?: string; width?: number; label: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <span className="row" style={{ gap: 6 }}>
      <input className="input" style={{ width }} inputMode="numeric" aria-label={label} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      {suffix && <span className="faint">{suffix}</span>}
    </span>
  );
}

/** A list edited as text: one entry per line (or comma-separated with `inline`). */
function ListInput({ value, onChange, placeholder, inline, label, rows = 3 }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; inline?: boolean; label: string; rows?: number }) {
  const join = (v: string[]) => v.join(inline ? ", " : "\n");
  const parse = (t: string) =>
    t
      .split(inline ? /[,\n]/ : /\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  const [text, setText] = useState(join(value));
  useEffect(() => {
    if (parse(text).join("\u0000") !== value.join("\u0000")) setText(join(value));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (t: string) => {
    setText(t);
    onChange(parse(t));
  };
  return inline ? (
    <input className="input" aria-label={label} placeholder={placeholder} value={text} onChange={(e) => change(e.target.value)} />
  ) : (
    <textarea className="textarea mono" aria-label={label} rows={rows} placeholder={placeholder} value={text} onChange={(e) => change(e.target.value)} />
  );
}

async function act<T>(fn: () => Promise<T>, fail: string): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    toastError(errorText(e, fail));
    return null;
  }
}

// ------------------------------------------------------------ overview

function Overview({ space, stream, draft, setDraft, dirty, preview }: SectionProps) {
  const { data: detail } = useStreamDetail(space, stream.id);
  const kinds = snippetKinds(preview.config);
  const [kind, setKind] = useState<SnippetKind>(kinds[0]);
  const shown = kinds.includes(kind) ? kind : kinds[0];
  const code = snippet(shown, preview);
  const week = detail?.stats.last7d ?? {};
  const day = detail?.stats.last24h ?? {};

  const toggle = async (enabled: boolean) => {
    const r = await act(() => streamsApi.update(space, stream.id, { enabled }), "Couldn't change the stream.");
    if (r) {
      await refreshStreams(space);
      toast(enabled ? "Stream resumed" : "Stream paused. Senders get “not accepting submissions”.");
    }
  };
  const remove = async () => {
    const typed = await prompt({ title: `Delete ${stream.name}?`, label: "Senders get “not found” straight away and the delivery log is deleted. Tasks it created stay. Type the stream's name to confirm.", confirmLabel: "Delete stream" });
    if (typed === null) return;
    if (typed.trim() !== stream.name.trim()) return toastError("The name didn't match, so nothing was deleted.");
    if (await act(() => streamsApi.remove(space, stream.id), "Couldn't delete the stream.")) {
      await refreshStreams(space);
      navigate({ name: "streams" }, { replace: true });
      toast(`${stream.name} was deleted`);
    }
  };

  return (
    <div className="col streams__section">
      <Group title="Endpoint">
        <Row label="Address" hint="Send POST requests here. The 64-character id is unguessable, but anyone who sees a public form can find it; Security has the protections." block={<CopyField value={stream.url} label="Stream address" />} />
        <Row label="Accepting submissions" hint={stream.enabled ? "Live." : "Paused: submissions are refused and nothing is logged."}>
          <Switch checked={stream.enabled} onChange={(v) => void toggle(v)} label="Accepting submissions" />
        </Row>
        <Row label="Name" block={<input className="input" maxLength={80} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />} />
        <Row label="Description" hint="For your team; senders never see it." block={<input className="input" maxLength={500} value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />} />
      </Group>

      <Group title="Activity" hint={stream.lastDeliveryAt ? `last submission ${timeAgo(stream.lastDeliveryAt)}` : "nothing received yet"}>
        <div className="streams__stats">
          {(["delivered", "partial", "failed", "rejected", "duplicate", "spam"] as const).map((s) => (
            <button key={s} type="button" className="streams__stat" data-status={s} onClick={() => navigate({ name: "streams", id: stream.id, tab: "deliveries" }, { replace: true })}>
              <span className="streams__stat-n">{week[s] ?? 0}</span>
              <span className="faint">{STATUS_TEXT[s]}</span>
              <span className="faint streams__stat-day">{day[s] ?? 0} today</span>
            </button>
          ))}
        </div>
        <Row label="All time" hint="Every submission that reached the stream, including spam and rejections.">
          <span className="mono">{stream.deliveryCount.toLocaleString()}</span>
        </Row>
      </Group>

      <Group title="Send to it" hint={dirty ? "shown with your unsaved changes" : undefined}>
        <div className="streams__snippet">
          <div className="row" style={{ gap: 8 }}>
            <Segmented<SnippetKind> size="sm" value={shown} onChange={setKind} options={kinds.map((k) => ({ value: k, label: SNIPPET_LABEL[k] }))} ariaLabel="Snippet language" />
            <span className="spacer" />
            <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(code).then(() => toast("Snippet copied"))}>
              Copy
            </Button>
          </div>
          <pre className="streams__code mono">{code}</pre>
          {preview.config.security.auth !== "public" && <span className="faint">Set KERN_STREAM_SECRET to the stream's secret (Security → Reveal). Never put it in a web page.</span>}
        </div>
      </Group>

      <TryIt space={space} stream={stream} draft={draft} dirty={dirty} />

      <Group title="Danger zone">
        <Row label="Delete stream" hint="Stops the address working and deletes its delivery log. Tasks and issues it created are kept.">
          <Button variant="danger" icon={Trash} onClick={() => void remove()}>
            Delete
          </Button>
        </Row>
      </Group>
    </div>
  );
}

function TryIt({ space, stream, draft, dirty }: { space: string; stream: Stream; draft: Draft; dirty: boolean }) {
  const [text, setText] = useState(() => JSON.stringify(samplePayload(draft.config), null, 2));
  const [result, setResult] = useState<StreamPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const parse = (): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* fall through */
    }
    toastError("The sample isn't a JSON object.");
    return null;
  };
  const run = async () => {
    const payload = parse();
    if (!payload) return;
    setBusy(true);
    const r = await act(() => streamsApi.preview(space, stream.id, payload, draft.config), "Couldn't preview it.");
    setBusy(false);
    if (r) setResult(r);
  };
  const send = async () => {
    const payload = parse();
    if (!payload) return;
    setBusy(true);
    const r = await act(() => streamsApi.test(space, stream.id, payload), "The test send didn't go through.");
    setBusy(false);
    if (!r) return;
    await refreshStreams(space);
    const target = r.taskId ? { label: "Open task", run: () => navigate({ name: "task", id: r.taskId! }) } : r.inboxId ? { label: "Open Inbox", run: () => navigate({ name: "inbox" }) } : r.issue ? { label: "Open issue", run: () => void api.system.open(r.issue!.url) } : undefined;
    if (r.status === "failed") toastError(r.message ?? "The test delivery failed.");
    else toast(r.status === "partial" ? `Partly delivered: ${r.message}` : `Test delivered: ${r.title}`, { tone: r.status === "partial" ? "error" : "success", action: target, duration: 8000 });
  };
  return (
    <Group title="Try it" hint="preview uses your unsaved settings; a test send delivers for real, marked as a test">
      <div className="streams__try">
        <textarea className="textarea mono" rows={8} aria-label="Sample submission (JSON)" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" variant="ghost" onClick={() => setText(JSON.stringify(samplePayload(draft.config), null, 2))}>
            Reset sample
          </Button>
          <span className="spacer" />
          <Button size="sm" icon={Eye} disabled={busy} onClick={() => void run()}>
            Preview
          </Button>
          <Button size="sm" icon={FlaskConical} disabled={busy || dirty} title={dirty ? "Save your changes first" : undefined} onClick={() => void send()}>
            Send test
          </Button>
        </div>
        {result && (
          <div className="streams__preview">
            {!result.valid && (
              <div className="col" style={{ gap: 2 }}>
                {Object.values(result.errors).map((m) => (
                  <span key={m} className="field-error">
                    {m}
                  </span>
                ))}
              </div>
            )}
            <strong>{result.title}</strong>
            <pre className="streams__code mono">{result.body}</pre>
            {(draft.config.action === "issue" || draft.config.action === "task_issue") && result.githubBody !== result.body && (
              <span className="faint">The GitHub issue gets the same text with @-mentions and #references neutralised.</span>
            )}
          </div>
        )}
      </div>
    </Group>
  );
}

// ------------------------------------------------------------ destination

const PLACEHOLDERS = ["_fields", "_json", "_stream.name", "_meta.receivedAt", "_meta.origin", "_meta.referer", "_meta.userAgent"];

function Destination({ draft, setCfg, setDraft }: SectionProps) {
  const cfg = draft.config;
  const wantsTask = cfg.action === "task" || cfg.action === "task_issue";
  const { data: projects } = useQuery({ queryKey: ["streams", "picker", "projects"], queryFn: () => api.projects.list() });
  const { data: labels } = useQuery({ queryKey: ["streams", "picker", "labels"], queryFn: () => api.labels.list() });
  const { data: boards } = useQuery({ queryKey: ["streams", "picker", "boards", cfg.task.projectId], queryFn: () => api.boards.list(cfg.task.projectId!), enabled: !!cfg.task.projectId });
  const boardData = useQueries({ queries: (boards ?? []).map((b) => ({ queryKey: ["streams", "picker", "board", b.id], queryFn: () => api.boards.get(b.id) })) });
  const columns = boardData.flatMap((q) => (q.data ? q.data.columns.map((c) => ({ ...c, board: q.data!.board.name })) : []));
  const column = columns.find((c) => c.id === cfg.task.columnId);
  const fieldKeys = cfg.fields.list.map((f) => f.key);
  const priorityChoices = cfg.fields.list.find((f) => f.key === cfg.task.priorityField)?.options ?? [];
  const mapRows = Object.entries(cfg.task.priorityMap);
  const insert = (p: string) => setCfg("templates", { body: `${cfg.templates.body}${cfg.templates.body.endsWith("\n") || !cfg.templates.body ? "" : "\n\n"}{{${p}}}` });

  return (
    <div className="col streams__section">
      <Group title="Each submission becomes">
        <div className="streams__pad">
          <Segmented
            value={cfg.action}
            onChange={(action) => setDraft((d) => ({ ...d, config: { ...d.config, action } }))}
            options={(["task", "inbox", "issue", "task_issue"] as const).map((a) => ({ value: a, label: ACTION_TEXT[a] }))}
            ariaLabel="What a submission becomes"
          />
          <p className="faint" style={{ margin: "8px 0 0" }}>
            {cfg.action === "task" && "A task in this space, ready to triage."}
            {cfg.action === "inbox" && "An inbox item, for ideas and feedback you'll sort later."}
            {cfg.action === "issue" && "A GitHub issue only. If the repository is connected to a project with issue sync on, Kern imports it as usual."}
            {cfg.action === "task_issue" && "A GitHub issue and a task. When the task's project is connected to the same repository, they're linked and stay in sync."}
          </p>
        </div>
      </Group>

      {wantsTask && (
        <Group title="Task">
          <Row label="Project" hint="No project puts tasks in the Inbox.">
            <Select
              value={cfg.task.projectId ?? "none"}
              onChange={(v) => setCfg("task", { projectId: v === "none" ? null : v, columnId: null })}
              options={[{ value: "none", label: "No project (Inbox)" }, ...(projects ?? []).map((p) => ({ value: p.id, label: p.name }))]}
              ariaLabel="Project"
              style={{ width: 220 }}
            />
          </Row>
          {cfg.task.projectId && (
            <Row label="Board column" hint="Tasks are added to the bottom of the column and take its status.">
              <Select
                value={cfg.task.columnId ?? "none"}
                onChange={(v) => setCfg("task", { columnId: v === "none" ? null : v })}
                options={[{ value: "none", label: "No column" }, ...columns.map((c) => ({ value: c.id, label: `${c.board} › ${c.name}` }))]}
                ariaLabel="Board column"
                style={{ width: 220 }}
              />
            </Row>
          )}
          <Row label="Status" hint={column?.status ? `The column sets “${STATUS_LABELS[column.status]}”.` : cfg.task.projectId && cfg.task.status === "inbox" ? "Tasks in a project start as To Do instead of Inbox." : undefined}>
            <Select
              value={cfg.task.status}
              onChange={(status) => setCfg("task", { status })}
              options={(["inbox", "todo", "in_progress", "blocked"] as const).map((s) => ({ value: s, label: STATUS_LABELS[s] }))}
              ariaLabel="Status"
              style={{ width: 160 }}
            />
          </Row>
          <Row label="Priority">
            <Select value={String(cfg.task.priority)} onChange={(v) => setCfg("task", { priority: Number(v) })} options={PRIORITY_LABELS.map((l, i) => ({ value: String(i), label: l }))} ariaLabel="Priority" style={{ width: 160 }} />
          </Row>
          <Row
            label="Priority from a field"
            hint="Let a submitted value such as severity choose the priority. Numbers 0–4 work without a mapping."
            block={
              cfg.task.priorityField ? (
                <div className="col" style={{ gap: 6 }}>
                  {(mapRows.length ? mapRows : []).map(([value, p], i) => (
                    <div key={i} className="row" style={{ gap: 6 }}>
                      <input
                        className="input"
                        style={{ width: 180 }}
                        aria-label="Submitted value"
                        value={value}
                        onChange={(e) => setCfg("task", { priorityMap: Object.fromEntries(mapRows.map(([k, v], j) => (j === i ? [e.target.value, v] : [k, v]))) })}
                      />
                      <span className="faint">→</span>
                      <Select value={String(p)} onChange={(v) => setCfg("task", { priorityMap: { ...cfg.task.priorityMap, [value]: Number(v) } })} options={PRIORITY_LABELS.map((l, j) => ({ value: String(j), label: l }))} ariaLabel="Priority" style={{ width: 150 }} />
                      <IconButton icon={X} label="Remove" size="sm" onClick={() => setCfg("task", { priorityMap: Object.fromEntries(mapRows.filter((_, j) => j !== i)) })} />
                    </div>
                  ))}
                  <div className="row" style={{ gap: 6 }}>
                    <Button size="sm" variant="ghost" icon={Plus} onClick={() => setCfg("task", { priorityMap: { ...cfg.task.priorityMap, [`value ${mapRows.length + 1}`]: 2 } })}>
                      Add value
                    </Button>
                    {priorityChoices.length > 0 && (
                      <Button size="sm" variant="ghost" onClick={() => setCfg("task", { priorityMap: Object.fromEntries(priorityChoices.map((o, i) => [o, Math.min(4, i + 1)])) })}>
                        Map the field's choices
                      </Button>
                    )}
                  </div>
                </div>
              ) : undefined
            }
          >
            <Select value={cfg.task.priorityField ?? "none"} onChange={(v) => setCfg("task", { priorityField: v === "none" ? null : v })} options={[{ value: "none", label: "Off" }, ...fieldKeys.map((k) => ({ value: k, label: k }))]} ariaLabel="Priority field" style={{ width: 160 }} />
          </Row>
          <Row
            label="Labels"
            block={
              <div className="streams__chips">
                {(labels ?? []).map((l) => {
                  const on = cfg.task.labelIds.includes(l.id);
                  return (
                    <button key={l.id} type="button" className="chip chip-btn" data-active={on || undefined} aria-pressed={on} onClick={() => setCfg("task", { labelIds: on ? cfg.task.labelIds.filter((x) => x !== l.id) : [...cfg.task.labelIds, l.id] })}>
                      {l.color && <LabelDot label={l} size={6} />}
                      {l.name}
                    </button>
                  );
                })}
                {!labels?.length && <span className="faint">This space has no labels yet.</span>}
              </div>
            }
          />
          <Row label="Due date" hint="Counted in the workspace's time zone.">
            <Checkbox checked={cfg.task.dueInDays !== null} onChange={(v) => setCfg("task", { dueInDays: v ? 7 : null })} label="Set a due date" />
            {cfg.task.dueInDays !== null && <NumInput label="Days after submission" value={cfg.task.dueInDays} min={0} max={365} suffix="days later" width={64} onChange={(dueInDays) => setCfg("task", { dueInDays })} />}
          </Row>
        </Group>
      )}

      <Group title="Content" hint="{{field}} inserts a submitted value; filters: upper, lower, trim, json, default:&quot;…&quot;">
        <Row label="Title" block={<input className="input mono" maxLength={300} value={cfg.templates.title} onChange={(e) => setCfg("templates", { title: e.target.value })} />} />
        <Row label="If the title is empty" block={<input className="input mono" maxLength={300} value={cfg.templates.titleFallback} onChange={(e) => setCfg("templates", { titleFallback: e.target.value })} />} />
        <Row
          label="Body"
          hint="Markdown. {{_fields}} lists every submitted field."
          block={
            <div className="col" style={{ gap: 6 }}>
              <textarea className="textarea mono" rows={6} maxLength={10_000} value={cfg.templates.body} onChange={(e) => setCfg("templates", { body: e.target.value })} spellCheck={false} />
              <div className="streams__chips">
                {[...fieldKeys, ...PLACEHOLDERS].map((p) => (
                  <button key={p} type="button" className="chip chip-btn mono" onClick={() => insert(p)}>
                    {`{{${p}}}`}
                  </button>
                ))}
              </div>
            </div>
          }
        />
        <Row label="Add a footer" hint="Where and when it arrived, below the body.">
          <Switch checked={cfg.templates.footer} onChange={(footer) => setCfg("templates", { footer })} label="Add a footer" />
        </Row>
        <Row label="Attach the raw submission" hint="The full JSON as a code block, below the body.">
          <Switch checked={cfg.templates.includeJson} onChange={(includeJson) => setCfg("templates", { includeJson })} label="Attach the raw submission" />
        </Row>
      </Group>
    </div>
  );
}

// ------------------------------------------------------------ fields

const TYPE_LABEL: Record<StreamFieldType, string> = { text: "Short text", long_text: "Long text", email: "Email", url: "Link", number: "Number", boolean: "Yes / no", choice: "Choice" };

function Fields({ draft, setCfg }: SectionProps) {
  const list = draft.config.fields.list;
  const set = (list: StreamField[]) => setCfg("fields", { list });
  const update = (i: number, patch: Partial<StreamField>) => set(list.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => {
    const next = [...list];
    const [f] = next.splice(i, 1);
    next.splice(i + by, 0, f);
    set(next);
  };
  const keys = list.map((f) => f.key);
  return (
    <div className="col streams__section">
      <Group title="Validation">
        <Row label="Other fields" hint={draft.config.fields.mode === "strict" ? "Submissions with fields not listed below are rejected." : "Fields not listed below are kept and shown under the listed ones."}>
          <Segmented size="sm" value={draft.config.fields.mode} onChange={(mode) => setCfg("fields", { mode })} options={[{ value: "lenient", label: "Keep" }, { value: "strict", label: "Reject" }]} ariaLabel="Other fields" />
        </Row>
      </Group>
      <Group title={`Fields (${list.length})`} hint="checked before anything is created; nested keys use dots, e.g. user.email">
        {list.map((f, i) => {
          const dupe = keys.indexOf(f.key) !== i;
          return (
            <div key={i} className="set-row streams__field">
              <div className="streams__field-grid">
                <input className="input mono" aria-label="Key" placeholder="key" maxLength={64} value={f.key} data-invalid={dupe || !f.key || undefined} onChange={(e) => update(i, { key: e.target.value.replace(/[^A-Za-z0-9_.-]/g, "") })} />
                <input className="input" aria-label="Label" placeholder="Label" maxLength={80} value={f.label} onChange={(e) => update(i, { label: e.target.value })} />
                <Select<StreamFieldType> value={f.type} onChange={(type) => update(i, { type, options: type === "choice" && !f.options.length ? ["option"] : f.options })} options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value: value as StreamFieldType, label }))} ariaLabel="Type" />
                <label className="row streams__check">
                  <Checkbox checked={f.required} onChange={(required) => update(i, { required })} label="Required" /> Required
                </label>
                <label className="row streams__check">
                  <Checkbox checked={f.hidden} onChange={(hidden) => update(i, { hidden })} label="Hidden" /> Hidden
                </label>
                <span className="row" style={{ gap: 2 }}>
                  <IconButton icon={ArrowUp} label="Move up" size="sm" disabled={i === 0} onClick={() => move(i, -1)} />
                  <IconButton icon={ArrowDown} label="Move down" size="sm" disabled={i === list.length - 1} onClick={() => move(i, 1)} />
                  <IconButton icon={X} label="Remove field" size="sm" onClick={() => set(list.filter((_, j) => j !== i))} />
                </span>
                {f.type === "choice" && (
                  <div className="streams__field-wide">
                    <ListInput inline label="Choices" placeholder="low, medium, high" value={f.options} onChange={(options) => update(i, { options })} />
                  </div>
                )}
                {!["boolean", "number", "choice"].includes(f.type) && (
                  <span className="row streams__field-wide" style={{ gap: 6 }}>
                    <span className="faint">Max length</span>
                    <NumInput label="Max length" value={f.maxLength} min={0} max={20_000} width={80} onChange={(maxLength) => update(i, { maxLength })} />
                    <span className="faint">{f.maxLength ? "characters" : "0 = default"}</span>
                    {dupe && <span className="field-error">Another field has this key.</span>}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div className="set-row">
          <Button size="sm" variant="ghost" icon={Plus} disabled={list.length >= 40} onClick={() => set([...list, { key: `field${list.length + 1}`, label: "", type: "text", required: false, maxLength: 0, options: [], hidden: false }])}>
            Add field
          </Button>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            Hidden fields are checked and usable in templates, but left out of {"{{_fields}}"}.
          </span>
        </div>
      </Group>
    </div>
  );
}

// ------------------------------------------------------------ security

const AUTH_HINT = {
  public: "For forms and modals on your website. No secret; origins, rate limits and spam checks do the protecting.",
  token: "For your own servers. Send Authorization: Bearer <secret>.",
  signature: "The strongest. Each request carries an HMAC of its body and time, so it can't be altered or replayed.",
} as const;

function Security({ space, stream, draft, setCfg, onSecret }: SectionProps) {
  const sec = draft.config.security;
  const setSec = (patch: Partial<StreamConfig["security"]>) => setCfg("security", patch);
  const [turnstileSecret, setTurnstileSecret] = useState("");

  const reveal = async () => {
    const ok = await confirm({ title: "Reveal the secret?", message: "Anyone who sees it can send to this stream. The reveal is recorded in the workspace's activity log.", confirmLabel: "Reveal" });
    if (!ok) return;
    const r = await act(() => streamsApi.reveal(space, stream.id), "Couldn't reveal the secret.");
    if (r) onSecret(stream, r.secret);
  };
  const rotate = async () => {
    const grace = await prompt({ title: "Rotate the secret?", label: "Hours the current secret keeps working, so senders can switch over (0 stops it now, at most 168).", initial: "24", confirmLabel: "Rotate" });
    if (grace === null) return;
    const hours = Math.round(Number(grace));
    if (!Number.isFinite(hours) || hours < 0 || hours > 168) return toastError("Enter between 0 and 168 hours.");
    const r = await act(() => streamsApi.rotate(space, stream.id, hours), "Couldn't rotate the secret.");
    if (r) {
      await refreshStreams(space);
      onSecret(r.stream, r.secret);
    }
  };
  const revokePrevious = async () => {
    if (await act(() => streamsApi.revokePrevious(space, stream.id), "Couldn't revoke it.")) {
      await refreshStreams(space);
      toast("The previous secret no longer works");
    }
  };
  const saveTurnstile = async (secret: string | null) => {
    if (await act(() => streamsApi.setTurnstile(space, stream.id, secret), "Couldn't save the Turnstile secret.")) {
      setTurnstileSecret("");
      await refreshStreams(space);
      toast(secret ? "Turnstile secret saved" : "Turnstile secret removed");
    }
  };

  return (
    <div className="col streams__section">
      <Group title="Authentication">
        <div className="streams__pad">
          <Segmented value={sec.auth} onChange={(auth) => setSec({ auth, requireOrigin: auth === "public" ? sec.requireOrigin : false })} options={(["public", "token", "signature"] as const).map((a) => ({ value: a, label: AUTH_TEXT[a] }))} ariaLabel="Authentication" />
          <p className="faint" style={{ margin: "8px 0 0" }}>
            {AUTH_HINT[sec.auth]}
          </p>
        </div>
        <Row label="Secret" hint={<span className="mono">{stream.secretHint}</span>}>
          <Button size="sm" variant="ghost" icon={Eye} onClick={() => void reveal()}>
            Reveal
          </Button>
          <Button size="sm" icon={RefreshCw} onClick={() => void rotate()}>
            Rotate
          </Button>
        </Row>
        {stream.previousSecretExpiresAt && (
          <Row label="Previous secret" hint={`Still accepted until ${new Date(stream.previousSecretExpiresAt).toLocaleString()}.`}>
            <Button size="sm" variant="ghost" onClick={() => void revokePrevious()}>
              Stop accepting it
            </Button>
          </Row>
        )}
        {sec.auth === "signature" && (
          <Row label="Clock tolerance" hint="How far a signature's timestamp may be from now. Signatures are also accepted only once.">
            <NumInput label="Clock tolerance" value={sec.signatureToleranceSec} min={30} max={3600} suffix="seconds" onChange={(signatureToleranceSec) => setSec({ signatureToleranceSec })} />
          </Row>
        )}
      </Group>

      <Group title="Where submissions can come from">
        <Row
          label="Allowed websites"
          hint="Origins such as https://example.com or https://*.example.com, one per line. Empty allows any website. Also controls which sites browsers let send (CORS)."
          block={<ListInput label="Allowed websites" placeholder="https://example.com" value={sec.allowedOrigins} onChange={(allowedOrigins) => setSec({ allowedOrigins })} />}
        />
        {sec.auth === "public" && (
          <Row label="Only from web pages" hint="Refuse requests without an Origin header, which browsers always send. Stops simple scripts.">
            <Switch checked={sec.requireOrigin} onChange={(requireOrigin) => setSec({ requireOrigin })} label="Only from web pages" />
          </Row>
        )}
        <Row
          label="Allowed IP addresses"
          hint="Addresses or ranges (203.0.113.0/24, 2001:db8::/32), one per line. Empty allows any. Useful for CI runners and servers."
          block={<ListInput label="Allowed IP addresses" placeholder="203.0.113.0/24" value={sec.ipAllowlist} onChange={(ipAllowlist) => setSec({ ipAllowlist })} />}
        />
      </Group>

      <Group title="Spam protection">
        <Row label="Honeypot field" hint="A hidden field people leave empty and bots fill in. Filled-in submissions are dropped quietly. Empty turns it off.">
          <input className="input mono" style={{ width: 140 }} aria-label="Honeypot field" placeholder="off" maxLength={64} value={sec.honeypotField ?? ""} onChange={(e) => setSec({ honeypotField: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") || null })} />
        </Row>
        <Row label="Cloudflare Turnstile" hint={sec.auth === "public" ? "A privacy-friendly challenge before submitting. Needs a site key (for the page) and a secret key (kept by Kern Cloud)." : "Only used by public streams."}>
          <Switch checked={sec.turnstile} onChange={(turnstile) => setSec({ turnstile })} label="Cloudflare Turnstile" />
        </Row>
        {sec.turnstile && (
          <>
            <Row label="Site key" hint="Shown in your page's widget.">
              <input className="input mono" style={{ width: 240 }} aria-label="Turnstile site key" maxLength={100} value={sec.turnstileSiteKey ?? ""} onChange={(e) => setSec({ turnstileSiteKey: e.target.value.trim() || null })} />
            </Row>
            <Row label="Secret key" hint={stream.turnstile.secretSet ? "Saved. It can't be shown again." : "Not set: submissions are refused until it is."}>
              <input className="input mono" style={{ width: 200 }} type="password" aria-label="Turnstile secret key" placeholder={stream.turnstile.secretSet ? "Replace…" : "0x…"} value={turnstileSecret} onChange={(e) => setTurnstileSecret(e.target.value)} />
              <Button size="sm" disabled={!turnstileSecret.trim()} onClick={() => void saveTurnstile(turnstileSecret.trim())}>
                Save
              </Button>
              {stream.turnstile.secretSet && <IconButton icon={X} size="sm" label="Remove secret key" onClick={() => void saveTurnstile(null)} />}
            </Row>
          </>
        )}
        <Row label="Escape Markdown in submissions" hint="Submitted text can't add links, images or formatting. Recommended for public streams.">
          <Switch checked={sec.escapeMarkdown} onChange={(escapeMarkdown) => setSec({ escapeMarkdown })} label="Escape Markdown" />
        </Row>
        <Row
          label="Blocked senders"
          hint="Their submissions look accepted but are dropped. Block a sender from Deliveries."
          block={
            sec.blockedSenders.length ? (
              <div className="streams__chips">
                {sec.blockedSenders.map((s) => (
                  <span key={s} className="chip mono">
                    {s}
                    <button type="button" className="streams__chip-x" aria-label={`Unblock ${s}`} onClick={() => setSec({ blockedSenders: sec.blockedSenders.filter((x) => x !== s) })}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            ) : undefined
          }
        >
          {!sec.blockedSenders.length && <span className="faint">None</span>}
        </Row>
      </Group>

      <Group title="Limits">
        <Row label="Per sender" hint="Senders are told when to try again (429 with Retry-After).">
          <NumInput label="Per minute" value={sec.rateLimit.perMinute} min={1} max={600} suffix="a minute" width={64} onChange={(perMinute) => setSec({ rateLimit: { ...sec.rateLimit, perMinute } })} />
          <NumInput label="Per hour" value={sec.rateLimit.perHour} min={1} max={5000} suffix="an hour" width={64} onChange={(perHour) => setSec({ rateLimit: { ...sec.rateLimit, perHour } })} />
        </Row>
        <Row label="Whole stream" hint="All senders together.">
          <NumInput label="Stream per hour" value={sec.rateLimit.streamPerHour} min={1} max={10_000} suffix="an hour" width={72} onChange={(streamPerHour) => setSec({ rateLimit: { ...sec.rateLimit, streamPerHour } })} />
        </Row>
        <Row label="Largest submission">
          <NumInput label="Largest submission" value={sec.maxBodyKb} min={1} max={256} suffix="KB" width={64} onChange={(maxBodyKb) => setSec({ maxBodyKb })} />
        </Row>
        <Row label="Ignore repeats" hint="Identical submissions within this time are recorded once. 0 turns it off. Senders can also send an Idempotency-Key header.">
          <NumInput label="Ignore repeats" value={sec.dedupeMinutes} min={0} max={1440} suffix="minutes" width={64} onChange={(dedupeMinutes) => setSec({ dedupeMinutes })} />
        </Row>
        <Row label="Accept HTML form posts" hint="Form-encoded bodies, as plain <form> elements send. Off accepts JSON only.">
          <Switch checked={sec.allowFormPosts} onChange={(allowFormPosts) => setSec({ allowFormPosts })} label="Accept HTML form posts" />
        </Row>
      </Group>
    </div>
  );
}

// ------------------------------------------------------------ GitHub

function Github({ space, stream, draft, setCfg }: SectionProps) {
  const gh = draft.config.github;
  const opensIssues = draft.config.action === "issue" || draft.config.action === "task_issue";
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const repoSaved = (stream.config.github.repo ?? "") === (gh.repo ?? "");

  const saveToken = async (value: string | null) => {
    setBusy(true);
    const r = await act(() => streamsApi.setGithubToken(space, stream.id, value), "Couldn't save the token.");
    setBusy(false);
    if (!r) return;
    setToken("");
    await refreshStreams(space);
    toast(value ? (r.check ? `Token works with ${r.check.fullName}` : "Token saved") : "Token removed", { tone: value && r.check ? "success" : "info" });
  };
  const check = async () => {
    setBusy(true);
    const r = await act(() => streamsApi.checkGithub(space, stream.id), "GitHub check failed.");
    setBusy(false);
    if (r) {
      await refreshStreams(space);
      toast(`Can open issues in ${r.check.fullName}${r.check.private ? " (private)" : ""}`, { tone: "success" });
    }
  };

  return (
    <div className="col streams__section">
      {!opensIssues && (
        <div className="cloud-callout">
          <GithubMark size={18} />
          <span>This stream doesn't open GitHub issues. Choose GitHub issue or Task + GitHub issue in Destination.</span>
        </div>
      )}
      <Group title="Repository">
        <Row label="Repository" hint="owner/name. Issues are opened here.">
          <input className="input mono" style={{ width: 240 }} aria-label="Repository" placeholder="owner/repository" value={gh.repo ?? ""} onChange={(e) => setCfg("github", { repo: e.target.value.trim() || null })} />
        </Row>
        <Row
          label="Access token"
          hint={
            stream.github.tokenSet ? (
              <>
                Saved (<span className="mono">{stream.github.tokenHint}</span>){stream.github.checkedAt ? `, checked ${timeAgo(stream.github.checkedAt)}` : ""}. Encrypted on the server and never shown again.
              </>
            ) : (
              "A fine-grained personal access token with only “Issues: read and write” on this repository."
            )
          }
        >
          <input className="input mono" style={{ width: 200 }} type="password" aria-label="GitHub token" placeholder={stream.github.tokenSet ? "Replace…" : "github_pat_…"} value={token} onChange={(e) => setToken(e.target.value)} />
          <Button size="sm" icon={KeyRound} disabled={busy || !token.trim()} onClick={() => void saveToken(token.trim())}>
            Save
          </Button>
          {stream.github.tokenSet && <IconButton icon={X} size="sm" label="Remove token" onClick={() => void saveToken(null)} />}
        </Row>
        <Row label="Check access" hint={repoSaved ? "Confirms the token can open issues in the repository." : "Save the repository first."}>
          <Button size="sm" icon={ShieldCheck} disabled={busy || !stream.github.tokenSet || !gh.repo || !repoSaved} onClick={() => void check()}>
            Check
          </Button>
        </Row>
        <Row label="Create a token" hint="GitHub → Settings → Developer settings → Fine-grained tokens. Pick this repository only, and set an expiry.">
          <Button size="sm" variant="ghost" onClick={() => void api.system.open("https://github.com/settings/personal-access-tokens/new")}>
            Open GitHub
          </Button>
        </Row>
      </Group>
      <Group title="Issues">
        <Row label="Labels" hint="Comma-separated. GitHub creates missing ones if the token may." block={<ListInput inline label="Labels" placeholder="bug, from-website" value={gh.labels} onChange={(labels) => setCfg("github", { labels })} />} />
        <Row label="Assignees" hint="GitHub usernames, comma-separated." block={<ListInput inline label="Assignees" placeholder="octocat" value={gh.assignees} onChange={(assignees) => setCfg("github", { assignees })} />} />
        <Row label="Link to the task" hint="When the task's project is connected to this repository, link them so edits sync both ways (Task + GitHub issue only).">
          <Switch checked={gh.linkToTask} onChange={(linkToTask) => setCfg("github", { linkToTask })} label="Link to the task" />
        </Row>
        <Row label="Neutralise mentions" hint="Stops submissions from notifying people (@name) or referencing other issues (#12).">
          <Switch checked={gh.neutralizeMentions} onChange={(neutralizeMentions) => setCfg("github", { neutralizeMentions })} label="Neutralise mentions" />
        </Row>
      </Group>
    </div>
  );
}

// ------------------------------------------------------------ responses

function Responses({ draft, setCfg }: SectionProps) {
  const cfg = draft.config;
  const isPublic = cfg.security.auth === "public";
  return (
    <div className="col streams__section">
      <Group title="Replies to senders">
        <Row label="Success message" hint="Returned as message, and shown on the thank-you page after a form post." block={<input className="input" maxLength={300} value={cfg.responses.successMessage} onChange={(e) => setCfg("responses", { successMessage: e.target.value })} />} />
        <Row
          label="After a form post, go to"
          hint="Plain HTML forms are sent here afterwards, with ?kern=ok or ?kern=error&code=… added. Empty shows a simple thank-you page."
          block={<input className="input" placeholder="https://example.com/thanks" maxLength={500} value={cfg.responses.redirectUrl ?? ""} onChange={(e) => setCfg("responses", { redirectUrl: e.target.value.trim() || null })} />}
        />
        <Row label="Return ids" hint={isPublic ? "Only for token and signature streams, so the public never learns your task ids." : "Include the task id and issue link in responses."}>
          <Switch checked={cfg.responses.returnIds && !isPublic} disabled={isPublic} onChange={(returnIds) => setCfg("responses", { returnIds })} label="Return ids" />
        </Row>
      </Group>
      <Group title="Notifications">
        <Row label="In Kern" hint="A notification for everyone with this space open (each person can turn these off in Settings → Cloud).">
          <Switch checked={cfg.notify.app} onChange={(app) => setCfg("notify", { app })} label="Notify in Kern" />
        </Row>
        <Row label="Email" hint="At most one email a minute per stream; the delivery log has everything.">
          <Select
            value={cfg.notify.email}
            onChange={(email) => setCfg("notify", { email })}
            options={[
              { value: "off", label: "Off" },
              { value: "each", label: "Every submission" },
              { value: "failures", label: "Only problems" },
            ]}
            ariaLabel="Email notifications"
            style={{ width: 170 }}
          />
          {cfg.notify.email !== "off" && (
            <Select
              value={cfg.notify.emailTo}
              onChange={(emailTo) => setCfg("notify", { emailTo })}
              options={[
                { value: "creator", label: "To the creator" },
                { value: "admins", label: "To all admins" },
              ]}
              ariaLabel="Email recipients"
              style={{ width: 150 }}
            />
          )}
        </Row>
      </Group>
      <Group title="Delivery log">
        <Row label="Keep submitted data" hint="Needed to inspect and redeliver submissions. Off keeps only outcomes. Spam is never kept.">
          <Switch checked={cfg.log.storePayloads} onChange={(storePayloads) => setCfg("log", { storePayloads })} label="Keep submitted data" />
        </Row>
        <Row label="Keep entries for">
          <NumInput label="Retention" value={cfg.log.retentionDays} min={1} max={90} suffix="days" width={64} onChange={(retentionDays) => setCfg("log", { retentionDays })} />
        </Row>
      </Group>
    </div>
  );
}
