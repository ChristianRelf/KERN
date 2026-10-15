/**
 * @Author Christian Relf
 * @Date 2026-10-14
 */

// The startup choice between full Kern and Kern Lite ("Ask each time").

import { useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/Controls";
import { BrandMark } from "./BrandMark";
import { useAppearance } from "./effects";
import { switchMode, type AppMode } from "./mode";
import "./chooser.css";

const OPTIONS: { mode: AppMode; name: string; blurb: string }[] = [
  { mode: "kern", name: "Kern", blurb: "Everything: projects, boards, notes, whiteboards and code." },
  { mode: "lite", name: "Kern Lite", blurb: "Just your tasks. Tiny, quick, synced with Kern." },
];

function Preview({ mode }: { mode: AppMode }) {
  if (mode === "kern")
    return (
      <span className="chooser__preview chooser__preview--kern" aria-hidden>
        <span className="pv-side">
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="pv-main">
          <span className="pv-card" />
          <span className="pv-card" />
          <span className="pv-card pv-card--wide" />
        </span>
      </span>
    );
  return (
    <span className="chooser__preview chooser__preview--lite" aria-hidden>
      {[0.9, 0.7, 0.8, 0.55].map((w, i) => (
        <span key={i} className="pv-task" data-done={i === 1 || undefined}>
          <b />
          <i style={{ width: `${w * 100}%` }} />
        </span>
      ))}
    </span>
  );
}

export function StartChooser() {
  useAppearance();
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState<AppMode | null>(null);

  const pick = (mode: AppMode) => {
    if (busy) return;
    setBusy(mode);
    void switchMode(mode, { remember });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "1") pick("kern");
      if (e.key === "2") pick("lite");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="chooser">
      <div className="chooser__inner">
        <BrandMark size={34} className="chooser__mark" />
        <h1 className="chooser__title">How do you want to work?</h1>
        <div className="chooser__options">
          {OPTIONS.map((o, i) => (
            <button key={o.mode} type="button" className="chooser__option" data-busy={busy === o.mode || undefined} autoFocus={i === 0} onClick={() => pick(o.mode)} style={{ animationDelay: `${60 + i * 70}ms` }}>
              <Preview mode={o.mode} />
              <span className="chooser__name">
                {o.name}
                <kbd>{i + 1}</kbd>
              </span>
              <span className="chooser__blurb">{o.blurb}</span>
            </button>
          ))}
        </div>
        <label className="chooser__remember">
          <Checkbox checked={remember} onChange={setRemember} />
          <span>Remember my choice</span>
        </label>
        <span className="chooser__hint">You can switch any time, and change this in Settings → General.</span>
      </div>
    </div>
  );
}
