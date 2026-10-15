/**
 * @Author Christian Relf
 * @Date 2026-10-15
 */

// Settings → Calendars: subscriptions (read-only ICS addresses), exporting
// tasks as an ICS file (once, or kept up to date), and the private Kern
// Cloud address calendar apps can subscribe to.

import { CalendarPlus, Copy, Download, ExternalLink, FileClock, Link2Off, Loader2, RefreshCw, Trash, X } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { CalendarFeed, CloudCalendarFeed } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { relativeTime } from "@/lib/dates";
import { setSetting, useSetting } from "@/stores/settings";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Controls";
import { confirm, confirmDelete } from "@/components/ui/Dialog";
import { PROJECT_COLORS } from "@/features/projects/ProjectGlyph";
import { useActiveSpace, useCloud } from "@/features/cloud/store";
import { SSelect, SToggle, type GroupDef } from "@/features/settings/controls";

const COLORS = Object.values(PROJECT_COLORS);

function useFeeds() {
  return useQuery({ queryKey: ["calendar", "feeds"], queryFn: api.calendar.feeds });
}

function FeedRow({ f }: { f: CalendarFeed }) {
  const [busy, setBusy] = useState(false);
  const refresh = () => invalidate("calendar");
  const patch = async (p: { name?: string; color?: string; enabled?: boolean }) => {
    try {
      await api.calendar.updateFeed(f.id, p);
      refresh();
    } catch (e) {
      toastError(describeError(e));
    }
  };
  return (
    <div className="cal-feed">
      <button
        type="button"
        className="swatch"
        style={{ background: f.color ?? "var(--hue-3)", width: 14, height: 14 }}
        aria-label="Change colour"
        title="Change colour"
        onClick={() => void patch({ color: COLORS[(COLORS.indexOf(f.color ?? "") + 1) % COLORS.length] })}
      />
      <div className="col grow" style={{ minWidth: 0, gap: 1 }}>
        <span className="truncate" style={{ fontSize: "var(--fs-sm)" }}>{f.name}</span>
        <span className="truncate faint" style={{ fontSize: "var(--fs-xs)", color: f.lastError ? "var(--danger)" : undefined }} title={f.lastError ?? f.url}>
          {f.lastError ? f.lastError : `${f.eventCount} event${f.eventCount === 1 ? "" : "s"}${f.lastFetchedAt ? ` · updated ${relativeTime(f.lastFetchedAt)}` : ""}`}
        </span>
      </div>
      <Switch checked={f.enabled} onChange={(v) => void patch({ enabled: v })} label={`Show ${f.name}`} />
      <IconButton
        icon={busy ? Loader2 : RefreshCw}
        label="Refresh now"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.calendar.refresh(f.id);
            toast(`${f.name} updated`);
          } catch (e) {
            toastError(describeError(e, "Couldn't refresh the calendar."));
          } finally {
            setBusy(false);
            refresh();
          }
        }}
      />
      <IconButton
        icon={Trash}
        label="Remove"
        size="sm"
        onClick={async () => {
          if (!(await confirmDelete(`Remove “${f.name}”?`, "Its events disappear from Kern. The calendar itself isn't changed.", "Remove"))) return;
          await api.calendar.deleteFeed(f.id).catch((e) => toastError(describeError(e)));
          refresh();
        }}
      />
    </div>
  );
}

function Subscriptions() {
  const { data: feeds } = useFeeds();
  const network = useSetting("privacy.network");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const f = await api.calendar.addFeed(name.trim(), url.trim(), COLORS[(feeds?.length ?? 0) % COLORS.length]);
      setName("");
      setUrl("");
      invalidate("calendar");
      toast(`Added ${f.name} · ${f.eventCount} events`);
    } catch (e) {
      toastError(describeError(e, "Couldn't add that calendar."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 6, width: "100%" }}>
      {feeds?.map((f) => <FeedRow key={f.id} f={f} />)}
      {!network && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Network access is off in Privacy, so calendars can't be fetched.</span>}
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="input" style={{ width: 140, height: "var(--control-h-sm)" }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Calendar name" />
        <input
          className="input grow"
          style={{ minWidth: 220, height: "var(--control-h-sm)" }}
          placeholder="https://… or webcal://… (the calendar's secret or public ICS address)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
          aria-label="Calendar address"
        />
        <Button size="sm" icon={busy ? Loader2 : CalendarPlus} disabled={!url.trim() || busy || !network} onClick={() => void add()}>
          Add
        </Button>
      </div>
      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        Google Calendar: Settings → your calendar → “Secret address in iCal format”. Outlook: Settings → Calendar → Shared calendars → Publish → ICS. Apple iCloud: share the calendar publicly and copy the link. Events are read-only in Kern.
      </span>
    </div>
  );
}

async function exportOnce() {
  const path = await saveDialog({ defaultPath: "kern-tasks.ics", filters: [{ name: "Calendar", extensions: ["ics"] }] });
  if (!path) return;
  try {
    const n = await api.calendar.exportIcs(path, { includeMilestones: true, includePlanned: true });
    toast(`Exported ${n} event${n === 1 ? "" : "s"}`, { action: { label: "Show", run: () => void api.system.reveal(path) } });
  } catch (e) {
    toastError(describeError(e, "Export failed."));
  }
}

function AutoExport() {
  const path = useSetting("calendar.autoExportPath");
  return (
    <div className="row" style={{ gap: 6 }}>
      {path && (
        <span className="truncate faint" style={{ fontSize: "var(--fs-xs)", maxWidth: 260 }} title={path}>
          {path}
        </span>
      )}
      <Button
        size="sm"
        icon={FileClock}
        onClick={async () => {
          const p = await saveDialog({ defaultPath: path ?? "kern.ics", filters: [{ name: "Calendar", extensions: ["ics"] }] });
          if (!p) return;
          await setSetting("calendar.autoExportPath", p);
          await api.calendar.exportIcs(p, { includeMilestones: true, includePlanned: true }).catch((e) => toastError(describeError(e)));
          toast("Kern will keep this file up to date (hourly)");
        }}
      >
        {path ? "Change…" : "Choose file…"}
      </Button>
      {path && <IconButton icon={X} label="Stop updating" size="sm" onClick={() => void setSetting("calendar.autoExportPath", null)} />}
    </div>
  );
}

function CloudFeed() {
  const space = useActiveSpace();
  const signedIn = useCloud((s) => !!s.info?.signedIn);
  const key = ["calendar", "cloud-feed", space?.id];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.cloud.request<{ feed: CloudCalendarFeed | null }>("GET", `/spaces/${space!.id}/calendar-feed`).then((r) => r.feed),
    enabled: !!space && signedIn,
    retry: false,
  });
  if (!space || !signedIn) return <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Open your personal space or a workspace (Kern Cloud) to get an address calendar apps can subscribe to.</span>;
  const create = async () => {
    try {
      const r = await api.cloud.request<{ feed: CloudCalendarFeed }>("POST", `/spaces/${space.id}/calendar-feed`, { includeMilestones: true });
      queryClient.setQueryData(key, r.feed);
      await navigator.clipboard.writeText(r.feed.url).catch(() => undefined);
      toast("Calendar address copied");
    } catch (e) {
      toastError(describeError(e));
    }
  };
  if (isLoading) return null;
  if (!data)
    return (
      <Button size="sm" icon={CalendarPlus} onClick={() => void create()}>
        Create address
      </Button>
    );
  return (
    <div className="col" style={{ gap: 6, width: "100%" }}>
      <div className="row" style={{ gap: 6 }}>
        <input className="input grow selectable" readOnly value={data.url} onFocus={(e) => e.currentTarget.select()} aria-label="Calendar address" style={{ height: "var(--control-h-sm)" }} />
        <IconButton icon={Copy} label="Copy" size="sm" onClick={() => void navigator.clipboard.writeText(data.url).then(() => toast("Copied"))} />
        <IconButton icon={ExternalLink} label="Open in calendar app" size="sm" onClick={() => void api.system.open(data.url.replace(/^https:/, "webcal:"))} />
        <IconButton
          icon={RefreshCw}
          label="New address (the old one stops working)"
          size="sm"
          onClick={async () => {
            if (await confirm({ title: "Make a new address?", message: "Calendar apps using the current address stop updating until you give them the new one.", confirmLabel: "New address" })) await create();
          }}
        />
        <IconButton
          icon={Link2Off}
          label="Turn off"
          size="sm"
          onClick={async () => {
            await api.cloud.request("DELETE", `/spaces/${space.id}/calendar-feed`).catch((e) => toastError(describeError(e)));
            queryClient.setQueryData(key, null);
          }}
        />
      </div>
      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        Private to you: anyone with it can see this space's dated tasks and milestones. {data.lastFetchedAt ? `Last read by a calendar app ${relativeTime(new Date(data.lastFetchedAt).getTime())}.` : "Not used by a calendar app yet."}
      </span>
    </div>
  );
}

export function useCalendarGroups(): GroupDef[] {
  return [
    {
      title: "Subscribed calendars",
      rows: [
        { label: "Calendars", hint: "Events show in the day planner, the calendar and the Agenda widget, so you can plan around them.", keywords: "ics ical google outlook icloud subscribe events meetings", block: <Subscriptions /> },
        { label: "Show calendar events", control: <SToggle k="calendar.showEvents" /> },
        { label: "Refresh every", control: <SSelect k="calendar.refreshMinutes" options={[30, 60, 180, 360, 720].map((m) => ({ value: String(m), label: m < 60 ? `${m} min` : `${m / 60} hour${m === 60 ? "" : "s"}` }))} /> },
      ],
    },
    {
      title: "Day planner",
      rows: [
        { label: "Day starts at", keywords: "planner hours time blocking", control: <SSelect k="calendar.dayStart" options={Array.from({ length: 13 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }))} /> },
        { label: "Day ends at", control: <SSelect k="calendar.dayEnd" options={Array.from({ length: 12 }, (_, i) => i + 13).map((h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` }))} /> },
      ],
    },
    {
      title: "Tasks in your calendar app",
      rows: [
        { label: "Calendar address (Kern Cloud)", hint: "Subscribe to it in Google Calendar, Outlook or Apple Calendar: tasks with due dates and milestones stay up to date automatically.", keywords: "ics feed subscribe google outlook", block: <CloudFeed /> },
        { label: "Export to a file", hint: "Due tasks, time blocks and milestones as an .ics file you can import anywhere.", keywords: "ics export", control: <Button size="sm" icon={Download} onClick={() => void exportOnce()}>Export…</Button> },
        { label: "Keep a file up to date", hint: "Kern rewrites this .ics file every hour. Calendar apps that can subscribe to a file (e.g. Thunderbird) stay current, offline too.", keywords: "ics auto export", control: <AutoExport /> },
      ],
    },
  ];
}
