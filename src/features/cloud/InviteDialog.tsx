/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// An invitation opened from a link (kern://invite/<id>) or the pending
// list: shows the workspace, then signs in (if needed) and joins.

import { useQuery } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { api } from "@/lib/ipc";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Controls";
import { errorText, openAuth, useCloud } from "./store";
import { acceptInvite, declineInvite } from "./actions";
import { ROLE_HINT, ROLE_LABEL, SpaceLogo } from "./ui";

export function InviteDialog() {
  const id = useCloud((s) => s.inviteId);
  return id ? <Invite key={id} id={id} /> : null;
}

function Invite({ id }: { id: string }) {
  const info = useCloud((s) => s.info);
  const { data, isLoading, isError, error } = useQuery({ queryKey: ["cloud", "invite", id], queryFn: () => api.cloud.inviteInfo(id), retry: false });
  const close = () => useCloud.setState({ inviteId: null });
  const signedIn = !!info?.signedIn;

  const join = async () => {
    if (!signedIn) {
      openAuth({ reason: `Sign in with the email the invitation was sent to (${data?.emailHint ?? "your email"}) to join ${data?.workspace ?? "the workspace"}.`, then: () => useCloud.setState({ inviteId: id }) });
      close();
      return;
    }
    if (await acceptInvite(id)) close();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()} centered title={<span className="row" style={{ gap: 8 }}><Mail size={16} strokeWidth={1.75} /> Workspace invitation</span>}>
      {isLoading ? (
        <Skeleton height={140} />
      ) : isError || !data ? (
        <div className="col" style={{ gap: 12 }}>
          <span className="field-error">{errorText(error, "That invitation wasn't found.")}</span>
          <Button onClick={close}>Close</Button>
        </div>
      ) : (
        <div className="col" style={{ gap: 14, alignItems: "center", textAlign: "center" }}>
          <SpaceLogo name={data.workspace} logo={data.logo} size={56} />
          <div className="col" style={{ gap: 4 }}>
            <strong style={{ fontSize: "var(--fs-lg)" }}>Join {data.workspace}</strong>
            <span className="muted">
              {data.inviterName ? `${data.inviterName} invited you` : "You've been invited"} as <strong>{ROLE_LABEL[data.role].toLowerCase()}</strong>: {ROLE_HINT[data.role].toLowerCase()}.
            </span>
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
              Sent to {data.emailHint} · expires {new Date(data.expiresAt).toLocaleDateString()}
            </span>
          </div>
          {data.status !== "pending" ? (
            <>
              <span className="field-error">{data.status === "expired" ? "This invitation has expired. Ask for a new one." : data.status === "accepted" ? "This invitation was already accepted." : "This invitation is no longer valid."}</span>
              <Button onClick={close}>Close</Button>
            </>
          ) : (
            <>
              {signedIn && info?.account && (
                <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                  Signed in as {info.account.email}. The invitation only works for the address it was sent to.
                </span>
              )}
              <div className="row" style={{ gap: 8, alignSelf: "stretch" }}>
                {signedIn && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      await declineInvite(id);
                      close();
                    }}
                  >
                    Decline
                  </Button>
                )}
                <span className="spacer" />
                <Button variant="primary" onClick={() => void join()}>
                  {signedIn ? "Join workspace" : "Sign in to join"}
                </Button>
              </div>
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                Joining shares this workspace's projects, boards, tasks, notes and whiteboards with you. Nothing from this computer is uploaded.
              </span>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
