/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// Required (security) updates: started by Kern itself as soon as one is
// seen, in any mode. If one doesn't finish, Kern stays usable on the
// running version with a notice that it's required, and tries again by
// itself after FORCED_RETRY_MS (or now, from the notice).

import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useUpdateCheck } from "@/hooks/data";
import { api } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { startUpdate, useForcedRetry, useUpdater } from "./store";
import "./updates.css";

export function ForcedUpdate() {
  const { data } = useUpdateCheck();
  const updating = useUpdater((s) => s.phase !== null);
  const { retryAt, manualOnly } = useForcedRetry();
  const required = !!data?.security && !!data.latest;

  // Ticks while waiting to try again, so the retry starts on time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!retryAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, [retryAt]);

  useEffect(() => {
    if (!required || updating || manualOnly || (retryAt && now < retryAt)) return;
    void startUpdate({ forced: true, current: data.current, target: data.latest!, fallbackUrl: data.url });
  }, [required, updating, manualOnly, retryAt, now, data]);

  if (!required || updating || (!retryAt && !manualOnly)) return null;
  const minutes = retryAt ? Math.max(1, Math.ceil((retryAt - now) / 60_000)) : 0;
  return (
    <div className="forced-update" role="alert">
      <ShieldAlert size={16} className="forced-update__icon" />
      <span className="forced-update__text">
        <strong>Security update required</strong>
        <span className="faint">
          {manualOnly
            ? ` · v${data.latest} has to be installed from the release page.`
            : ` · v${data.latest} didn't install. Trying again in ${minutes} min.`}
        </span>
      </span>
      {manualOnly ? (
        <Button size="sm" variant="primary" onClick={() => void api.system.open(data.url).catch(() => undefined)}>
          Release page
        </Button>
      ) : (
        <Button size="sm" variant="primary" onClick={() => useForcedRetry.setState({ retryAt: null })}>
          Update now
        </Button>
      )}
    </div>
  );
}
