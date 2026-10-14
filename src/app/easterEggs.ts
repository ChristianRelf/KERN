// A few small secrets. None of them touch data; all of them respect reduced
// motion (you still get the message, just not the movement).
//
//  - The Konami code (↑ ↑ ↓ ↓ ← → ← → B A) anywhere: a confetti party and a
//    brief rainbow accent.
//  - Completing a task called "do a barrel roll": the window does one.
//  - Settings → About: click the logo five times.

import { useEffect } from "react";
import { toast } from "@/stores/toast";

const KONAMI = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];

const calm = () => {
  const m = document.documentElement.dataset.motion;
  return m === "reduced" || m === "off";
};

/** Full-window confetti, drawn outside React so anything can call it. */
export function confettiBurst(pieces = 90) {
  if (calm()) return;
  const layer = document.createElement("div");
  layer.className = "egg-confetti";
  const colors = ["#8aa9dc", "#a597dd", "#8bb795", "#d2ad73", "#cf929d", "#7bb5ae", "#e3a072", "#e391bd"];
  for (let i = 0; i < pieces; i++) {
    const p = document.createElement("i");
    const w = 5 + Math.random() * 5;
    p.style.cssText = `left:${Math.random() * 100}%;width:${w}px;height:${w * 1.6}px;background:${colors[i % colors.length]};--dx:${(Math.random() - 0.5) * 240}px;--r:${Math.random() * 1080 - 540}deg;--t:${1600 + Math.random() * 1400}ms;--d:${Math.random() * 500}ms`;
    layer.appendChild(p);
  }
  document.body.appendChild(layer);
  window.setTimeout(() => layer.remove(), 3600);
}

function party() {
  toast("Cheat code accepted: +30 lives.", { tone: "success" });
  confettiBurst();
  if (calm()) return;
  const root = document.documentElement;
  root.classList.add("egg-rainbow");
  window.setTimeout(() => root.classList.remove("egg-rainbow"), 4000);
}

function barrelRoll() {
  toast("Wheee!", { tone: "success" });
  if (calm()) return;
  const root = document.getElementById("root");
  if (!root || root.classList.contains("egg-roll")) return;
  root.classList.add("egg-roll");
  window.setTimeout(() => root.classList.remove("egg-roll"), 1300);
}

/** Called when a task is completed. */
export function taskEasterEgg(title: string) {
  const t = title.trim().toLowerCase().replace(/[!.?]+$/, "");
  if (t === "do a barrel roll" || t === "barrel roll") barrelRoll();
}

/** Listens for the Konami code (Kern and Kern Lite). */
export function useEasterEggs() {
  useEffect(() => {
    let pos = 0;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      // An extra ↑ before the ↓s keeps the last two ups.
      pos = k === KONAMI[pos] ? pos + 1 : k === "arrowup" ? (pos === 2 ? 2 : 1) : 0;
      if (pos === KONAMI.length) {
        pos = 0;
        party();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
