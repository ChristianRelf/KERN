// Workspace management: details, members and roles, invitations, GitHub
// organisation, activity, and leaving or deleting.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Building2, Copy, Crown, LogOut, Mail, RefreshCw, Send, Trash, TriangleAlert, Users, X } from "lucide-react";
import { api } from "@/lib/ipc";
import type { AuditEntry, InviteResult, Member, Space, SpaceRole, WorkspaceDetail } from "@/lib/types";
import { Dialog, confirm, prompt } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Select, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { toast, toastError } from "@/stores/toast";
import { GithubMark } from "@/features/github/shared";
import { errorText, refreshMe, useCloud, type ManageTab } from "./store";
import { leaveLostSpace } from "./actions";
import { AboutFields, BasicsFields, GithubPicker, InviteEditor, validWebsite, type GithubChoice, type InviteDraft, type WorkspaceDraft } from "./workspaceFields";
import { Avatar, ROLE_HINT, ROLE_LABEL, SpaceLogo, timeAgo } from "./ui";

const TABS: { id: ManageTab; label: string; icon: typeof Users; admin?: boolean }[] = [
  { id: "general", label: "General", icon: Building2 },
  { id: "members", label: "Members", icon: Users },
  { id: "invites", label: "Invitations", icon: Mail, admin: true },
  { id: "github", label: "GitHub", icon: RefreshCw },
  { id: "activity", label: "Activity", icon: Activity, admin: true },
  { id: "danger", label: "Leave or delete", icon: TriangleAlert },
];

export const workspaceKey = (id: string) => ["cloud", "workspace", id];

export function ManageWorkspaceDialog() {
  const manage = useCloud((s) => s.manage);
  return manage ? <Manage key={manage.id} id={manage.id} tab={manage.tab} /> : null;
}

function Manage({ id, tab }: { id: string; tab: ManageTab }) {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: workspaceKey(id),
    queryFn: () => api.cloud.request<WorkspaceDetail>("GET", `/workspaces/${id}`),
    staleTime: 10_000,
  });
  const close = () => useCloud.setState({ manage: null });
  const setTab = (t: ManageTab) => useCloud.setState({ manage: { id, tab: t } });
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: workspaceKey(id) });
    void refreshMe();
  };
  const ws = data?.workspace;
  const isAdmin = ws?.role === "owner" || ws?.role === "admin";
  const tabs = TABS.filter((t) => !t.admin || isAdmin);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      wide
      className="manage"
      title={
        <span className="row" style={{ gap: 8 }}>
          {ws ? <SpaceLogo name={ws.name} logo={ws.logo} accent={ws.accent} size={18} /> : <Building2 size={16} />}
          {ws?.name ?? "Workspace"}
        </span>
      }
    >
      {isLoading ? (
        <Skeleton height={240} />
      ) : isError || !data ? (
        <div className="field-error">{errorText(error, "Couldn't load this workspace.")}</div>
      ) : (
        <div className="manage__layout">
          <nav className="manage__tabs">
            {tabs.map((t) => (
              <button key={t.id} type="button" className="manage__tab" data-active={t.id === tab || undefined} onClick={() => setTab(t.id)}>
                <t.icon size={14} strokeWidth={1.75} />
                {t.label}
                {t.id === "members" && <span className="faint">{data.members.length}</span>}
                {t.id === "invites" && data.invites.filter((i) => i.status === "pending").length > 0 && <span className="faint">{data.invites.filter((i) => i.status === "pending").length}</span>}
              </button>
            ))}
          </nav>
          <div className="manage__body">
            {tab === "general" && <General ws={data.workspace} canEdit={isAdmin} onSaved={reload} />}
            {tab === "members" && <Members detail={data} onChanged={reload} />}
            {tab === "invites" && isAdmin && <Invites detail={data} onChanged={reload} />}
            {tab === "github" && <Github ws={data.workspace} canEdit={isAdmin} onChanged={reload} />}
            {tab === "activity" && isAdmin && <ActivityLog id={id} />}
            {tab === "danger" && <Danger ws={data.workspace} members={data.members} onDone={close} />}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Section({ title, children, hint }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="manage__section">
      <div className="manage__section-head">
        <span className="set-group__title" style={{ margin: 0 }}>
          {title}
        </span>
        {hint && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{hint}</span>}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------ general

function draftOf(ws: Space): WorkspaceDraft {
  return {
    name: ws.name,
    slug: ws.slug ?? "",
    description: ws.description ?? "",
    logo: ws.logo,
    accent: ws.accent,
    website: ws.website ?? "",
    industry: ws.industry ?? "",
    teamSize: ws.teamSize,
    useCase: ws.useCase ?? "",
    timezone: ws.timezone ?? "",
  };
}

function General({ ws, canEdit, onSaved }: { ws: Space; canEdit: boolean; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => draftOf(ws));
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(draftOf(ws)), [ws]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(ws));
  const set = (p: Partial<WorkspaceDraft>) => setDraft((d) => ({ ...d, ...p }));
  const save = async () => {
    if (!draft.name.trim()) return toastError("Give the workspace a name.");
    if (!validWebsite(draft.website)) return toastError("The website should start with https://");
    setBusy(true);
    try {
      await api.cloud.request("PATCH", `/workspaces/${ws.id}`, {
        name: draft.name.trim(),
        slug: draft.slug || undefined,
        description: draft.description.trim(),
        logo: draft.logo,
        accent: draft.accent,
        website: draft.website.trim(),
        industry: draft.industry || null,
        teamSize: draft.teamSize,
        useCase: draft.useCase || null,
        timezone: draft.timezone || null,
      });
      await onSaved();
      toast("Workspace updated");
    } catch (e) {
      toastError(errorText(e, "Couldn't save the changes."));
    } finally {
      setBusy(false);
    }
  };
  if (!canEdit)
    return (
      <div className="col" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 12 }}>
          <SpaceLogo name={ws.name} logo={ws.logo} accent={ws.accent} size={56} />
          <div className="col">
            <strong style={{ fontSize: "var(--fs-lg)" }}>{ws.name}</strong>
            <span className="faint mono">kern/{ws.slug}</span>
          </div>
        </div>
        {ws.description && <p className="muted">{ws.description}</p>}
        <span className="faint">Only owners and admins can change workspace details. You're a {ROLE_LABEL[ws.role].toLowerCase()}.</span>
      </div>
    );
  return (
    <div className="col" style={{ gap: 20 }}>
      <Section title="Identity">
        <BasicsFields draft={draft} set={set} currentSlug={ws.slug} />
      </Section>
      <Section title="About">
        <AboutFields draft={draft} set={set} />
      </Section>
      <div className="manage__actions">
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Created {timeAgo(ws.createdAt)}</span>
        <span className="spacer" />
        <Button variant="ghost" disabled={!dirty || busy} onClick={() => setDraft(draftOf(ws))}>
          Discard
        </Button>
        <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ members

function Members({ detail, onChanged }: { detail: WorkspaceDetail; onChanged: () => Promise<void> }) {
  const self = useCloud((s) => s.info?.account?.id);
  const peers = useCloud((s) => s.peers);
  const online = useMemo(() => new Set(Object.values(peers).map((p) => p.userId)), [peers]);
  const ws = detail.workspace;
  const myRole = ws.role;
  const [q, setQ] = useState("");
  const list = detail.members.filter((m) => !q || `${m.name} ${m.email} ${m.title ?? ""}`.toLowerCase().includes(q.toLowerCase()));

  const act = async (fn: () => Promise<unknown>, ok: string, fail: string) => {
    try {
      await fn();
      await onChanged();
      toast(ok);
    } catch (e) {
      toastError(errorText(e, fail));
    }
  };
  const canManage = (m: Member) => m.role !== "owner" && m.userId !== self && (myRole === "owner" || (myRole === "admin" && m.role !== "admin"));

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <input className="input grow" placeholder="Search members" value={q} onChange={(e) => setQ(e.target.value)} />
        {(myRole === "owner" || myRole === "admin") && (
          <Button icon={Send} onClick={() => useCloud.setState({ manage: { id: ws.id, tab: "invites" } })}>
            Invite
          </Button>
        )}
      </div>
      <div className="member-list">
        {list.map((m) => (
          <div key={m.userId} className="member-row">
            <span className="member-row__avatar">
              <Avatar name={m.name || m.email} image={m.image} size={30} />
              {online.has(m.userId) && <span className="presence-dot" title="Online now" />}
            </span>
            <div className="col grow" style={{ minWidth: 0 }}>
              <span className="truncate">
                {m.name || m.email} {m.userId === self && <span className="faint">(you)</span>}
                {m.title && <span className="faint"> · {m.title}</span>}
              </span>
              <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>
                {m.email} · joined {timeAgo(m.joinedAt)}
              </span>
            </div>
            {m.userId === self && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const title = await prompt({ title: "Your title in this workspace", label: "Shown next to your name, e.g. Designer", initial: m.title ?? "", confirmLabel: "Save" });
                  if (title === null) return;
                  await act(() => api.cloud.request("PATCH", `/workspaces/${ws.id}/members/${m.userId}`, { title }), "Title updated", "Couldn't update your title.");
                }}
              >
                Set title
              </Button>
            )}
            {canManage(m) ? (
              <>
                <Tooltip content={ROLE_HINT[m.role]}>
                  <span>
                    <Select<Exclude<SpaceRole, "owner">>
                      value={m.role as Exclude<SpaceRole, "owner">}
                      onChange={(role) => void act(() => api.cloud.request("PATCH", `/workspaces/${ws.id}/members/${m.userId}`, { role }), `${m.name || m.email} is now ${ROLE_LABEL[role].toLowerCase()}`, "Couldn't change the role.")}
                      options={(myRole === "owner" ? (["admin", "member", "viewer"] as const) : (["member", "viewer"] as const)).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
                      ariaLabel={`Role for ${m.name}`}
                      style={{ width: 110 }}
                    />
                  </span>
                </Tooltip>
                {myRole === "owner" && (
                  <IconButton
                    icon={Crown}
                    label="Make owner"
                    size="sm"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Make ${m.name || m.email} the owner?`,
                        message: "You'll become an admin. Only the owner can delete the workspace or transfer it again.",
                        confirmLabel: "Transfer ownership",
                        danger: true,
                      });
                      if (ok) await act(() => api.cloud.request("POST", `/workspaces/${ws.id}/transfer`, { userId: m.userId }), "Ownership transferred", "Couldn't transfer ownership.");
                    }}
                  />
                )}
                <IconButton
                  icon={X}
                  label="Remove from workspace"
                  size="sm"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `Remove ${m.name || m.email}?`,
                      message: "They lose access straight away. What they created stays in the workspace.",
                      confirmLabel: "Remove",
                      danger: true,
                    });
                    if (ok) await act(() => api.cloud.request("DELETE", `/workspaces/${ws.id}/members/${m.userId}`), "Member removed", "Couldn't remove them.");
                  }}
                />
              </>
            ) : (
              <span className="chip chip--outline">{ROLE_LABEL[m.role]}</span>
            )}
          </div>
        ))}
      </div>
      <div className="role-legend">
        {(["owner", "admin", "member", "viewer"] as const).map((r) => (
          <span key={r}>
            <strong>{ROLE_LABEL[r]}</strong> {ROLE_HINT[r].toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ invitations

function Invites({ detail, onChanged }: { detail: WorkspaceDetail; onChanged: () => Promise<void> }) {
  const account = useCloud((s) => s.info?.account);
  const ws = detail.workspace;
  const [invites, setInvites] = useState<InviteDraft[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<InviteResult[] | null>(null);
  const pending = detail.invites.filter((i) => i.status === "pending" || i.status === "expired");

  const send = async () => {
    setBusy(true);
    try {
      const res = await api.cloud.request<{ results: InviteResult[] }>("POST", `/workspaces/${ws.id}/invites`, { invites, message: message.trim() || undefined });
      setResults(res.results);
      setInvites(res.results.filter((r) => !r.ok).map((r) => invites.find((i) => i.email === r.email)!).filter(Boolean));
      await onChanged();
      const ok = res.results.filter((r) => r.ok).length;
      if (ok) toast(`${ok} invitation${ok === 1 ? "" : "s"} sent`, { tone: "success" });
    } catch (e) {
      toastError(errorText(e, "Couldn't send the invitations."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 20 }}>
      <Section title="Invite people" hint="They'll get an email with a link that opens Kern.">
        <InviteEditor invites={invites} onChange={setInvites} message={message} onMessage={setMessage} selfEmail={account?.email} />
        {results?.some((r) => !r.ok) && (
          <div className="col" style={{ gap: 4 }}>
            {results
              .filter((r) => !r.ok)
              .map((r) => (
                <span key={r.email} className="field-error">
                  {r.email}: {r.reason}
                </span>
              ))}
          </div>
        )}
        <div className="manage__actions">
          <span className="spacer" />
          <Button variant="primary" icon={Send} disabled={!invites.length || busy} onClick={() => void send()}>
            {busy ? "Sending…" : `Send ${invites.length || ""} invitation${invites.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      </Section>
      <Section title={`Pending (${pending.length})`} hint="Invitations expire after 14 days.">
        {!pending.length && <span className="faint">No open invitations.</span>}
        <div className="member-list">
          {pending.map((i) => (
            <div key={i.id} className="member-row">
              <Avatar name={i.email} size={30} />
              <div className="col grow" style={{ minWidth: 0 }}>
                <span className="truncate">{i.email}</span>
                <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>
                  {ROLE_LABEL[i.role]} · {i.status === "expired" ? "expired" : `sent ${timeAgo(i.lastSentAt ?? i.createdAt)}`}
                  {i.inviterName ? ` by ${i.inviterName}` : ""}
                  {i.sendCount > 1 ? ` · sent ${i.sendCount}×` : ""}
                </span>
              </div>
              <IconButton
                icon={Copy}
                label="Copy invite link"
                size="sm"
                onClick={() => void navigator.clipboard.writeText(i.link).then(() => toast("Invite link copied. It only works for " + i.email))}
              />
              <Button
                size="sm"
                variant="ghost"
                icon={RefreshCw}
                onClick={async () => {
                  try {
                    const r = await api.cloud.request<InviteResult>("POST", `/workspaces/${ws.id}/invites/${i.id}/resend`);
                    if (!r.ok) throw new Error(r.reason);
                    await onChanged();
                    toast(`Sent again to ${i.email}`);
                  } catch (e) {
                    toastError(errorText(e, (e as Error).message || "Couldn't resend it."));
                  }
                }}
              >
                Resend
              </Button>
              <IconButton
                icon={X}
                label="Revoke invitation"
                size="sm"
                onClick={async () => {
                  try {
                    await api.cloud.request("DELETE", `/workspaces/${ws.id}/invites/${i.id}`);
                    await onChanged();
                    toast("Invitation revoked");
                  } catch (e) {
                    toastError(errorText(e, "Couldn't revoke it."));
                  }
                }}
              />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------ GitHub

function Github({ ws, canEdit, onChanged }: { ws: Space; canEdit: boolean; onChanged: () => Promise<void> }) {
  const active = useCloud((s) => s.info?.active?.id);
  const [choice, setChoice] = useState<GithubChoice>({ org: ws.githubOrg, repos: [], syncIssues: true });
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!choice.org || !choice.repos.length) return;
    setBusy(true);
    try {
      const r = await api.github.importRepos(
        choice.repos.map((x) => ({ fullName: x.fullName, description: x.description, defaultBranch: x.defaultBranch, htmlUrl: x.htmlUrl })),
        choice.syncIssues,
      );
      await api.cloud.request("POST", `/workspaces/${ws.id}/github-synced`, { org: choice.org, repos: r.created.length });
      await onChanged();
      toast(r.created.length ? `Imported ${r.created.length} new project${r.created.length === 1 ? "" : "s"}${r.skipped.length ? ` (${r.skipped.length} already here)` : ""}` : "Everything selected is already in this workspace");
    } catch (e) {
      toastError(errorText(e, "Couldn't import the repositories."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="cloud-callout">
        <GithubMark size={18} />
        <div className="col" style={{ gap: 2 }}>
          <span>{ws.githubOrg ? <>Linked to <strong>{ws.githubOrg}</strong></> : "No GitHub organisation linked yet."}</span>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {ws.githubSyncedAt ? `Last imported ${timeAgo(ws.githubSyncedAt)}. ` : ""}Importing again adds repositories that aren't projects yet; existing projects are left alone.
          </span>
        </div>
      </div>
      {!canEdit ? (
        <span className="faint">Owners and admins can import repositories.</span>
      ) : active !== ws.id ? (
        <span className="faint">Open this workspace to import repositories into it.</span>
      ) : (
        <>
          <GithubPicker value={choice} onChange={setChoice} />
          <div className="manage__actions">
            <span className="spacer" />
            <Button variant="primary" icon={RefreshCw} disabled={!choice.org || !choice.repos.length || busy} onClick={() => void run()}>
              {busy ? "Importing…" : `Import ${choice.repos.length || ""} repositor${choice.repos.length === 1 ? "y" : "ies"}`}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------ activity

const ACTION_TEXT: Record<string, (d: Record<string, unknown>) => string> = {
  "workspace.created": () => "created the workspace",
  "workspace.updated": (d) => `updated ${Array.isArray(d.fields) ? (d.fields as string[]).join(", ") : "details"}`,
  "workspace.transferred": () => "transferred ownership",
  "members.invited": (d) => `invited ${Array.isArray(d.emails) ? (d.emails as string[]).join(", ") : "people"}`,
  "invite.revoked": () => "revoked an invitation",
  "member.joined": (d) => `joined as ${String(d.role ?? "member")}`,
  "member.left": () => "left",
  "member.removed": () => "removed a member",
  "member.role": (d) => `changed a role to ${String(d.role)}`,
  "github.imported": (d) => `imported ${String(d.repos)} repositories from ${String(d.org)}`,
  "stream.created": (d) => `created the stream ${String(d.name)}`,
  "stream.updated": (d) => `changed ${Array.isArray(d.fields) ? (d.fields as string[]).join(", ") : "settings"} of the stream ${String(d.name)}`,
  "stream.auth": (d) => `switched the stream ${String(d.name)} from ${String(d.from)} to ${String(d.to)} authentication`,
  "stream.paused": (d) => `paused the stream ${String(d.name)}`,
  "stream.resumed": (d) => `resumed the stream ${String(d.name)}`,
  "stream.deleted": (d) => `deleted the stream ${String(d.name)}`,
  "stream.rotated": (d) => `rotated the secret of the stream ${String(d.name)}`,
  "stream.revealed": (d) => `revealed the secret of the stream ${String(d.name)}`,
  "stream.revoked_previous": (d) => `stopped the previous secret of the stream ${String(d.name)}`,
  "stream.github_token": (d) => `set the GitHub token of the stream ${String(d.name)}`,
  "stream.github_token_removed": (d) => `removed the GitHub token of the stream ${String(d.name)}`,
  "stream.turnstile": (d) => `${d.set ? "set" : "removed"} the Turnstile secret of the stream ${String(d.name)}`,
  "stream.redelivered": (d) => `redelivered a submission to the stream ${String(d.name)}`,
  "stream.blocked": (d) => `blocked a sender on the stream ${String(d.name)}`,
  "stream.log_cleared": (d) => `cleared the delivery log of the stream ${String(d.name)}`,
};

function ActivityLog({ id }: { id: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["cloud", "activity", id], queryFn: () => api.cloud.request<AuditEntry[]>("GET", `/workspaces/${id}/activity`) });
  if (isLoading) return <Skeleton height={160} />;
  return (
    <div className="activity-log">
      {(data ?? []).map((a) => (
        <div key={a.id} className="activity-log__row">
          <span>
            <strong>{a.actor ?? "Someone"}</strong> {(ACTION_TEXT[a.action] ?? (() => a.action))(a.detail ?? {})}
          </span>
          <span className="faint">{timeAgo(a.at)}</span>
        </div>
      ))}
      {!data?.length && <span className="faint">Nothing yet.</span>}
    </div>
  );
}

// ------------------------------------------------------------ danger zone

function Danger({ ws, members, onDone }: { ws: Space; members: Member[]; onDone: () => void }) {
  const owner = ws.role === "owner";
  const leave = async () => {
    const ok = await confirm({ title: `Leave ${ws.name}?`, message: "You'll lose access until someone invites you again. This computer's copy of the workspace is removed.", confirmLabel: "Leave", danger: true });
    if (!ok) return;
    try {
      await api.cloud.request("POST", `/workspaces/${ws.id}/leave`);
      onDone();
      await leaveLostSpace(ws.id, await refreshMe());
      toast(`You left ${ws.name}`);
    } catch (e) {
      toastError(errorText(e, "Couldn't leave the workspace."));
    }
  };
  const remove = async () => {
    const typed = await prompt({ title: `Delete ${ws.name}?`, label: `Everything in it is deleted for all ${members.length} member${members.length === 1 ? "" : "s"}. Type the workspace name to confirm.`, confirmLabel: "Delete workspace" });
    if (typed === null) return;
    if (typed.trim() !== ws.name.trim()) return toastError("The name didn't match, so nothing was deleted.");
    try {
      await api.cloud.request("DELETE", `/workspaces/${ws.id}`);
      onDone();
      await leaveLostSpace(ws.id, await refreshMe());
      toast(`${ws.name} was deleted`);
    } catch (e) {
      toastError(errorText(e, "Couldn't delete the workspace."));
    }
  };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="danger-card">
        <div className="col grow" style={{ gap: 2 }}>
          <strong>Leave workspace</strong>
          <span className="faint">{owner ? "Transfer ownership to another member first (Members → crown)." : "Stop collaborating here. Your past work stays."}</span>
        </div>
        <Button icon={LogOut} disabled={owner} onClick={() => void leave()}>
          Leave
        </Button>
      </div>
      {owner && (
        <div className="danger-card" data-danger>
          <div className="col grow" style={{ gap: 2 }}>
            <strong>Delete workspace</strong>
            <span className="faint">Permanently deletes every project, board, task, note and whiteboard in it, for everyone. Files on people's computers aren't touched.</span>
          </div>
          <Button variant="danger" icon={Trash} onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}
