// A stream's delivery log: every submission that reached it, with what
// happened. Entries open to show the submitted data, and can be redelivered
// (with the stream's current settings) or used to block their sender.

import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Ban, ExternalLink, ListTodo, RotateCcw, Trash } from "lucide-react";
import { api } from "@/lib/ipc";
import type { Stream, StreamEvent, StreamEventStatus } from "@/lib/types";
import { navigate } from "@/stores/router";
import { toast, toastError } from "@/stores/toast";
import { Button } from "@/components/ui/Button";
import { EmptyState, Segmented, Skeleton } from "@/components/ui/Controls";
import { confirm } from "@/components/ui/Dialog";
import { errorText } from "@/features/cloud/store";
import { timeAgo } from "@/features/cloud/ui";
import { refreshStreams, STATUS_TEXT, streamKeys, streamsApi } from "./api";

type Filter = "all" | "delivered" | "problems" | "spam" | "duplicate";

const FILTERS: Record<Filter, { label: string; status: StreamEventStatus[] }> = {
  all: { label: "All", status: [] },
  delivered: { label: "Delivered", status: ["delivered"] },
  problems: { label: "Problems", status: ["failed", "partial", "rejected"] },
  spam: { label: "Spam", status: ["spam"] },
  duplicate: { label: "Duplicates", status: ["duplicate"] },
};

const AUTH_LABEL: Record<string, string> = { public: "public", token: "secret token", signature: "signed", test: "test send", redeliver: "redelivered" };

export function Deliveries({ space, stream }: { space: string; stream: Stream }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<number | null>(null);
  const q = useInfiniteQuery({
    queryKey: streamKeys.events(space, stream.id, filter),
    queryFn: ({ pageParam }) => streamsApi.events(space, stream.id, { before: pageParam || undefined, status: FILTERS[filter].status }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore && last.events.length ? last.events[last.events.length - 1].id : undefined),
  });
  const events = q.data?.pages.flatMap((p) => p.events) ?? [];

  const clear = async () => {
    const ok = await confirm({ title: "Clear the delivery log?", message: "Every entry for this stream is deleted. Tasks and issues it created are kept.", confirmLabel: "Clear log", danger: true });
    if (!ok) return;
    try {
      const r = await streamsApi.clearEvents(space, stream.id);
      await refreshStreams(space);
      toast(`Removed ${r.removed} entr${r.removed === 1 ? "y" : "ies"}`);
    } catch (e) {
      toastError(errorText(e, "Couldn't clear the log."));
    }
  };

  return (
    <div className="col streams__section">
      <div className="row" style={{ gap: 8 }}>
        <Segmented<Filter> size="sm" value={filter} onChange={(f) => { setFilter(f); setOpen(null); }} options={(Object.keys(FILTERS) as Filter[]).map((f) => ({ value: f, label: FILTERS[f].label }))} ariaLabel="Show" />
        <span className="spacer" />
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Kept {stream.config.log.retentionDays} days
        </span>
        <Button size="sm" variant="ghost" icon={Trash} onClick={() => void clear()}>
          Clear
        </Button>
      </div>
      {q.isLoading ? (
        <Skeleton height={160} />
      ) : !events.length ? (
        <EmptyState compact title={filter === "all" ? "Nothing received yet" : "Nothing here"}>
          {filter === "all" ? "Submissions appear here as they arrive. Try a test send from Overview." : "No deliveries match this filter."}
        </EmptyState>
      ) : (
        <div className="set-group streams__log">
          {events.map((e) => (
            <EventRow key={e.id} space={space} stream={stream} event={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
          ))}
        </div>
      )}
      {q.hasNextPage && (
        <Button size="sm" variant="ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? "Loading…" : "Show older"}
        </Button>
      )}
    </div>
  );
}

function EventRow({ space, stream, event: e, open, onToggle }: { space: string; stream: Stream; event: StreamEvent; open: boolean; onToggle: () => void }) {
  const [busy, setBusy] = useState(false);
  const detail = useQuery({ queryKey: [...streamKeys.events(space, stream.id, "detail"), e.id], queryFn: () => streamsApi.event(space, stream.id, e.id), enabled: open && e.hasPayload });
  const blocked = !!e.sender && stream.config.security.blockedSenders.includes(e.sender);

  const redeliver = async () => {
    setBusy(true);
    try {
      const r = await streamsApi.redeliver(space, stream.id, e.id);
      await refreshStreams(space);
      if (r.status === "failed") toastError(r.message ?? "Redelivery failed.");
      else toast(r.status === "partial" ? `Partly delivered: ${r.message}` : "Redelivered", { tone: r.status === "partial" ? "error" : "success", action: r.taskId ? { label: "Open task", run: () => navigate({ name: "task", id: r.taskId! }) } : undefined });
    } catch (err) {
      toastError(errorText(err, "Couldn't redeliver it."));
    } finally {
      setBusy(false);
    }
  };
  const block = async () => {
    const ok = await confirm({ title: "Block this sender?", message: "Their future submissions to this stream look accepted but are dropped. You can unblock them in Security.", confirmLabel: "Block", danger: true });
    if (!ok) return;
    try {
      await streamsApi.block(space, stream.id, e.id);
      await refreshStreams(space);
      toast("Sender blocked");
    } catch (err) {
      toastError(errorText(err, "Couldn't block the sender."));
    }
  };

  return (
    <div className="streams__event" data-open={open || undefined}>
      <button type="button" className="streams__event-head" onClick={onToggle} aria-expanded={open}>
        <span className="streams__badge" data-status={e.status}>
          {STATUS_TEXT[e.status]}
        </span>
        <span className="truncate grow">
          {e.message ?? (e.taskId ? "Task created" : e.inboxId ? "Inbox item added" : e.issue ? `Issue #${e.issue.number}` : "")}
        </span>
        {e.test && <span className="chip">test</span>}
        <span className="faint streams__event-time" title={new Date(e.receivedAt).toLocaleString()}>
          {timeAgo(e.receivedAt)}
        </span>
      </button>
      {open && (
        <div className="streams__event-body">
          <dl className="streams__meta">
            <dt>Received</dt>
            <dd>{new Date(e.receivedAt).toLocaleString()}</dd>
            {e.auth && (
              <>
                <dt>Via</dt>
                <dd>{AUTH_LABEL[e.auth] ?? e.auth}</dd>
              </>
            )}
            {e.origin && (
              <>
                <dt>Website</dt>
                <dd className="mono">{e.origin}</dd>
              </>
            )}
            {e.sender && (
              <>
                <dt>Sender</dt>
                <dd>
                  <span className="mono">{e.sender}</span> <span className="faint">(an anonymised address)</span>
                  {blocked && <span className="chip"> blocked</span>}
                </dd>
              </>
            )}
            {e.userAgent && (
              <>
                <dt>Client</dt>
                <dd className="truncate">{e.userAgent}</dd>
              </>
            )}
            {e.idempotencyKey && (
              <>
                <dt>Idempotency key</dt>
                <dd className="mono">{e.idempotencyKey}</dd>
              </>
            )}
            {e.code && (
              <>
                <dt>Code</dt>
                <dd className="mono">{e.code}</dd>
              </>
            )}
            {e.durationMs !== null && (
              <>
                <dt>Took</dt>
                <dd>{e.durationMs} ms</dd>
              </>
            )}
          </dl>
          {e.hasPayload ? detail.data ? <pre className="streams__code mono">{JSON.stringify(detail.data.payload, null, 2)}</pre> : <Skeleton height={60} /> : <span className="faint">{e.status === "spam" ? "Spam isn't kept." : "The submitted data wasn't kept (see Responses → Delivery log)."}</span>}
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {e.taskId && (
              <Button size="sm" icon={ListTodo} onClick={() => navigate({ name: "task", id: e.taskId! })}>
                Open task
              </Button>
            )}
            {e.inboxId && (
              <Button size="sm" icon={ListTodo} onClick={() => navigate({ name: "inbox" })}>
                Open Inbox
              </Button>
            )}
            {e.issue && (
              <Button size="sm" icon={ExternalLink} onClick={() => void api.system.open(e.issue!.url)}>
                Issue #{e.issue.number}
              </Button>
            )}
            <span className="spacer" />
            {e.hasPayload && e.status !== "spam" && (
              <Button size="sm" variant="ghost" icon={RotateCcw} disabled={busy} onClick={() => void redeliver()}>
                {busy ? "Sending…" : "Redeliver"}
              </Button>
            )}
            {e.sender && !blocked && (
              <Button size="sm" variant="ghost" icon={Ban} onClick={() => void block()}>
                Block sender
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
