// Settings → Integrations: GitHub sign-in, sync behaviour and git.

import { CircleAlert, CircleCheck, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Controls";
import { confirm } from "@/components/ui/Dialog";
import { toast, toastError } from "@/stores/toast";
import { SSegmented, SToggle } from "@/features/settings/controls";
import { GithubMark, importFromGithub, useGithubStatus } from "./shared";

function Row({ label, hint, children }: { label: string; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row__text">
        <span className="set-row__label">{label}</span>
        {hint && <span className="set-row__hint">{hint}</span>}
      </div>
      {children && <div className="set-row__control">{children}</div>}
    </div>
  );
}

function TokenEditor({ hasToken }: { hasToken: boolean }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const login = await api.github.setToken(token);
      setToken("");
      toast(`Token saved for ${login}`);
      invalidate("github");
    } catch (e) {
      toastError(describeError(e, "GitHub didn't accept that token."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 6, width: "100%" }}>
      <div className="row" style={{ gap: 6 }}>
        <input
          className="input mono grow"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={hasToken ? "Replace the saved token" : "github_pat_…"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-label="GitHub token"
        />
        <Button size="sm" disabled={!token.trim() || busy} onClick={() => void save()}>
          {busy ? "Checking…" : "Save token"}
        </Button>
        {hasToken && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              if (!(await confirm({ title: "Remove the saved GitHub token?", message: "It's deleted from the system credential store.", confirmLabel: "Remove", danger: true }))) return;
              await api.github.clearToken().catch((e) => toastError(describeError(e)));
              invalidate("github");
            }}
          >
            Remove
          </Button>
        )}
      </div>
      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        Create a fine-grained token on github.com → Settings → Developer settings, with access to your repositories and permissions Issues: read &amp; write, Pull requests: read, Contents: read. It's stored in the system credential store, never in Kern's database.
      </span>
    </div>
  );
}

export function IntegrationsSection() {
  const { data: st, isLoading, refetch, isFetching } = useGithubStatus();
  const { data: gitVersion } = useQuery({ queryKey: ["git", "version"], queryFn: api.git.available, staleTime: Infinity });
  return (
    <div className="col" style={{ gap: 20 }}>
      <section>
        <div className="set-group__title row" style={{ gap: 6 }}>
          <GithubMark /> GitHub
        </div>
        <div className="set-group">
          <Row
            label="Connection"
            hint={
              isLoading ? (
                "Checking…"
              ) : st?.connected ? (
                <span className="row" style={{ gap: 6 }}>
                  <CircleCheck size={13} /> Signed in as {st.login} via {st.source === "cli" ? "the GitHub CLI" : "a saved token"}
                </span>
              ) : (
                <span className="row" style={{ gap: 6 }}>
                  <CircleAlert size={13} /> {st?.error ?? "Not connected"}
                </span>
              )
            }
          >
            <Button size="sm" icon={RefreshCw} className={isFetching ? "spin" : undefined} onClick={() => void refetch()}>
              Check
            </Button>
          </Row>
          <Row
            label="Sign in with"
            hint={`Automatic uses the GitHub CLI's login when it's signed in (${st ? (st.cliSignedIn ? "it is" : st.cliInstalled ? "installed, not signed in" : "not installed") : "…"}), otherwise the saved token.`}
          >
            <SSegmented
              k="github.auth"
              options={[
                { value: "auto", label: "Automatic" },
                { value: "cli", label: "GitHub CLI" },
                { value: "token", label: "Token" },
              ]}
            />
          </Row>
          <div className="set-row" style={{ flexWrap: "wrap" }}>
            <div className="set-row__text">
              <span className="set-row__label">Personal access token</span>
            </div>
            <div style={{ flexBasis: "100%", minWidth: 0 }}>{isLoading ? <Skeleton height={30} /> : <TokenEditor hasToken={!!st?.hasToken} />}</div>
          </div>
          <Row label="Sync issues when opening a project" hint="Connected projects pull new and changed issues when you open them (at most every 10 minutes). Kern never syncs in the background otherwise.">
            <SToggle k="github.autoSync" />
          </Row>
          <Row label="Update issues when tasks change" hint="Completing, reopening or editing a linked task updates its GitHub issue straight away.">
            <SToggle k="github.pushOnEdit" />
          </Row>
          <Row label="Import a project from GitHub" hint="Creates a project, connects the repository, optionally clones it, and imports its issues as tasks.">
            <Button size="sm" disabled={!st?.connected} onClick={() => void importFromGithub()}>
              Import…
            </Button>
          </Row>
        </div>
      </section>
      <section>
        <div className="set-group__title">Git</div>
        <div className="set-group">
          <Row label="Git" hint="Git tools in projects use the git installed on this computer, in trusted folders only.">
            <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
              {gitVersion === undefined ? "Checking…" : (gitVersion ?? "Not found - install Git to use git tools")}
            </span>
          </Row>
        </div>
      </section>
    </div>
  );
}
