/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// Settings > Privacy & Security: the passkeys registered on this computer,
// and which projects need one. Every credential operation happens in the
// back end, which draws the operating system's own prompt - this file only
// ever sees labels and dates.

import { useQuery } from "@tanstack/react-query";
import { Fingerprint, Key, Lock, LockOpen, Pencil, Trash, TriangleAlert, Usb } from "lucide-react";
import { api, describeError } from "@/lib/ipc";
import { queryClient } from "@/lib/query";
import type { LockedProject, Passkey, PasskeyKind, Project } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { confirm, confirmDelete, prompt } from "@/components/ui/Dialog";
import { toast, toastError } from "@/stores/toast";

/** Locked content is spread across every domain, so a change clears it all. */
function refreshEverything() {
  void queryClient.invalidateQueries();
}

function when(ms: number | null) {
  if (!ms) return "never used";
  return `last used ${new Date(ms).toLocaleDateString()}`;
}

function usePasskeys() {
  const list = useQuery({ queryKey: ["passkeys"], queryFn: api.passkeys.list });
  const support = useQuery({ queryKey: ["passkeys", "support"], queryFn: api.passkeys.support });
  return { passkeys: list.data ?? [], support: support.data, loading: list.isLoading };
}

/** The list, with the two ways to add one. */
export function PasskeyList() {
  const { passkeys, support } = usePasskeys();

  const add = async (kind: PasskeyKind) => {
    const label = await prompt({
      title: kind === "platform" ? "Add Windows Hello" : "Add a security key",
      label: "Name",
      initial: kind === "platform" ? "This computer" : "Security key",
      placeholder: kind === "platform" ? "Windows will ask for your face, fingerprint or PIN" : "Insert the key, then touch it when Windows asks",
      confirmLabel: "Continue",
    });
    if (!label) return;
    try {
      await api.passkeys.register(label, kind);
      void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
      toast(`Added "${label}".`);
    } catch (e) {
      toastError(describeError(e, "Couldn't add the passkey."));
    }
  };

  const rename = async (p: Passkey) => {
    const label = await prompt({ title: "Rename passkey", label: "Name", initial: p.label, confirmLabel: "Save" });
    if (!label || label === p.label) return;
    try {
      await api.passkeys.rename(p.id, label);
      void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    } catch (e) {
      toastError(describeError(e));
    }
  };

  const remove = async (p: Passkey) => {
    const last = passkeys.length === 1;
    const ok = await confirmDelete(
      `Remove "${p.label}"?`,
      last
        ? "You'll be asked for a passkey first. It's the only one on this computer, so locked projects will open without one until you add another."
        : "You'll be asked for a passkey first.",
      "Remove",
    );
    if (!ok) return;
    try {
      await api.passkeys.remove(p.id);
      refreshEverything();
      toast(`Removed "${p.label}".`);
    } catch (e) {
      toastError(describeError(e, "Couldn't remove the passkey."));
    }
  };

  return (
    <div className="col" style={{ gap: 8, width: "100%" }}>
      {passkeys.length > 0 && (
        <div className="col" style={{ gap: 2 }}>
          {passkeys.map((p) => (
            <div key={p.id} className="list-row" style={{ minHeight: 34 }}>
              {p.kind === "platform" ? <Fingerprint strokeWidth={1.75} /> : <Usb strokeWidth={1.75} />}
              <span className="col grow" style={{ minWidth: 0 }}>
                <span className="truncate">{p.label}</span>
                <span className="faint truncate" style={{ fontSize: "var(--fs-2xs)" }}>
                  {p.kind === "platform" ? "Windows Hello" : "Security key"} · added {new Date(p.createdAt).toLocaleDateString()} · {when(p.lastUsedAt)}
                </span>
              </span>
              <div className="list-row__actions">
                <IconButton icon={Pencil} label="Rename" size="sm" onClick={() => void rename(p)} />
                <IconButton icon={Trash} label="Remove this passkey" size="sm" onClick={() => void remove(p)} />
              </div>
            </div>
          ))}
        </div>
      )}
      {passkeys.length === 0 && (
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          No passkeys on this computer. Until you add one, a project can't be locked - and a project locked on another computer opens here without asking.
        </span>
      )}
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Tooltip content={support && !support.platform ? (support.reason ?? "Unavailable on this computer") : "Face, fingerprint or PIN"}>
          <Button size="sm" icon={Fingerprint} disabled={!support?.platform} onClick={() => void add("platform")}>
            Add Windows Hello
          </Button>
        </Tooltip>
        <Tooltip content={support && !support.securityKey ? (support.reason ?? "Unavailable on this computer") : "A USB key you confirm by touching"}>
          <Button size="sm" icon={Usb} disabled={!support?.securityKey} onClick={() => void add("securityKey")}>
            Add a security key
          </Button>
        </Tooltip>
      </div>
      {support?.reason && (
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          {support.reason}
        </span>
      )}
    </div>
  );
}

/** The way out when no registered passkey can answer any more. */
export function PasskeyRecovery() {
  const { passkeys } = usePasskeys();
  if (!passkeys.length) return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Nothing to recover: no passkeys are registered.</span>;
  const reset = async () => {
    const ok = await confirm({
      title: "Forget every passkey?",
      message:
        "Every passkey on this computer is removed and every project lock is cleared, without asking for a passkey. Use this when a lost security key or a reset Windows Hello would otherwise shut you out of your own projects.",
      confirmLabel: "Forget and unlock everything",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.passkeys.reset();
      refreshEverything();
      toast("Passkeys forgotten and every project unlocked.");
    } catch (e) {
      toastError(describeError(e));
    }
  };
  return (
    <Button size="sm" variant="danger" icon={TriangleAlert} onClick={() => void reset()}>
      Forget every passkey
    </Button>
  );
}

/** Which projects need a passkey, and opening or closing them now. */
export function LockedProjects() {
  const { passkeys } = usePasskeys();
  const projects = useQuery({ queryKey: ["projects", "lockable"], queryFn: () => api.projects.list(true) });
  const locked = useQuery({ queryKey: ["passkeys", "locked"], queryFn: api.passkeys.locked });
  const lockedById = new Map<string, LockedProject>((locked.data ?? []).map((l) => [l.id, l]));
  const rows = (projects.data ?? []).filter((p) => !p.deletedAt);

  const setLocked = async (p: Project, on: boolean) => {
    try {
      await api.passkeys.setLocked(p.id, on);
      refreshEverything();
    } catch (e) {
      toastError(describeError(e, on ? "Couldn't lock the project." : "Couldn't unlock the project."));
    }
  };

  const unlock = async (p: LockedProject) => {
    try {
      await api.passkeys.unlock(p.id);
      refreshEverything();
    } catch (e) {
      toastError(describeError(e, "Couldn't open the project."));
    }
  };

  const relock = async (id?: string) => {
    try {
      await api.passkeys.relock(id);
      refreshEverything();
    } catch (e) {
      toastError(describeError(e));
    }
  };

  if (!rows.length) return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No projects yet.</span>;

  return (
    <div className="col" style={{ gap: 8, width: "100%" }}>
      <div className="col" style={{ gap: 2 }}>
        {rows.map((p) => {
          const lock = lockedById.get(p.id);
          return (
            <div key={p.id} className="list-row" style={{ minHeight: 34 }}>
              {lock ? lock.unlocked ? <LockOpen strokeWidth={1.75} /> : <Lock strokeWidth={1.75} /> : <Key strokeWidth={1.75} className="faint" />}
              <span className="col grow" style={{ minWidth: 0 }}>
                <span className="truncate">{p.name}</span>
                {lock && (
                  <span className="faint truncate" style={{ fontSize: "var(--fs-2xs)" }}>
                    {lock.unlocked ? "open until Kern closes or you lock it" : "locked"}
                    {!passkeys.length && " · not enforced here, no passkey on this computer"}
                  </span>
                )}
              </span>
              <div className="list-row__actions">
                {lock?.unlocked && <IconButton icon={Lock} label="Lock now" size="sm" onClick={() => void relock(p.id)} />}
                {lock && !lock.unlocked && passkeys.length > 0 && (
                  <IconButton icon={LockOpen} label="Open with a passkey" size="sm" onClick={() => void unlock(lock)} />
                )}
              </div>
              <Tooltip content={lock ? "Stop requiring a passkey" : "Require a passkey to open this project"}>
                <Switch
                  checked={!!lock}
                  disabled={!passkeys.length && !lock}
                  onChange={(v) => void setLocked(p, v)}
                  label={`Require a passkey for ${p.name}`}
                />
              </Tooltip>
            </div>
          );
        })}
      </div>
      {(locked.data ?? []).some((l) => l.unlocked) && (
        <div className="row">
          <Button size="sm" icon={Lock} onClick={() => void relock()}>
            Lock every project now
          </Button>
        </div>
      )}
    </div>
  );
}
