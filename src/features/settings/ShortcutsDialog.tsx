import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Button";
import { useUi } from "@/stores/ui";
import { useSetting } from "@/stores/settings";
import { SHORTCUTS, resolveBindings } from "@/lib/shortcuts";
import { navigate } from "@/stores/router";

export function ShortcutReference({ query }: { query: string }) {
  const bindings = resolveBindings(useSetting("keyboard.shortcuts"));
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = SHORTCUTS.filter((s) => !q || s.label.toLowerCase().includes(q) || (bindings[s.id] ?? "").toLowerCase().includes(q));
    const out = new Map<string, typeof list>();
    for (const s of list) {
      if (!out.has(s.group)) out.set(s.group, []);
      out.get(s.group)!.push(s);
    }
    return [...out.entries()];
  }, [query, bindings]);
  return (
    <div className="col" style={{ gap: 16 }}>
      {groups.map(([g, list]) => (
        <div key={g} className="col" style={{ gap: 2 }}>
          <div className="section-title" style={{ marginBottom: 4 }}>
            {g}
          </div>
          {list.map((s) => (
            <div key={s.id} className="row" style={{ justifyContent: "space-between", height: 28, fontSize: "var(--fs-sm)" }}>
              <span className="muted">{s.label}</span>
              {s.fixed ? (
                <span className="kbd">
                  {s.default!.split(" / ").map((part, i) => (
                    <span key={i} className="row" style={{ gap: 3 }}>
                      {i > 0 && <span className="faint">/</span>}
                      <Kbd combo={part.includes("–") ? undefined : part}>{part.includes("–") ? part : undefined}</Kbd>
                    </span>
                  ))}
                </span>
              ) : bindings[s.id] ? (
                <Kbd combo={bindings[s.id]} />
              ) : (
                <span className="faint">Unassigned</span>
              )}
            </div>
          ))}
        </div>
      ))}
      {!groups.length && <div className="empty empty--compact">No shortcuts match</div>}
    </div>
  );
}

export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const set = useUi((s) => s.set);
  const [q, setQ] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => set({ shortcutsOpen: o })}
      title="Keyboard shortcuts"
      wide
      footer={
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            set({ shortcutsOpen: false });
            navigate({ name: "settings", section: "keyboard" });
          }}
        >
          Customise…
        </button>
      }
    >
      <div className="input-wrap">
        <Search />
        <input className="input" autoFocus placeholder="Search shortcuts" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ShortcutReference query={q} />
    </Dialog>
  );
}
