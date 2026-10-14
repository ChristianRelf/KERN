// Icon, emoji and colour picker for projects (and workspace marks): a
// searchable icon grid, a curated emoji set (or any emoji you paste), preset
// colours and a custom colour.

import { useMemo, useState } from "react";
import { Pipette, Search } from "lucide-react";
import { Segmented } from "@/components/ui/Controls";
import { PROJECT_COLORS, PROJECT_ICONS, ProjectGlyph, accentColor, iconEmoji, isCustomColor } from "./ProjectGlyph";

const EMOJI = [
  "🚀", "✨", "🔥", "⚡", "🎯", "🏆", "⭐", "💎", "🌈", "🌱",
  "🌿", "🌸", "🌊", "🏔️", "☀️", "🌙", "🍀", "🍎", "☕", "🍕",
  "🎨", "🎵", "🎬", "📷", "🎮", "🧩", "📚", "✏️", "📝", "📌",
  "💡", "🧠", "🔬", "🧪", "🛠️", "🔧", "⚙️", "💻", "📱", "🖥️",
  "🤖", "🐛", "🔒", "📦", "🚚", "✈️", "🗺️", "🏠", "🏡", "🏢",
  "💼", "💰", "📈", "📊", "🛒", "🎁", "❤️", "💪", "🧘", "🏃",
  "🐶", "🐱", "🦊", "🐝", "🦋", "🐙", "🎓", "🏫", "👶", "👥",
];

/** Keeps just the first emoji (or symbol) of what was typed or pasted. */
function firstGlyph(text: string): string {
  const t = text.trim();
  if (!t) return "";
  const seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment: (s: string) => Iterable<{ segment: string }> } }).Segmenter;
  if (seg) for (const s of new seg(undefined, { granularity: "grapheme" }).segment(t)) return s.segment;
  return Array.from(t)[0] ?? "";
}

export interface Appearance {
  icon?: string | null;
  accent?: string | null;
}

export function AppearancePicker({ icon, accent, name, onChange, letter = true }: { icon: string | null; accent: string | null; name: string; onChange: (p: Appearance) => void; letter?: boolean }) {
  const [mode, setMode] = useState<"icons" | "emoji">(iconEmoji(icon) ? "emoji" : "icons");
  const [q, setQ] = useState("");
  const icons = useMemo(() => Object.entries(PROJECT_ICONS).filter(([k]) => !q.trim() || k.includes(q.trim().toLowerCase())), [q]);
  const emoji = iconEmoji(icon);
  const custom = isCustomColor(accent) ? accent! : null;

  return (
    <div className="appearance-picker">
      <div className="row" style={{ gap: 8 }}>
        <Segmented<"icons" | "emoji">
          size="sm"
          value={mode}
          onChange={setMode}
          ariaLabel="Icon type"
          options={[
            { value: "icons", label: "Icons" },
            { value: "emoji", label: "Emoji" },
          ]}
        />
        {mode === "icons" ? (
          <div className="input-wrap grow">
            <Search />
            <input className="input grow" placeholder="Search icons" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search icons" />
          </div>
        ) : (
          <input
            className="input grow"
            placeholder="Or type / paste any emoji"
            value={emoji && !EMOJI.includes(emoji) ? emoji : ""}
            onChange={(e) => {
              const g = firstGlyph(e.target.value);
              if (g) onChange({ icon: `emoji:${g}` });
            }}
            aria-label="Custom emoji"
          />
        )}
      </div>
      <div className="icon-grid appearance-picker__grid">
        {letter && (
          <button type="button" className="icon-grid__item" data-active={!icon || undefined} onClick={() => onChange({ icon: null })} aria-label="First letter" title="First letter">
            <ProjectGlyph project={{ name: name || "A", icon: null, accent }} size={16} />
          </button>
        )}
        {mode === "icons"
          ? icons.map(([key, Icon]) => (
              <button key={key} type="button" className="icon-grid__item" data-active={icon === key || undefined} onClick={() => onChange({ icon: key })} aria-label={key} title={key}>
                <Icon size={16} strokeWidth={1.75} style={{ color: icon === key ? accentColor(accent) : undefined }} />
              </button>
            ))
          : EMOJI.map((e) => (
              <button key={e} type="button" className="icon-grid__item appearance-picker__emoji" data-active={emoji === e || undefined} onClick={() => onChange({ icon: `emoji:${e}` })} aria-label={e}>
                {e}
              </button>
            ))}
        {mode === "icons" && !icons.length && <span className="faint" style={{ gridColumn: "1 / -1", padding: 6 }}>No icons match “{q}”.</span>}
      </div>
      <div className="appearance-picker__colors">
        <button type="button" className="swatch" data-active={!accent || undefined} onClick={() => onChange({ accent: null })} aria-label="No colour" title="No colour" style={{ background: "var(--text-3)" }} />
        {Object.entries(PROJECT_COLORS).map(([k, c]) => (
          <button key={k} type="button" className="swatch" data-active={accent === k || undefined} onClick={() => onChange({ accent: k })} aria-label={k} title={k[0].toUpperCase() + k.slice(1)} style={{ background: c }} />
        ))}
        <label className="swatch swatch--custom" data-active={!!custom || undefined} title="Custom colour" style={custom ? { background: custom } : undefined}>
          {!custom && <Pipette size={10} />}
          <input type="color" value={custom ?? "#8aa9dc"} onChange={(e) => onChange({ accent: e.target.value.toLowerCase() })} aria-label="Custom colour" />
        </label>
      </div>
    </div>
  );
}
