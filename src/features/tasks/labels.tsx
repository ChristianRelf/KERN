// Label colours: stored like project accents (a preset key or #rrggbb) and
// shown as a dot on label chips.

import { Pipette } from "lucide-react";
import { useState, type ReactElement } from "react";
import type { Label } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { Popover } from "@/components/ui/Controls";
import { PROJECT_COLORS, accentColor, isCustomColor } from "@/features/projects/ProjectGlyph";
import { toastError } from "@/stores/toast";

export const labelColor = (l: Pick<Label, "color"> | undefined) => accentColor(l?.color);

/** The preset colour fewest labels use, so new labels are told apart. */
export function nextLabelColor(labels: Pick<Label, "color">[]): string {
  const used = new Map<string, number>();
  for (const l of labels) if (l.color) used.set(l.color, (used.get(l.color) ?? 0) + 1);
  const keys = Object.keys(PROJECT_COLORS);
  const fewest = Math.min(...keys.map((k) => used.get(k) ?? 0));
  return keys.find((k) => (used.get(k) ?? 0) === fewest)!;
}

/**
 * Creates a label (or returns the existing one with that name), giving a new
 * label its own colour. `pending` holds labels created since the cached list
 * was fetched, so several made at once get different colours.
 */
export async function createLabel(name: string, pending: Label[] = []): Promise<Label> {
  const known = [...(queryClient.getQueryData<Label[]>(["labels"]) ?? []), ...pending];
  return api.labels.create(name, nextLabelColor(known));
}

export async function setLabelColor(id: string, color: string | null) {
  try {
    // An empty string clears the colour.
    await api.labels.update(id, undefined, color ?? "");
    invalidate("labels");
  } catch (e) {
    toastError(describeError(e, "Couldn't change the label colour."));
  }
}

export function LabelDot({ label, size = 8 }: { label: Pick<Label, "color"> | undefined; size?: number }) {
  return <span className="label-dot" style={{ width: size, height: size, background: labelColor(label) ?? "var(--text-4)" }} aria-hidden />;
}

export function LabelChip({ label }: { label: Label }) {
  return (
    <span className="chip label-chip">
      <LabelDot label={label} size={7} />
      {label.name}
    </span>
  );
}

export function LabelColorSwatches({ value, onChange }: { value: string | null; onChange: (color: string | null) => void }) {
  const custom = isCustomColor(value) ? value : null;
  return (
    <div className="label-swatches" role="radiogroup" aria-label="Label colour">
      <button type="button" className="swatch" role="radio" aria-checked={!value} data-active={!value || undefined} onClick={() => onChange(null)} aria-label="No colour" title="No colour" style={{ background: "var(--text-4)" }} />
      {Object.entries(PROJECT_COLORS).map(([k, c]) => (
        <button
          key={k}
          type="button"
          className="swatch"
          role="radio"
          aria-checked={value === k}
          data-active={value === k || undefined}
          onClick={() => onChange(k)}
          aria-label={k}
          title={k[0].toUpperCase() + k.slice(1)}
          style={{ background: c }}
        />
      ))}
      <label className="swatch swatch--custom" data-active={!!custom || undefined} title="Custom colour" style={custom ? { background: custom } : undefined}>
        {!custom && <Pipette size={10} />}
        <input type="color" value={custom ?? "#8aa9dc"} onChange={(e) => onChange(e.target.value.toLowerCase())} aria-label="Custom colour" />
      </label>
    </div>
  );
}

/** A colour dot that opens the label's colour swatches. */
export function LabelColorPicker({ label, trigger, size = 10 }: { label: Label; trigger?: ReactElement; size?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      pad
      trigger={
        trigger ?? (
          <button type="button" className="label-dot-btn" aria-label={`Colour of ${label.name}`} title="Change colour">
            <LabelDot label={label} size={size} />
          </button>
        )
      }
    >
      <LabelColorSwatches value={label.color} onChange={(c) => void setLabelColor(label.id, c)} />
    </Popover>
  );
}
