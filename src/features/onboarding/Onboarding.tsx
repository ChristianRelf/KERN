import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Segmented, Switch } from "@/components/ui/Controls";
import { useSettings, useSetting } from "@/stores/settings";
import { createProject } from "@/features/projects/actions";
import { APP_NAME } from "@/app/brand";
import { BrandMark } from "@/app/BrandMark";
import type { Density } from "@/features/settings/schema";

/** Minimal first-run setup; every step is optional. */
export function Onboarding() {
  const onboarded = useSetting("general.onboarded");
  const [project, setProject] = useState("");
  const [briefing, setBriefing] = useState(true);
  const [time, setTime] = useState("09:00");
  const [density, setDensity] = useState<Density>(useSettings.getState().values["appearance.density"]);
  if (onboarded) return null;

  const finish = async (apply: boolean) => {
    const s = useSettings.getState();
    if (apply) {
      await s.setMany({
        "general.onboarded": true,
        "rundown.enabled": briefing,
        "rundown.time": /^\d{2}:\d{2}$/.test(time) ? time : "09:00",
        "appearance.density": density,
      });
      if (project.trim()) await createProject({ name: project.trim() }, false);
    } else {
      await s.set("general.onboarded", true);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={() => undefined}
      hideClose
      centered
      title={
        <span className="row" style={{ gap: 10 }}>
          <BrandMark size={22} />
          Welcome to {APP_NAME}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => void finish(false)} style={{ marginRight: "auto" }}>
            Start with an empty workspace
          </Button>
          <Button variant="primary" onClick={() => void finish(true)}>
            Get started
          </Button>
        </>
      }
    >
      <p className="dialog__desc">Everything stays on this computer. You can change any of this later in Settings.</p>
      <div className="field">
        <label className="field__label" htmlFor="ob-project">
          First project
        </label>
        <input
          id="ob-project"
          className="input"
          placeholder="e.g. Website, Home, University (optional)"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          autoFocus
        />
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="col">
          <span className="field__label">Daily rundown</span>
          <span className="field__hint">A summary of what needs attention each morning.</span>
        </div>
        <div className="row">
          <input className="input" type="time" value={time} disabled={!briefing} onChange={(e) => setTime(e.target.value)} style={{ width: 110 }} aria-label="Briefing time" />
          <Switch checked={briefing} onChange={setBriefing} label="Enable daily rundown" />
        </div>
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="field__label">Interface density</span>
        <Segmented
          size="sm"
          value={density}
          onChange={(d) => {
            setDensity(d);
            void useSettings.getState().set("appearance.density", d);
          }}
          options={[
            { value: "compact", label: "Compact" },
            { value: "comfortable", label: "Comfortable" },
            { value: "relaxed", label: "Relaxed" },
          ]}
        />
      </div>
    </Dialog>
  );
}
