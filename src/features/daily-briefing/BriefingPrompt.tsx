/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Sunrise, Sunset, X } from "lucide-react";
import { useUi } from "@/stores/ui";
import { navigate } from "@/stores/router";
import { Button, IconButton } from "@/components/ui/Button";
import { useOverview } from "@/hooks/data";

/** A quiet in-app prompt when the morning briefing or evening review is due. */
export function BriefingPrompt() {
  const kind = useUi((s) => s.briefingPrompt);
  const set = useUi((s) => s.set);
  const { data: o } = useOverview();
  if (!kind) return null;
  const dismiss = () => set({ briefingPrompt: null });
  const morning = kind === "morning";
  const detail = morning
    ? o
      ? [o.dueToday && `${o.dueToday} due today`, o.overdue && `${o.overdue} overdue`].filter(Boolean).join(" · ") || "Nothing scheduled yet"
      : ""
    : o
      ? `${o.completedToday} completed today`
      : "";
  return (
    <div className="briefing-prompt" role="status">
      {morning ? <Sunrise /> : <Sunset />}
      <div className="col grow">
        <span style={{ fontWeight: 600 }}>{morning ? "Your daily rundown is ready" : "Time for your evening review"}</span>
        {detail && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{detail}</span>}
      </div>
      <Button
        size="sm"
        variant="primary"
        onClick={() => {
          dismiss();
          navigate({ name: "rundown", mode: morning ? "morning" : "evening" });
        }}
      >
        Open
      </Button>
      <IconButton icon={X} label="Dismiss" size="sm" onClick={dismiss} />
    </div>
  );
}
