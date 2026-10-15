/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// "Capture from anywhere": send notes to your personal Inbox from your phone
// (a private page you add to the home screen) or by email (a private
// address). Both are streams in the personal space, set up here in one click.

import { Copy, Mail, RefreshCw, Smartphone, Trash, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import qrcode from "qrcode-generator";
import type { Stream } from "@/lib/types";
import { describeError } from "@/lib/ipc";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Controls";
import { confirm } from "@/components/ui/Dialog";
import { streamKeys, streamsApi, useStreamList } from "@/features/streams/api";
import { openAuth, useCloud } from "./store";

const PHONE = "Phone capture";
const EMAIL = "Email to Inbox";

/** A QR code drawn as SVG squares (no HTML injection). */
export function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const out: string[] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) out.push(`M${c} ${r}h1v1h-1z`);
    return { n, d: out.join("") };
  }, [text]);
  return (
    <svg width={size} height={size} viewBox={`-2 -2 ${cells.n + 4} ${cells.n + 4}`} role="img" aria-label="QR code" style={{ background: "#fff", borderRadius: 8 }} shapeRendering="crispEdges">
      <path d={cells.d} fill="#111" />
    </svg>
  );
}

function PhoneCapture({ space, stream, baseUrl }: { space: string; stream: Stream | undefined; baseUrl: string }) {
  const qc = useQueryClient();
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const linkFor = (id: string, secret: string) => `${baseUrl}${id}/capture#k=${secret}`;
  const create = async () => {
    setBusy(true);
    try {
      const r = await streamsApi.create(space, { name: PHONE, description: "Notes sent from your phone land in the Inbox.", preset: "capture" });
      setLink(linkFor(r.stream.id, r.secret));
      void qc.invalidateQueries({ queryKey: streamKeys.all(space) });
    } catch (e) {
      toastError(describeError(e, "Couldn't set up phone capture."));
    } finally {
      setBusy(false);
    }
  };
  const reveal = async () => {
    if (!stream) return;
    try {
      const r = await streamsApi.reveal(space, stream.id);
      setLink(linkFor(stream.id, r.secret));
    } catch (e) {
      toastError(describeError(e));
    }
  };
  const rotate = async () => {
    if (!stream) return;
    if (!(await confirm({ title: "Make a new link?", message: "The old link stops working straight away, so phones using it need the new one.", confirmLabel: "New link" }))) return;
    try {
      const r = await streamsApi.rotate(space, stream.id, 0);
      setLink(linkFor(stream.id, r.secret));
    } catch (e) {
      toastError(describeError(e));
    }
  };
  if (!stream)
    return (
      <Button size="sm" icon={Smartphone} disabled={busy} onClick={() => void create()}>
        Set up phone capture
      </Button>
    );
  return (
    <div className="col" style={{ gap: 8, width: "100%" }}>
      {link ? (
        <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
          <QrCode text={link} />
          <div className="col grow" style={{ gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: "var(--fs-sm)" }}>Scan with your phone's camera, then use “Add to Home Screen” so it opens like an app.</span>
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" icon={Copy} onClick={() => void navigator.clipboard.writeText(link).then(() => toast("Link copied - send it to your phone privately"))}>
                Copy link
              </Button>
              <IconButton icon={X} label="Hide" size="sm" onClick={() => setLink(null)} />
            </div>
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>The link contains a private key: anyone with it can add to your Inbox. Keep it to yourself.</span>
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" icon={Smartphone} onClick={() => void reveal()}>
            Show phone link
          </Button>
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void rotate()}>
            New link
          </Button>
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            {stream.deliveryCount} note{stream.deliveryCount === 1 ? "" : "s"} captured
          </span>
        </div>
      )}
    </div>
  );
}

function EmailCapture({ space, stream }: { space: string; stream: Stream | undefined }) {
  const qc = useQueryClient();
  const email = useCloud((s) => s.info?.account?.email ?? "");
  const [adding, setAdding] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: streamKeys.all(space) });
  const senders = stream?.config.email?.allowedSenders ?? [];
  const setSenders = async (list: string[]) => {
    if (!stream) return;
    try {
      await streamsApi.update(space, stream.id, { config: { email: { allowedSenders: list } } });
      void refresh();
    } catch (e) {
      toastError(describeError(e));
    }
  };
  const create = async () => {
    try {
      const r = await streamsApi.create(space, { name: EMAIL, description: "Emails sent to this address land in the Inbox.", preset: "email" });
      // Only your own address can send until you allow others.
      if (email) await streamsApi.update(space, r.stream.id, { config: { email: { allowedSenders: [email.toLowerCase()] } } });
      void refresh();
    } catch (e) {
      toastError(describeError(e, "Couldn't set up the email address."));
    }
  };
  if (stream?.email && !stream.email.available) return <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Email isn't set up on this Kern Cloud server yet.</span>;
  if (!stream)
    return (
      <Button size="sm" icon={Mail} onClick={() => void create()}>
        Create my address
      </Button>
    );
  const address = stream.email?.address;
  return (
    <div className="col" style={{ gap: 6, width: "100%" }}>
      {address ? (
        <div className="row" style={{ gap: 6 }}>
          <input className="input grow selectable" readOnly value={address} onFocus={(e) => e.currentTarget.select()} aria-label="Inbox email address" style={{ height: "var(--control-h-sm)" }} />
          <IconButton icon={Copy} label="Copy" size="sm" onClick={() => void navigator.clipboard.writeText(address).then(() => toast("Address copied"))} />
          <IconButton
            icon={RefreshCw}
            label="New address (the old one stops working)"
            size="sm"
            onClick={async () => {
              if (!(await confirm({ title: "Get a new address?", message: "Mail sent to the current address will bounce.", confirmLabel: "New address" }))) return;
              await streamsApi.update(space, stream.id, { config: { email: { alias: null, enabled: true } as never } }).catch((e) => toastError(describeError(e)));
              void refresh();
            }}
          />
        </div>
      ) : (
        <Button size="sm" onClick={() => void streamsApi.update(space, stream.id, { config: { email: { enabled: true } } }).then(refresh)}>
          Turn on the address
        </Button>
      )}
      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        Accepting mail from: {senders.length ? senders.join(", ") : "anyone who has the address"}
      </span>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {senders.map((s) => (
          <span key={s} className="chip chip--outline" style={{ gap: 2 }}>
            {s}
            <IconButton icon={Trash} label={`Stop accepting mail from ${s}`} size="sm" onClick={() => void setSenders(senders.filter((x) => x !== s))} />
          </span>
        ))}
        <input
          className="input"
          style={{ width: 220, height: "var(--control-h-sm)" }}
          placeholder="Allow another sender…"
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adding.trim())) {
              void setSenders([...senders, adding.trim().toLowerCase()]);
              setAdding("");
            }
          }}
          aria-label="Allow another sender"
        />
      </div>
    </div>
  );
}

export function CaptureAnywhere() {
  const signedIn = useCloud((s) => !!s.info?.signedIn);
  const personal = useCloud((s) => s.me?.personal ?? null);
  const { data, isLoading } = useStreamList(personal?.id, signedIn && !!personal);
  if (!signedIn)
    return (
      <div className="col" style={{ gap: 6 }}>
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Sign in to Kern Cloud (free) to capture to your Inbox from your phone or by email.</span>
        <Button size="sm" style={{ alignSelf: "flex-start" }} onClick={() => openAuth({ reason: "Sign in to capture from your phone or by email." })}>
          Sign in
        </Button>
      </div>
    );
  if (!personal) return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Turn on your personal space first (space menu → Personal).</span>;
  if (isLoading) return <Skeleton height={40} />;
  const phone = data?.streams.find((s) => s.name === PHONE);
  const mail = data?.streams.find((s) => s.name === EMAIL);
  return (
    <div className="col" style={{ gap: 16, width: "100%" }}>
      <div className="col" style={{ gap: 6 }}>
        <span className="set-row__label row" style={{ gap: 6 }}>
          <Smartphone size={14} /> From your phone
        </span>
        <PhoneCapture space={personal.id} stream={phone} baseUrl={data?.baseUrl ?? ""} />
      </div>
      <div className="col" style={{ gap: 6 }}>
        <span className="set-row__label row" style={{ gap: 6 }}>
          <Mail size={14} /> By email
        </span>
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Forward an email (or write one) to your private address and it lands in your Inbox, subject first.</span>
        <EmailCapture space={personal.id} stream={mail} />
      </div>
    </div>
  );
}
