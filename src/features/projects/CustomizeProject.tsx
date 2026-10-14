// "Customize project": everything about how a project looks and opens in one
// place - name, description, icon or emoji, colour, which sections show and
// which one opens first, and where it sits in the sidebar. Changes apply as
// you make them (colour drags are debounced).

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Pin } from "lucide-react";
import type { Project, ProjectTab } from "@/lib/types";
import { useGroups, useProject } from "@/hooks/data";
import { useUi } from "@/stores/ui";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Select, Switch } from "@/components/ui/Controls";
import { AppearancePicker, type Appearance } from "./AppearancePicker";
import { ProjectGlyph, accentColor } from "./ProjectGlyph";
import { PROJECT_TABS } from "./tabs";
import { updateProject } from "./actions";

export default function CustomizeProjectHost() {
  const id = useUi((s) => s.customizeProjectId);
  const { data: p } = useProject(id);
  const close = () => useUi.getState().set({ customizeProjectId: null });
  return p ? <Customize key={p.id} p={p} onClose={close} /> : null;
}

function Customize({ p, onClose }: { p: Project; onClose: () => void }) {
  const { data: groups } = useGroups();
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  // Icon and colour preview immediately; the write is debounced.
  const [look, setLook] = useState<{ icon: string | null; accent: string | null }>({ icon: p.icon, accent: p.accent });
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Appearance>({});

  const flushLook = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) void updateProject(p.id, patch);
  };
  useEffect(() => () => flushLook(), []);

  const changeLook = (c: Appearance) => {
    setLook((l) => ({ ...l, ...c }));
    pending.current = { ...pending.current, ...c };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flushLook, 250);
  };

  const saveText = () => {
    const patch: { name?: string; description?: string } = {};
    if (name.trim() && name.trim() !== p.name) patch.name = name.trim();
    if (description !== p.description) patch.description = description;
    if (Object.keys(patch).length) void updateProject(p.id, patch);
  };

  const hidden = new Set(p.hiddenTabs ?? []);
  const toggleTab = (t: ProjectTab) => {
    const next = new Set(hidden);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    void updateProject(p.id, { hiddenTabs: [...next] });
  };
  const color = accentColor(look.accent);

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (o) return;
        saveText();
        flushLook();
        onClose();
      }}
      title="Customize project"
      className="customize"
      footer={
        <Button
          variant="primary"
          onClick={() => {
            saveText();
            flushLook();
            onClose();
          }}
        >
          Done
        </Button>
      }
    >
      <div className="customize__hero" style={color ? ({ "--tint": color } as React.CSSProperties) : undefined} data-tinted={!!color || undefined}>
        <span className="customize__mark">
          <ProjectGlyph project={{ name: name || p.name, ...look }} size={30} />
        </span>
        <div className="col grow" style={{ gap: 2 }}>
          <input className="customize__name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onBlur={saveText} aria-label="Project name" placeholder="Project name" />
          <textarea className="customize__desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={saveText} placeholder="Add a description" aria-label="Description" />
        </div>
      </div>

      <section className="customize__section">
        <span className="customize__label">Icon & colour</span>
        <AppearancePicker icon={look.icon} accent={look.accent} name={name || p.name} onChange={changeLook} />
      </section>

      <section className="customize__section">
        <span className="customize__label">Sections</span>
        <div className="chip-grid">
          {PROJECT_TABS.filter((t) => t.id !== "overview").map((t) => {
            const on = !hidden.has(t.id);
            return (
              <button key={t.id} type="button" className="choice-chip customize__tab" data-on={on || undefined} onClick={() => toggleTab(t.id)} aria-pressed={on}>
                <t.icon size={13} strokeWidth={1.75} />
                {t.label}
                {on ? <Eye size={12} className="faint" /> : <EyeOff size={12} className="faint" />}
              </button>
            );
          })}
        </div>
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Hidden sections keep their content; Files and Code still only appear once a folder or repository is linked.
        </span>
      </section>

      <section className="customize__section customize__grid">
        <span className="customize__label">Opens on</span>
        <Select<string>
          value={p.defaultView ?? "default"}
          onChange={(v) => void updateProject(p.id, { defaultView: v === "default" ? null : (v as ProjectTab) })}
          ariaLabel="Opens on"
          options={[{ value: "default", label: "Default" }, ...PROJECT_TABS.filter((t) => t.id === "overview" || !hidden.has(t.id)).map((t) => ({ value: t.id, label: t.label }))]}
        />
        <span className="customize__label">Group</span>
        <Select<string>
          value={p.groupId ?? "none"}
          onChange={(v) => void updateProject(p.id, { groupId: v === "none" ? null : v })}
          ariaLabel="Group"
          options={[{ value: "none", label: "No group" }, ...(groups ?? []).map((g) => ({ value: g.id, label: g.name }))]}
        />
        <span className="customize__label">
          <Pin size={12} /> Pinned
        </span>
        <Switch checked={p.pinned} onChange={(pinned) => void updateProject(p.id, { pinned })} label="Pin to the top of the sidebar" />
      </section>
    </Dialog>
  );
}
