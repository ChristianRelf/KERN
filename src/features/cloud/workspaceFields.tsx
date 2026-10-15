/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// Workspace detail fields shared by creation and management: logo, name,
// ID, description, purpose, industry, team size, website, time zone and
// colour; plus the email invite editor and the GitHub organisation picker.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleAlert, ImagePlus, Loader, Trash, X } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import type { RepoSummary, SpaceRole, TeamSize } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Checkbox, Select, Segmented, Skeleton, Switch } from "@/components/ui/Controls";
import { AppearancePicker } from "@/features/projects/AppearancePicker";
import { GithubMark, useGithubStatus } from "@/features/github/shared";
import { navigate } from "@/stores/router";
import { processLogo, ROLE_HINT, ROLE_LABEL, SpaceLogo } from "./ui";

export interface WorkspaceDraft {
  name: string;
  slug: string;
  description: string;
  logo: string | null;
  accent: string | null;
  /** Lucide icon key or "emoji:…" for the mark when there's no logo (settings.icon). */
  icon: string | null;
  /** Tint the interface with the workspace colour while it's open (settings.tint). */
  tint: boolean;
  website: string;
  industry: string;
  teamSize: TeamSize | null;
  useCase: string;
  timezone: string;
}

export const USE_CASES = [
  "Software development",
  "Product & design",
  "Marketing & content",
  "Agency & clients",
  "Operations",
  "Research",
  "Education",
  "Community & open source",
  "Personal projects",
  "Something else",
];

export const INDUSTRIES = [
  "Technology",
  "Finance",
  "Healthcare",
  "Education",
  "Media & entertainment",
  "Retail & e-commerce",
  "Manufacturing",
  "Government & non-profit",
  "Consulting & services",
  "Other",
];

export const TEAM_SIZES: { value: TeamSize; label: string }[] = [
  { value: "just-me", label: "Just me" },
  { value: "2-10", label: "2–10" },
  { value: "11-50", label: "11–50" },
  { value: "51-200", label: "51–200" },
  { value: "201-1000", label: "201–1k" },
  { value: "1000+", label: "1k+" },
];

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function timeZones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [localTimeZone()];
  } catch {
    return [localTimeZone()];
  }
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export function LogoPicker({ name, logo, accent, icon, onChange }: { name: string; logo: string | null; accent: string | null; icon?: string | null; onChange: (logo: string | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const take = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      onChange(await processLogo(file));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="logo-picker">
      <label
        className="logo-picker__drop"
        data-drag={drag || undefined}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void take(e.dataTransfer.files[0]);
        }}
      >
        <SpaceLogo name={name || "?"} logo={logo} accent={accent} icon={icon} size={64} />
        <span className="logo-picker__overlay">
          <ImagePlus size={16} />
        </span>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden onChange={(e) => void take(e.target.files?.[0])} />
      </label>
      <div className="col" style={{ gap: 4 }}>
        <span className="field__label">Logo</span>
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Click or drop an image. It's cropped to a square and resized. Without one, the first letter is used.
        </span>
        {logo && (
          <Button size="sm" variant="ghost" icon={Trash} onClick={() => onChange(null)} style={{ alignSelf: "flex-start" }}>
            Remove logo
          </Button>
        )}
        {error && <span className="field-error">{error}</span>}
      </div>
    </div>
  );
}

/** Checks a workspace ID with the server (debounced). */
function useSlugCheck(slug: string, current?: string | null) {
  const [state, setState] = useState<{ status: "idle" | "checking" | "ok" | "taken" | "invalid"; suggestion?: string }>({ status: "idle" });
  useEffect(() => {
    if (!slug || slug === current) return setState({ status: "idle" });
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug) || slug.length < 3) return setState({ status: "invalid" });
    setState({ status: "checking" });
    const t = window.setTimeout(() => {
      api.cloud
        .request<{ available: boolean; suggestion: string }>("GET", `/workspaces/slug-available?slug=${encodeURIComponent(slug)}`)
        .then((r) => setState({ status: r.available ? "ok" : "taken", suggestion: r.suggestion }))
        .catch(() => setState({ status: "idle" }));
    }, 350);
    return () => window.clearTimeout(t);
  }, [slug, current]);
  return state;
}

export function BasicsFields({ draft, set, currentSlug }: { draft: WorkspaceDraft; set: (p: Partial<WorkspaceDraft>) => void; currentSlug?: string | null }) {
  const check = useSlugCheck(draft.slug, currentSlug);
  return (
    <div className="col" style={{ gap: 14 }}>
      <LogoPicker name={draft.name} logo={draft.logo} accent={draft.accent} icon={draft.icon} onChange={(logo) => set({ logo })} />
      <div className="field">
        <label className="field__label">Workspace name</label>
        <input
          className="input"
          autoFocus
          maxLength={80}
          value={draft.name}
          placeholder="e.g. Relf Labs"
          onChange={(e) => {
            const name = e.target.value;
            const auto = !draft.slug || draft.slug === slugify(draft.name);
            set(auto && !currentSlug ? { name, slug: slugify(name) } : { name });
          }}
        />
      </div>
      <div className="field">
        <label className="field__label">Workspace ID</label>
        <div className="input-wrap">
          <span className="faint mono" style={{ paddingLeft: 8, fontSize: "var(--fs-sm)" }}>
            kern/
          </span>
          <input className="input input--bare grow mono" maxLength={40} value={draft.slug} onChange={(e) => set({ slug: slugify(e.target.value) })} spellCheck={false} />
          <span className="slug-state" data-state={check.status}>
            {check.status === "checking" && <Loader size={13} className="spin" />}
            {check.status === "ok" && <Check size={13} />}
            {(check.status === "taken" || check.status === "invalid") && <CircleAlert size={13} />}
          </span>
        </div>
        <span className="field__hint">
          {check.status === "taken" ? (
            <>
              Taken.{" "}
              <button type="button" className="auth__link" onClick={() => set({ slug: check.suggestion ?? "" })}>
                Use {check.suggestion}
              </button>
            </>
          ) : check.status === "invalid" ? (
            "At least 3 characters: lowercase letters, numbers and dashes."
          ) : (
            "A short, unique name for this workspace. You can change it later."
          )}
        </span>
      </div>
      <div className="field">
        <label className="field__label">Description</label>
        <textarea className="textarea" rows={3} maxLength={500} value={draft.description} placeholder="What does this team work on?" onChange={(e) => set({ description: e.target.value })} />
        <span className="field__hint">{draft.description.length}/500</span>
      </div>
    </div>
  );
}

export function AboutFields({ draft, set }: { draft: WorkspaceDraft; set: (p: Partial<WorkspaceDraft>) => void }) {
  const zones = useMemo(timeZones, []);
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="field">
        <label className="field__label">What will you use it for?</label>
        <div className="chip-grid">
          {USE_CASES.map((u) => (
            <button key={u} type="button" className="choice-chip" data-on={draft.useCase === u || undefined} onClick={() => set({ useCase: draft.useCase === u ? "" : u })}>
              {u}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label className="field__label">Team size</label>
        <Segmented<TeamSize> size="sm" value={draft.teamSize ?? ("" as TeamSize)} onChange={(teamSize) => set({ teamSize })} options={TEAM_SIZES} ariaLabel="Team size" />
      </div>
      <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
        <div className="field grow">
          <label className="field__label">Industry</label>
          <Select<string> value={draft.industry} onChange={(industry) => set({ industry })} options={INDUSTRIES.map((i) => ({ value: i, label: i }))} placeholder="Choose…" ariaLabel="Industry" />
        </div>
        <div className="field grow">
          <label className="field__label">Time zone</label>
          <input className="input" list="kern-timezones" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} spellCheck={false} />
          <datalist id="kern-timezones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="field">
        <label className="field__label">Website</label>
        <input className="input" type="url" placeholder="https://" value={draft.website} onChange={(e) => set({ website: e.target.value })} spellCheck={false} />
      </div>
      <div className="field">
        <label className="field__label">Mark & colour</label>
        <AppearancePicker icon={draft.icon} accent={draft.accent} name={draft.name} onChange={(c) => set(c)} />
        <span className="field__hint">The icon or emoji is shown when there's no logo. The colour is used for the mark and the tint below.</span>
      </div>
      <label className="row tint-option">
        <Switch checked={draft.tint && !!draft.accent} disabled={!draft.accent} onChange={(tint) => set({ tint })} label="Tint Kern with the workspace colour" />
        <span className="col">
          <span>Tint Kern with this colour</span>
          <span className="field__hint">{draft.accent ? "While this workspace is open, buttons and highlights use its colour - for everyone in it." : "Choose a colour first."}</span>
        </span>
      </label>
    </div>
  );
}

export const validWebsite = (w: string) => !w.trim() || /^https?:\/\/[^\s.]+\.[^\s]+$/i.test(w.trim());

// ------------------------------------------------------------ invites

export interface InviteDraft {
  email: string;
  role: Exclude<SpaceRole, "owner">;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteEditor({ invites, onChange, message, onMessage, selfEmail }: { invites: InviteDraft[]; onChange: (v: InviteDraft[]) => void; message: string; onMessage: (m: string) => void; selfEmail?: string }) {
  const [text, setText] = useState("");
  const [role, setRole] = useState<InviteDraft["role"]>("member");
  const [error, setError] = useState<string | null>(null);
  const add = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((p) => p.trim().replace(/^<|>$/g, "")).filter(Boolean);
    if (!parts.length) return;
    const bad = parts.filter((p) => !EMAIL.test(p));
    const next = [...invites];
    for (const p of parts.filter((x) => EMAIL.test(x))) {
      const email = p.toLowerCase();
      if (email === selfEmail?.toLowerCase() || next.some((i) => i.email === email)) continue;
      next.push({ email, role });
    }
    onChange(next.slice(0, 50));
    setError(bad.length ? `Not an email address: ${bad.join(", ")}` : null);
    setText(bad.join(" "));
  };
  const roleOptions = (["admin", "member", "viewer"] as const).map((r) => ({ value: r, label: ROLE_LABEL[r] }));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="field">
        <label className="field__label">Email addresses</label>
        <div className="row" style={{ gap: 6 }}>
          <input
            className="input grow"
            value={text}
            placeholder="name@company.com, another@company.com"
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              add(text + " " + e.clipboardData.getData("text"));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "," || e.key === " ") {
                e.preventDefault();
                add(text);
              } else if (e.key === "Backspace" && !text && invites.length) onChange(invites.slice(0, -1));
            }}
            onBlur={() => text.trim() && add(text)}
          />
          <Select value={role} onChange={setRole} options={roleOptions} ariaLabel="Role for new invitations" style={{ width: 110 }} />
          <Button size="sm" onClick={() => add(text)} disabled={!text.trim()}>
            Add
          </Button>
        </div>
        <span className="field__hint">{error ? <span className="field-error">{error}</span> : `Paste a list or press Enter after each address. ${ROLE_LABEL[role]}s: ${ROLE_HINT[role].toLowerCase()}.`}</span>
      </div>
      {invites.length > 0 && (
        <div className="invite-list">
          {invites.map((inv, i) => (
            <div key={inv.email} className="invite-list__row">
              <span className="truncate grow">{inv.email}</span>
              <Select
                value={inv.role}
                onChange={(r) => onChange(invites.map((x, j) => (j === i ? { ...x, role: r } : x)))}
                options={roleOptions}
                ariaLabel={`Role for ${inv.email}`}
                style={{ width: 110 }}
              />
              <IconButton icon={X} label={`Remove ${inv.email}`} size="sm" onClick={() => onChange(invites.filter((_, j) => j !== i))} />
            </div>
          ))}
        </div>
      )}
      <div className="field">
        <label className="field__label">Personal message (optional)</label>
        <textarea className="textarea" rows={2} maxLength={500} value={message} onChange={(e) => onMessage(e.target.value)} placeholder="Added to the invitation email" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------ GitHub

export interface GithubChoice {
  org: string | null;
  repos: RepoSummary[];
  syncIssues: boolean;
}

/** Pick a GitHub organisation; its repositories become projects. */
export function GithubPicker({ value, onChange }: { value: GithubChoice; onChange: (v: GithubChoice) => void }) {
  const { data: status, isLoading } = useGithubStatus();
  const orgs = useQuery({ queryKey: ["github", "orgs"], queryFn: api.github.orgs, enabled: !!status?.connected, staleTime: 5 * 60_000, retry: false });
  const repos = useQuery({ queryKey: ["github", "org-repos", value.org], queryFn: () => api.github.orgRepos(value.org!), enabled: !!value.org, staleTime: 5 * 60_000, retry: false });
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const visible = useMemo(
    () => (repos.data ?? []).filter((r) => (showArchived || !r.archived) && (!filter || r.fullName.toLowerCase().includes(filter.toLowerCase()))),
    [repos.data, showArchived, filter],
  );
  // Select every active repository when an organisation loads.
  useEffect(() => {
    if (repos.data && value.org) onChange({ ...value, repos: repos.data.filter((r) => !r.archived && !r.fork) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.data]);

  if (isLoading) return <Skeleton height={80} />;
  if (!status?.connected)
    return (
      <div className="cloud-callout">
        <GithubMark size={18} />
        <div className="col" style={{ gap: 6 }}>
          <span>Connect GitHub to bring in an organisation's repositories as projects.</span>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            Kern uses the GitHub CLI's login or a token from Settings → Integrations. You can skip this and import later from workspace settings.
          </span>
          <Button size="sm" onClick={() => navigate({ name: "settings", section: "integrations" })} style={{ alignSelf: "flex-start" }}>
            Open Integrations
          </Button>
        </div>
      </div>
    );
  const selected = new Set(value.repos.map((r) => r.fullName));
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="field">
        <label className="field__label">Organisation</label>
        {orgs.isLoading ? (
          <Skeleton height={34} />
        ) : orgs.isError ? (
          <span className="field-error">{describeError(orgs.error, "Couldn't load your GitHub organisations.")}</span>
        ) : (
          <div className="org-grid">
            {(orgs.data ?? []).map((o) => (
              <button key={o.login} type="button" className="org-card" data-on={value.org === o.login || undefined} onClick={() => onChange({ ...value, org: value.org === o.login ? null : o.login, repos: [] })}>
                {o.avatarUrl ? <span className="org-card__avatar" style={{ backgroundImage: `url(${o.avatarUrl})` }} /> : <GithubMark size={16} />}
                <span className="col" style={{ minWidth: 0, alignItems: "flex-start" }}>
                  <span className="truncate">{o.login}</span>
                  <span className="faint truncate" style={{ fontSize: "var(--fs-2xs)" }}>
                    {o.personal ? "Your repositories" : (o.description ?? "Organisation")}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {value.org && (
        <div className="field">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <label className="field__label">
              Repositories · {value.repos.length} of {repos.data?.length ?? "…"} selected
            </label>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="auth__link" onClick={() => onChange({ ...value, repos: visible })}>
                All
              </button>
              <button type="button" className="auth__link" onClick={() => onChange({ ...value, repos: [] })}>
                None
              </button>
            </div>
          </div>
          <input className="input" placeholder="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {repos.isLoading ? (
            <Skeleton height={120} />
          ) : repos.isError ? (
            <span className="field-error">{describeError(repos.error, "Couldn't load the repositories.")}</span>
          ) : (
            <div className="repo-pick">
              {visible.map((r) => (
                <label key={r.fullName} className="repo-pick__row">
                  <Checkbox
                    checked={selected.has(r.fullName)}
                    onChange={(on) => onChange({ ...value, repos: on ? [...value.repos, r] : value.repos.filter((x) => x.fullName !== r.fullName) })}
                    label={r.fullName}
                  />
                  <span className="col grow" style={{ minWidth: 0 }}>
                    <span className="truncate">
                      {r.fullName.split("/")[1]}
                      {r.private && <span className="chip chip--outline" style={{ marginLeft: 6 }}>Private</span>}
                      {r.archived && <span className="chip chip--outline" style={{ marginLeft: 6 }}>Archived</span>}
                      {r.fork && <span className="chip chip--outline" style={{ marginLeft: 6 }}>Fork</span>}
                    </span>
                    {r.description && <span className="faint truncate" style={{ fontSize: "var(--fs-xs)" }}>{r.description}</span>}
                  </span>
                  {r.language && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{r.language}</span>}
                </label>
              ))}
              {!visible.length && <span className="faint" style={{ padding: 8 }}>No repositories match.</span>}
            </div>
          )}
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <label className="row" style={{ gap: 8 }}>
              <Switch checked={value.syncIssues} onChange={(syncIssues) => onChange({ ...value, syncIssues })} label="Sync issues as tasks" />
              <span>Sync issues as tasks</span>
            </label>
            <label className="row" style={{ gap: 8 }}>
              <Switch checked={showArchived} onChange={setShowArchived} label="Show archived" />
              <span>Show archived</span>
            </label>
          </div>
          <span className="field__hint">Each repository becomes a project linked to GitHub. Code and files stay on each person's computer; clone or link folders per device.</span>
        </div>
      )}
    </div>
  );
}
