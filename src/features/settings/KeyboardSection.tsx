import { RotateCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useSetting, setSetting } from "@/stores/settings";
import { SHORTCUTS, comboFromEvent, findConflict, formatCombo, resolveBindings } from "@/lib/shortcuts";
import { Button, IconButton, Kbd } from "@/components/ui/Button";
import { toastError } from "@/stores/toast";

function Recorder({ id, value, onDone }: { id: string; value: string | null; onDone: () => void }) {
  const overrides = useSetting("keyboard.shortcuts");
  const bindings = resolveBindings(overrides);
  return (
    <button
      type="button"
      className="shortcut-capture"
      data-recording="true"
      autoFocus
      onBlur={onDone}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") return onDone();
        const combo = comboFromEvent(e);
        if (!combo) return;
        if (!/^(Mod|Alt|Ctrl)\+/.test(combo) && !/^F\d+$/.test(combo)) {
          toastError("Use a modifier (Ctrl or Alt) so typing isn't intercepted.");
          return;
        }
        const c = findConflict(id, combo, bindings);
        if (c.reserved) {
          toastError(`${formatCombo(combo)} is reserved for text editing.`);
          return;
        }
        const next = { ...overrides, [id]: combo };
        if (c.conflictWith) next[c.conflictWith.id] = null; // move the binding, don't duplicate it
        void setSetting("keyboard.shortcuts", next);
        if (c.conflictWith) toastError(`${formatCombo(combo)} was used by “${c.conflictWith.label}”, which is now unassigned.`);
        onDone();
      }}
    >
      {value ? `Replacing ${formatCombo(value)}…` : "Press keys…"}
    </button>
  );
}

export function KeyboardSection() {
  const overrides = useSetting("keyboard.shortcuts");
  const bindings = resolveBindings(overrides);
  const [q, setQ] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return SHORTCUTS.filter((d) => !s || d.label.toLowerCase().includes(s) || (bindings[d.id] ?? "").toLowerCase().includes(s) || d.group.toLowerCase().includes(s));
  }, [q, bindings]);
  const groups = [...new Set(list.map((d) => d.group))];
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row">
        <div className="input-wrap grow" style={{ maxWidth: 320 }}>
          <Search />
          <input className="input" placeholder="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="spacer" />
        {Object.keys(overrides).length > 0 && (
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void setSetting("keyboard.shortcuts", {})}>
            Reset all
          </Button>
        )}
      </div>
      {groups.map((g) => (
        <div key={g}>
          <div className="set-group__title">{g}</div>
          <div className="set-group">
            {list
              .filter((d) => d.group === g)
              .map((d) => {
                const custom = d.id in overrides;
                return (
                  <div key={d.id} className="set-row" style={{ minHeight: 40 }}>
                    <div className="set-row__text">
                      <span className="set-row__label">{d.label}</span>
                      {d.global && <span className="set-row__hint">Works while typing</span>}
                    </div>
                    <div className="set-row__control">
                      {d.fixed ? (
                        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{d.default}</span>
                      ) : recording === d.id ? (
                        <Recorder id={d.id} value={bindings[d.id]} onDone={() => setRecording(null)} />
                      ) : (
                        <button type="button" className="shortcut-capture" onClick={() => setRecording(d.id)} title="Click to change">
                          {bindings[d.id] ? <Kbd combo={bindings[d.id]} /> : <span className="faint">Unassigned</span>}
                        </button>
                      )}
                      {!d.fixed && custom && (
                        <IconButton
                          icon={RotateCcw}
                          label="Reset to default"
                          size="sm"
                          onClick={() => {
                            const next = { ...overrides };
                            delete next[d.id];
                            void setSetting("keyboard.shortcuts", next);
                          }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
      <p className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        Text-editing shortcuts (copy, paste, undo, bold…) can't be reassigned. Mouse back/forward buttons navigate between pages.
      </p>
    </div>
  );
}
