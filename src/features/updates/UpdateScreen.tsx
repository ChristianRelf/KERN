/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// The whole window while an update runs: just the mark, what's happening
// and a progress bar, in the middle of a blank screen.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Progress } from "@/components/ui/Controls";
import { BrandMark } from "@/app/BrandMark";
import { APP_NAME } from "@/app/brand";
import { formatBytes } from "@/lib/dates";
import { FAILED_RETURN_MS, FORCED_RETRY_MS, MAX_ATTEMPTS, leaveUpdate, useUpdater } from "./store";
import "./updates.css";

export function UpdateScreen() {
  const s = useUpdater();
  const failed = s.phase === "failed";

  // After a failure Kern comes back by itself, still on the running version.
  const [left, setLeft] = useState(FAILED_RETURN_MS / 1000);
  useEffect(() => {
    if (!failed) return;
    setLeft(FAILED_RETURN_MS / 1000);
    const t = window.setInterval(() => setLeft((n) => n - 1), 1000);
    const done = window.setTimeout(leaveUpdate, FAILED_RETURN_MS);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(done);
    };
  }, [failed]);

  const versions = s.target ? (s.current ? `v${s.current} → v${s.target}` : `v${s.target}`) : null;
  let status: string;
  let progress: number | null = null;
  switch (s.phase) {
    case "downloading":
      progress = s.total ? s.downloaded / s.total : null;
      status = s.total ? `Downloading… ${formatBytes(s.downloaded)} of ${formatBytes(s.total)}` : "Downloading…";
      if (s.attempt > 1) status += ` (attempt ${s.attempt} of ${MAX_ATTEMPTS})`;
      break;
    case "retrying":
      status = `Download failed. Trying again (attempt ${s.attempt} of ${MAX_ATTEMPTS})…`;
      break;
    case "installing":
      progress = 1;
      status = `Installing… ${APP_NAME} will reopen in a moment.`;
      break;
    case "restarting":
      progress = 1;
      status = "Restarting…";
      break;
    case "failed":
      status =
        s.failedStep === "install"
          ? `The update couldn't be installed. You're still on ${s.current ? `v${s.current}` : "the current version"}.`
          : `The update couldn't be downloaded after ${MAX_ATTEMPTS} attempts. You're still on ${s.current ? `v${s.current}` : "the current version"}.`;
      if (s.forced) status += ` It's a required security update, so ${APP_NAME} will try again in ${FORCED_RETRY_MS / 60_000} minutes.`;
      break;
    default:
      status = "Getting the update…";
  }

  return (
    <div className="update-screen" role="dialog" aria-modal aria-labelledby="update-screen-title">
      <div className="update-screen__card" data-failed={failed || undefined}>
        <BrandMark size={36} className="update-screen__mark" />
        <h1 id="update-screen-title" className="update-screen__title">
          {failed ? "Update didn't finish" : s.forced ? "Installing a security update" : `Updating ${APP_NAME}`}
        </h1>
        {s.forced && !failed && <span className="security-badge">Required</span>}
        {versions && <span className="update-screen__versions">{versions}</span>}
        {!failed && (
          <div className="update-screen__bar" data-indeterminate={progress === null || undefined}>
            <Progress value={progress ?? 0.3} />
          </div>
        )}
        <span className="update-screen__status" role="status" aria-live="polite">
          {status}
        </span>
        {failed && (
          <>
            {s.error && <span className="update-screen__error selectable">{s.error}</span>}
            <Button variant="primary" onClick={leaveUpdate} autoFocus>
              Back to {APP_NAME}
              {left > 0 && <span className="faint tabular"> ({left})</span>}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
