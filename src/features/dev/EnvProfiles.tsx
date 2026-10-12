// Environment profiles: named sets of variables given to commands and
// terminals Kern starts (never to the system). Secret values live in the
// OS credential store, show masked, and are only revealed on request.

import { Copy, Download, Ellipsis, Eye, EyeOff, KeyRound, Pencil, Plus, Trash, Upload, X, Check, CopyPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { EnvProfile, EnvVar, Project } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { Dialog, confirmDelete, prompt } from "@/components/ui/Dialog";
import { Checkbox, Select, Skeleton } from "@/components/ui/Controls";
import { copyText } from "@/features/projects/folders";
import { useEnvProfiles } from "./hooks";

const refresh = () => invalidate("env", "capabilities");
const KIND_LABEL: Record<EnvVar["kind"], string> = { plain: "Value", secret: "Secret", inherit: "From system" };

export function EnvProfilesSection({ project }: { project: Project }) {
  const { data: profiles, isLoading } = useEnvProfiles(project.id);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const active = profiles?.find((p) => p.id === activeId) ?? profiles?.[0];

  const createProfile = async (name?: string) => {
    const n = name ?? (await prompt({ title: "New environment profile", placeholder: "Development, Testing, Staging…", confirmLabel: "Create" }));
    if (!n) return;
    try {
      const p = await api.env.createProfile(project.id, n);
      refresh();
      setActiveId(p.id);
    } catch (e) {
      toastError(describeError(e));
    }
  };

  if (isLoading) return <Skeleton height={60} />;
  if (!profiles?.length)
    return (
      <div className="col" style={{ gap: 8 }}>
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          Keep the variables your commands need - ports, URLs, API keys - in named profiles. Secrets are stored in your system's credential store, never in Kern's database or backups.
        </span>
        <div className="row" style={{ gap: 6 }}>
          {["Development", "Testing", "Staging"].map((n) => (
            <Button key={n} size="sm" icon={Plus} onClick={() => void createProfile(n)}>
              {n}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => void createProfile()}>
            Custom…
          </Button>
        </div>
      </div>
    );

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
        {profiles.map((p) => (
          <button key={p.id} type="button" className="chip chip-btn env-tab" data-on={p.id === active?.id || undefined} onClick={() => setActiveId(p.id)}>
            {p.name} <span className="faint">{p.variables.length}</span>
          </button>
        ))}
        <IconButton icon={Plus} label="New profile" size="sm" onClick={() => void createProfile()} />
        <span className="spacer" />
        {active && (
          <Dropdown
            align="end"
            items={[
              {
                label: "Rename…",
                icon: Pencil,
                onSelect: async () => {
                  const n = await prompt({ title: "Rename profile", initial: active.name });
                  if (n) await api.env.renameProfile(active.id, n).then(refresh).catch((e) => toastError(describeError(e)));
                },
              },
              { label: "Duplicate", icon: CopyPlus, onSelect: () => void api.env.duplicateProfile(active.id).then((p) => (refresh(), setActiveId(p.id))).catch((e) => toastError(describeError(e))) },
              { type: "separator" },
              {
                label: "Import a .env file…",
                icon: Upload,
                onSelect: async () => {
                  const f = await openDialog({ title: "Import environment variables", multiple: false });
                  if (typeof f === "string") setImporting(f);
                },
              },
              { label: "Export as .env…", icon: Download, onSelect: () => setExporting(true) },
              { type: "separator" },
              {
                label: "Delete profile",
                icon: Trash,
                danger: true,
                onSelect: async () => {
                  if (!(await confirmDelete(`Delete “${active.name}”?`, "Its variables and stored secrets are removed. Commands using it run without it."))) return;
                  await api.env.deleteProfile(active.id).catch((e) => toastError(describeError(e)));
                  refresh();
                  setActiveId(null);
                },
              },
            ]}
          >
            <IconButton icon={Ellipsis} label="Profile actions" size="sm" noTooltip />
          </Dropdown>
        )}
      </div>
      {active && <VarTable profile={active} />}
      {importing && active && <ImportDialog profile={active} path={importing} onClose={() => setImporting(null)} />}
      {exporting && active && <ExportDialog profile={active} onClose={() => setExporting(false)} />}
    </div>
  );
}

function VarTable({ profile }: { profile: EnvProfile }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  return (
    <div className="env-table" role="table" aria-label={`${profile.name} variables`}>
      <div className="env-row env-row--head" role="row">
        <span>Name</span>
        <span>Value</span>
        <span>Type</span>
        <span />
      </div>
      {profile.variables.map((v) =>
        editing === v.id ? (
          <VarEditor key={v.id} profile={profile} v={v} onDone={() => setEditing(null)} />
        ) : (
          <VarRow key={v.id} profile={profile} v={v} onEdit={() => setEditing(v.id)} />
        ),
      )}
      {editing === "new" ? (
        <VarEditor profile={profile} onDone={() => setEditing(null)} />
      ) : (
        <button type="button" className="env-add" onClick={() => setEditing("new")}>
          <Plus size={13} /> Add variable
        </button>
      )}
    </div>
  );
}

function VarRow({ profile, v, onEdit }: { profile: EnvProfile; v: EnvVar; onEdit: () => void }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  useEffect(() => {
    if (revealed === null) return;
    const t = window.setTimeout(() => setRevealed(null), 20_000);
    return () => window.clearTimeout(t);
  }, [revealed]);
  const value =
    v.kind === "secret" ? (revealed ?? "••••••••••") : v.kind === "inherit" ? `$${v.value}` : v.value || <span className="faint">(empty)</span>;
  return (
    <div className="env-row" role="row">
      <span className="mono truncate">{v.name}</span>
      <span className="mono truncate selectable env-value" data-secret={v.kind === "secret" || undefined}>
        {value}
      </span>
      <span className="faint row" style={{ gap: 4 }}>
        {v.kind === "secret" && <KeyRound size={12} />}
        {KIND_LABEL[v.kind]}
      </span>
      <span className="row env-actions">
        {v.kind === "secret" && (
          <IconButton
            icon={revealed !== null ? EyeOff : Eye}
            label={revealed !== null ? "Hide" : "Reveal"}
            size="sm"
            onClick={async () => {
              if (revealed !== null) return setRevealed(null);
              try {
                setRevealed(await api.env.reveal(v.id));
              } catch (e) {
                toastError(describeError(e));
              }
            }}
          />
        )}
        <Dropdown
          align="end"
          items={[
            { label: "Edit", icon: Pencil, onSelect: onEdit },
            { label: "Copy name", icon: Copy, onSelect: () => void copyText(v.name, "Name") },
            {
              label: "Duplicate",
              icon: CopyPlus,
              onSelect: async () => {
                const value = v.kind === "secret" ? await api.env.reveal(v.id).catch(() => null) : v.value;
                if (v.kind === "secret" && value === null) return;
                await api.env.setVar({ profileId: profile.id, name: `${v.name}_COPY`, kind: v.kind, value }).then(refresh).catch((e) => toastError(describeError(e)));
              },
            },
            { type: "separator" },
            { label: "Remove", icon: Trash, danger: true, onSelect: () => void api.env.deleteVar(v.id).then(refresh).catch((e) => toastError(describeError(e))) },
          ]}
        >
          <IconButton icon={Ellipsis} label="Variable actions" size="sm" noTooltip />
        </Dropdown>
      </span>
    </div>
  );
}

function VarEditor({ profile, v, onDone }: { profile: EnvProfile; v?: EnvVar; onDone: () => void }) {
  const [name, setName] = useState(v?.name ?? "");
  const [kind, setKind] = useState<EnvVar["kind"]>(v?.kind ?? "plain");
  const [value, setValue] = useState(v?.kind === "secret" ? "" : (v?.value ?? ""));
  const save = async () => {
    try {
      // An empty secret field while editing keeps the stored value.
      await api.env.setVar({ profileId: profile.id, id: v?.id ?? null, name: name.trim(), kind, value: kind === "secret" && v?.kind === "secret" && !value ? null : value });
      refresh();
      onDone();
    } catch (e) {
      toastError(describeError(e, "Couldn't save the variable."));
    }
  };
  return (
    <div className="env-row env-row--edit" role="row" onKeyDown={(e) => (e.key === "Enter" ? void save() : e.key === "Escape" && onDone())}>
      <input className="input input--sm mono" autoFocus value={name} placeholder="NAME" onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} aria-label="Variable name" />
      <input
        className="input input--sm mono"
        type={kind === "secret" ? "password" : "text"}
        value={value}
        placeholder={kind === "inherit" ? "SYSTEM_VARIABLE" : kind === "secret" && v?.kind === "secret" ? "(unchanged)" : "value"}
        onChange={(e) => setValue(e.target.value)}
        aria-label="Value"
        autoComplete="off"
      />
      <Select
        value={kind}
        onChange={setKind}
        ariaLabel="Type"
        options={[
          { value: "plain", label: "Value" },
          { value: "secret", label: "Secret" },
          { value: "inherit", label: "From system" },
        ]}
      />
      <span className="row env-actions">
        <IconButton icon={Check} label="Save" size="sm" onClick={() => void save()} />
        <IconButton icon={X} label="Cancel" size="sm" onClick={onDone} />
      </span>
    </div>
  );
}

function ImportDialog({ profile, path, onClose }: { profile: EnvProfile; path: string; onClose: () => void }) {
  const [mode, setMode] = useState<"auto" | "all" | "none">("auto");
  const [overwrite, setOverwrite] = useState(false);
  const run = async () => {
    try {
      const r = await api.env.import(profile.id, path, { autoSecret: mode === "auto", allSecret: mode === "all", overwrite });
      refresh();
      toast(`Imported ${r.added + r.updated} variable${r.added + r.updated === 1 ? "" : "s"}${r.secrets ? ` (${r.secrets} as secrets)` : ""}${r.skipped ? `, kept ${r.skipped} existing` : ""}.`);
      onClose();
    } catch (e) {
      toastError(describeError(e, "Couldn't import the file."));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Import into ${profile.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()}>
            Import
          </Button>
        </>
      }
    >
      <p className="dialog__desc">
        <span className="mono selectable">{path}</span>
        <br />
        .env files often contain passwords and keys. Kern reads the file once; it isn't changed or moved.
      </p>
      <Select
        value={mode}
        onChange={setMode}
        ariaLabel="Secrets"
        options={[
          { value: "auto", label: "Store values that look like credentials as secrets (recommended)" },
          { value: "all", label: "Store every value as a secret" },
          { value: "none", label: "Store everything as plain values" },
        ]}
      />
      <label className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
        <Checkbox checked={overwrite} onChange={setOverwrite} label="Replace variables that already exist" /> Replace variables that already exist
      </label>
    </Dialog>
  );
}

function ExportDialog({ profile, onClose }: { profile: EnvProfile; onClose: () => void }) {
  const [secrets, setSecrets] = useState(false);
  const hasSecrets = profile.variables.some((v) => v.kind === "secret");
  const run = async () => {
    const path = await saveDialog({ title: "Export environment variables", defaultPath: ".env" });
    if (!path) return;
    try {
      // The system save dialog already confirmed any overwrite.
      const n = await api.env.export(profile.id, path, secrets, true);
      toast(`Exported ${n} variable${n === 1 ? "" : "s"}`);
      onClose();
    } catch (e) {
      toastError(describeError(e, "Couldn't export."));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Export ${profile.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={secrets ? "danger" : "primary"} onClick={() => void run()}>
            Choose file…
          </Button>
        </>
      }
    >
      <p className="dialog__desc">Writes a .env file. Make sure it's listed in your .gitignore - Kern never commits files.</p>
      {hasSecrets && (
        <label className="row danger-check" style={{ gap: 8 }}>
          <Checkbox checked={secrets} onChange={setSecrets} label="Include secret values" />
          <span>Include secret values in plain text. Anyone who can read the file will see them.</span>
        </label>
      )}
    </Dialog>
  );
}
