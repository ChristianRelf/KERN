/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// Settings → About: what Kern is, your year in it (a completion heatmap with
// streaks), and the technical details for bug reports.

import { useRef, useState } from "react";
import { ArrowUpRight, Copy, Download, FolderOpen, Keyboard, RotateCcw, Sparkles } from "lucide-react";
import { api } from "@/lib/ipc";
import { useAppInfo, useOverview, useUpdateCheck } from "@/hooks/data";
import { YearHeatmap } from "@/features/stats/YearHeatmap";
import { navigate } from "@/stores/router";
import { setSetting, useSettings } from "@/stores/settings";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { confirm } from "@/components/ui/Dialog";
import { APP_NAME } from "@/app/brand";
import { startUpdate } from "@/features/updates/store";
import { openWhatsNew } from "@/features/updates/WhatsNew";

function Heatmap() {
  return (
    <section>
      <div className="about-year__head">
        <span className="set-group__title" style={{ margin: 0 }}>
          Your year in {APP_NAME}
        </span>
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Tasks completed per day
        </span>
      </div>
      <YearHeatmap />
    </section>
  );
}

/** The mark, drawn in stroke by stroke. Has a secret. */
function AnimatedMark({ onSecret }: { onSecret: () => void }) {
  const clicks = useRef<number[]>([]);
  const [spin, setSpin] = useState(0);
  return (
    <button
      type="button"
      className="about-mark"
      data-spin={spin % 2 === 1 || undefined}
      aria-label={APP_NAME}
      onClick={() => {
        const now = Date.now();
        clicks.current = [...clicks.current.filter((t) => now - t < 1500), now];
        if (clicks.current.length >= 5) {
          clicks.current = [];
          setSpin((s) => s + 1);
          onSecret();
        }
      }}
    >
      {/* assets/icon.svg, with each stroke drawn in turn. */}
      <svg width={64} height={64} viewBox="0 0 1024 1024" aria-hidden>
        <rect x="68.5" y="68.5" width="887" height="887" rx="196" className="about-mark__tile" />
        <path d="M380 496.5L660 764" className="about-mark__leg" pathLength={1} />
        <path d="M396 495L684 248" className="about-mark__arm" pathLength={1} />
        <path d="M369.5 246.5V777.5" className="about-mark__stem" pathLength={1} />
      </svg>
    </button>
  );
}

const SECRETS = ["You found the K. Have a lovely day.", "Still here? Go tick something off.", "Kern is short for kernel: the small, essential part.", "Tip: Kern Lite lives in the sidebar, bottom left."];

export function AboutSection() {
  const { data: info } = useAppInfo();
  const { data: update, isFetching: checking, refetch } = useUpdateCheck();
  const { data: overview } = useOverview();
  const secret = useRef(0);

  const details = info ? [`${APP_NAME} ${info.version}`, `Data schema v${info.schemaVersion}`, `Tauri ${info.tauriVersion} · ${info.platform}`, `Data folder: ${info.dataDir}`].join("\n") : "";

  return (
    <div className="col about" style={{ gap: 22 }}>
      <section className="about-hero">
        <AnimatedMark onSecret={() => toast(SECRETS[secret.current++ % SECRETS.length], { tone: "success" })} />
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <span className="about-hero__name">{APP_NAME}</span>
          <span className="about-hero__tagline">A calm, local-first workspace for tasks, projects, notes and whiteboards.</span>
          <span className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            <span className="about-pill">v{info?.version ?? "…"}</span>
            {update?.latest ? (
              <Button size="sm" variant="primary" icon={Download} onClick={() => void startUpdate({ current: update.current, target: update.latest!, fallbackUrl: update.url, forced: update.security })}>
                {update.security ? "Install security update" : "Update to"} v{update.latest}
              </Button>
            ) : (
              <Tooltip content="Check again">
                <button type="button" className="about-pill about-pill--ok" onClick={() => void refetch()}>
                  <Sparkles size={11} /> {checking ? "Checking…" : "Up to date"}
                </button>
              </Tooltip>
            )}
            {overview && (
              <span className="about-pill">
                {overview.activeProjects} project{overview.activeProjects === 1 ? "" : "s"} · {overview.openTasks} open task{overview.openTasks === 1 ? "" : "s"}
              </span>
            )}
          </span>
        </div>
      </section>

      <Heatmap />

      <section>
        <div className="set-group__title">Technical details</div>
        <div className="set-group">
          {[
            ["Version", info ? `${info.version} (data schema v${info.schemaVersion})` : ""],
            ["Runtime", info ? `Tauri ${info.tauriVersion} · ${info.platform}` : ""],
            ["Data folder", info?.dataDir ?? ""],
          ].map(([k, v]) => (
            <div key={k} className="set-row">
              <span className="set-row__text">
                <span className="set-row__label">{k}</span>
              </span>
              <span className="faint selectable truncate about-value">
                {v}
              </span>
              {k === "Data folder" && info && (
                <span className="set-row__control">
                  <Button size="sm" icon={FolderOpen} onClick={() => void api.system.reveal(info.dataDir)}>
                    Open
                  </Button>
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Button size="sm" icon={Copy} disabled={!details} onClick={() => void navigator.clipboard.writeText(details).then(() => toast("Details copied"))}>
          Copy details
        </Button>
        {info && (
          <Button size="sm" icon={Sparkles} onClick={() => openWhatsNew(info.version)}>
            What's new in {info.version}
          </Button>
        )}
        {update?.url && (
          <Button size="sm" icon={ArrowUpRight} onClick={() => void api.system.open(update.url)}>
            Release notes
          </Button>
        )}
        <Button size="sm" icon={Keyboard} onClick={() => navigate({ name: "settings", section: "keyboard" })}>
          Keyboard shortcuts
        </Button>
        <span className="grow" />
        <Button
          size="sm"
          variant="ghost"
          icon={RotateCcw}
          onClick={async () => {
            if (await confirm({ title: "Reset all settings?", message: "Appearance, behaviour and shortcuts return to defaults. Your data is not affected.", confirmLabel: "Reset settings", danger: true })) {
              await useSettings.getState().reset();
              await setSetting("general.onboarded", true);
              toast("Settings reset");
            }
          }}
        >
          Reset all settings
        </Button>
      </div>
    </div>
  );
}
