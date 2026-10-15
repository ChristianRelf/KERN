/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// Share links: publish a read-only copy of a note, whiteboard or project to
// a private link (Kern Cloud). The link shows a snapshot; publishing again
// updates it, and it can be turned off at any time. Nothing is shared until
// "Create link" is pressed.

import { Copy, ExternalLink, Globe, Link2Off, Loader2, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ShareLink } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import { relativeTime } from "@/lib/dates";
import { toast, toastError } from "@/stores/toast";
import { Button } from "@/components/ui/Button";
import { Dialog, confirm } from "@/components/ui/Dialog";
import { Select, Skeleton, Switch } from "@/components/ui/Controls";
import { openAuth, useCloud } from "@/features/cloud/store";
import { useShare, type ShareRequest } from "./open";

const KIND_NOUN = { note: "note", whiteboard: "whiteboard", project: "project" } as const;

async function contentFor(req: ShareRequest, opts: { includeTasks: boolean; includeDone: boolean }) {
  if (req.kind === "note") {
    const n = await api.notes.get(req.refId);
    return { title: n.title || "Untitled note", content: { markdown: n.content } };
  }
  if (req.kind === "whiteboard") {
    const img = await req.render?.();
    if (!img) throw new Error("Open the whiteboard to share it, and add something to it first.");
    return { title: req.title, content: { width: img.width, height: img.height, objects: img.objects }, image: img.base64, imageMime: img.mime };
  }
  const [p, ms] = await Promise.all([api.projects.get(req.refId), api.milestones.list(req.refId)]);
  let tasks: { title: string; status: string; dueDate: string | null }[] = [];
  if (opts.includeTasks) {
    const open = await api.tasks.query({ projectIds: [req.refId], topLevelOnly: true, order: "due", limit: 800 });
    const done = opts.includeDone ? await api.tasks.query({ projectIds: [req.refId], topLevelOnly: true, statuses: ["completed"], order: "completed", limit: 200 }) : [];
    tasks = [...open, ...done.filter((t) => !t.resolution)].map((t) => ({ title: t.title, status: t.status, dueDate: t.dueDate }));
  }
  return {
    title: p.name,
    content: {
      description: p.description,
      targetDate: p.targetDate,
      done: p.taskDone,
      total: p.taskTotal,
      milestones: ms.filter((m) => m.status !== "cancelled").map((m) => ({ title: m.title, targetDate: m.targetDate, status: m.status, progress: m.progress })),
      tasks,
    },
  };
}

export default function ShareHost() {
  const req = useShare((s) => s.req)!;
  const signedIn = useCloud((s) => !!s.info?.signedIn);
  const verified = useCloud((s) => !!s.info?.account?.emailVerified);
  const [expires, setExpires] = useState<string>("never");
  const [includeTasks, setIncludeTasks] = useState(true);
  const [includeDone, setIncludeDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = ["shares", req.kind, req.refId];
  const existing = useQuery({
    queryKey: key,
    queryFn: () => api.cloud.request<{ share: ShareLink | null }>("GET", `/shares/for/${req.kind}/${encodeURIComponent(req.refId)}`).then((r) => r.share),
    enabled: signedIn,
    retry: false,
  });
  const close = () => useShare.setState({ req: null });
  const share = existing.data ?? null;

  const publish = async () => {
    setBusy(true);
    try {
      const c = await contentFor(req, { includeTasks, includeDone });
      const res = await api.cloud.request<{ share: ShareLink }>("PUT", "/shares", {
        kind: req.kind,
        refId: req.refId,
        ...c,
        expiresInDays: expires === "never" ? null : Number(expires),
      });
      queryClient.setQueryData(key, res.share);
      await navigator.clipboard.writeText(res.share.url).catch(() => undefined);
      toast(share ? "Link updated - copied to the clipboard" : "Link created - copied to the clipboard");
    } catch (e) {
      toastError(e instanceof Error && !(e as { code?: string }).code ? e.message : describeError(e, "Couldn't create the link."));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    if (!share) return;
    if (!(await confirm({ title: "Turn off this link?", message: "Anyone with the link loses access straight away. You can make a new link later (it'll have a different address).", confirmLabel: "Turn off", danger: true }))) return;
    try {
      await api.cloud.request("DELETE", `/shares/${share.id}`);
      queryClient.setQueryData(key, null);
      toast("Link turned off");
    } catch (e) {
      toastError(describeError(e));
    }
  };

  const noun = KIND_NOUN[req.kind];
  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={<span className="row" style={{ gap: 8 }}><Globe size={16} /> Share “{req.title || "Untitled"}”</span>}
      footer={
        signedIn && verified ? (
          <>
            {share && (
              <Button variant="ghost" icon={Link2Off} onClick={() => void turnOff()}>
                Turn off link
              </Button>
            )}
            <span className="grow" />
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button variant="primary" icon={busy ? Loader2 : share ? RefreshCw : Globe} disabled={busy || existing.isLoading} onClick={() => void publish()}>
              {share ? "Update link" : "Create link"}
            </Button>
          </>
        ) : undefined
      }
    >
      {!signedIn ? (
        <div className="col" style={{ gap: 10 }}>
          <p className="muted" style={{ margin: 0 }}>Share links are part of Kern Cloud (free). Sign in to publish a read-only copy of this {noun} that anyone with the link can open in a browser.</p>
          <Button variant="primary" style={{ alignSelf: "flex-start" }} onClick={() => openAuth({ reason: `Sign in to share this ${noun}.` })}>
            Sign in to Kern Cloud
          </Button>
        </div>
      ) : !verified ? (
        <p className="muted" style={{ margin: 0 }}>Confirm your email address first (Settings → Account & Cloud).</p>
      ) : existing.isLoading ? (
        <Skeleton height={60} />
      ) : (
        <div className="col" style={{ gap: 14 }}>
          <p className="muted" style={{ margin: 0, fontSize: "var(--fs-sm)" }}>
            Anyone with the link can view a read-only copy of this {noun} in a browser{req.kind === "project" ? ": its progress and milestones, and its tasks if you include them" : ""}. It's a snapshot: press “Update link” to publish changes. Links aren't listed or indexed by search engines.
          </p>
          {share && (
            <div className="panel" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 6 }}>
                <input className="input grow selectable" readOnly value={share.url} onFocus={(e) => e.currentTarget.select()} aria-label="Share link" />
                <Button size="sm" icon={Copy} onClick={() => void navigator.clipboard.writeText(share.url).then(() => toast("Link copied"))}>
                  Copy
                </Button>
                <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void api.system.open(share.url)}>
                  Open
                </Button>
              </div>
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                Published {relativeTime(new Date(share.updatedAt).getTime())} · {share.views} view{share.views === 1 ? "" : "s"}
                {share.expiresAt ? ` · expires ${new Date(share.expiresAt).toLocaleDateString()}` : ""}
              </span>
            </div>
          )}
          <div className="row" style={{ gap: 10, justifyContent: "space-between" }}>
            <span style={{ fontSize: "var(--fs-sm)" }}>Link expires</span>
            <Select
              value={expires}
              onChange={setExpires}
              options={[
                { value: "never", label: share?.expiresAt ? "Keep current" : "Never" },
                { value: "1", label: "After a day" },
                { value: "7", label: "After a week" },
                { value: "30", label: "After 30 days" },
                { value: "90", label: "After 90 days" },
              ]}
            />
          </div>
          {req.kind === "project" && (
            <>
              <div className="row" style={{ gap: 10, justifyContent: "space-between" }}>
                <span style={{ fontSize: "var(--fs-sm)" }}>Include open tasks</span>
                <Switch checked={includeTasks} onChange={setIncludeTasks} label="Include open tasks" />
              </div>
              {includeTasks && (
                <div className="row" style={{ gap: 10, justifyContent: "space-between" }}>
                  <span style={{ fontSize: "var(--fs-sm)" }}>Include finished tasks</span>
                  <Switch checked={includeDone} onChange={setIncludeDone} label="Include finished tasks" />
                </div>
              )}
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                Tasks show only their title, whether they're done, and their due date. Descriptions, comments and files are never shared.
              </span>
            </>
          )}
          {req.kind === "whiteboard" && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>The link shows an image of the whole board as it is now.</span>}
        </div>
      )}
    </Dialog>
  );
}
