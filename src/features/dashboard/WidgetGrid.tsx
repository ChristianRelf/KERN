/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// The editable widget grid shared by dashboards and the Project Command
// Centre: layout state with debounced persistence, the responsive grid, the
// widget frame and the "Add widget" catalogue.

import { Copy, EyeOff, Pencil, Settings2, X, Ellipsis, Eye } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Responsive, type Layout, type Layouts } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import type { GridItem, GridLayouts, WidgetInstance } from "@/lib/types";
import { useSetting } from "@/stores/settings";
import { toast } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { ContextMenu, Dropdown, type MenuItems } from "@/components/ui/Menu";
import { Dialog } from "@/components/ui/Dialog";
import { Popover } from "@/components/ui/Controls";
import { deriveLayouts, newWidgetId } from "./templates";
import type { WidgetDef } from "./types";

export const BREAKPOINTS = { lg: 880, md: 560, sm: 0 };
export const COLS = { lg: 12, md: 8, sm: 4 };
const ROW_HEIGHT = { compact: 30, comfortable: 34, relaxed: 38 } as const;

/** Container width via ResizeObserver (tracks scrollbars and panel resizes). */
export function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export interface WidgetDoc {
  widgets: WidgetInstance[];
  layouts: GridLayouts;
}

/**
 * Widget/layout state with debounced persistence. `persist` receives the
 * changed parts; it's flushed on unmount and when editing ends.
 */
export function useWidgetDoc(initial: WidgetDoc, defs: Map<string, WidgetDef>, persist: (p: Partial<WidgetDoc>) => void, editing: boolean) {
  const [widgets, setWidgets] = useState<WidgetInstance[]>(initial.widgets);
  const [layouts, setLayouts] = useState<GridLayouts>(initial.layouts);
  const pending = useRef<Partial<WidgetDoc>>({});
  const timer = useRef<number | undefined>(undefined);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = {};
    if (!p.widgets && !p.layouts) return;
    persistRef.current(p);
  }, []);

  const schedule = useCallback(
    (p: Partial<WidgetDoc>) => {
      pending.current = { ...pending.current, ...p };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 500);
    },
    [flush],
  );

  useEffect(() => () => flush(), [flush]);
  useEffect(() => {
    if (!editing) flush();
  }, [editing, flush]);

  const replace = (doc: WidgetDoc) => {
    setWidgets(doc.widgets);
    setLayouts(doc.layouts);
    schedule(doc);
  };

  const setConfig = (id: string, patch: Record<string, unknown>) =>
    setWidgets((prev) => {
      const next = prev.map((w) => (w.id === id ? { ...w, config: { ...w.config, ...patch } } : w));
      schedule({ widgets: next });
      return next;
    });

  const add = (def: WidgetDef, config?: Record<string, unknown>) => {
    const id = newWidgetId();
    const item: GridItem = { i: id, x: 0, y: Infinity, w: def.defaultSize.w, h: def.defaultSize.h, minW: def.minSize.w, minH: def.minSize.h };
    const nextLayouts: GridLayouts = {};
    for (const bp of Object.keys(COLS) as (keyof typeof COLS)[]) {
      nextLayouts[bp] = [...(layouts[bp] ?? []), { ...item, w: Math.min(item.w, COLS[bp]) }];
    }
    const next = [...widgets, { id, type: def.type, config: { ...structuredClone(def.defaultConfig), ...(config ?? {}) } }];
    replace({ widgets: next, layouts: nextLayouts });
  };

  const duplicate = (w: WidgetInstance) => {
    const def = defs.get(w.type);
    if (!def) return;
    const id = newWidgetId();
    const src = (layouts.lg ?? []).find((l) => l.i === w.id);
    const nextLayouts: GridLayouts = {};
    for (const bp of Object.keys(COLS) as (keyof typeof COLS)[]) {
      const s = (layouts[bp] ?? []).find((l) => l.i === w.id) ?? src;
      nextLayouts[bp] = [...(layouts[bp] ?? []), { i: id, x: s?.x ?? 0, y: Infinity, w: s?.w ?? def.defaultSize.w, h: s?.h ?? def.defaultSize.h, minW: def.minSize.w, minH: def.minSize.h }];
    }
    replace({ widgets: [...widgets, { id, type: w.type, config: structuredClone(w.config) }], layouts: nextLayouts });
  };

  const remove = (w: WidgetInstance) => {
    const prev = { widgets, layouts };
    const next = widgets.filter((x) => x.id !== w.id);
    const nextLayouts: GridLayouts = Object.fromEntries(Object.entries(layouts).map(([bp, l]) => [bp, l.filter((i) => i.i !== w.id)]));
    replace({ widgets: next, layouts: nextLayouts });
    toast(`Removed ${defs.get(w.type)?.name ?? "widget"}`, { action: { label: "Undo", run: () => replace(prev) } });
  };

  const setHidden = (w: WidgetInstance, hidden: boolean) => {
    const next = widgets.map((x) => (x.id === w.id ? { ...x, hidden } : x));
    setWidgets(next);
    schedule({ widgets: next });
  };

  const onLayoutChange = (_: Layout[], all: Layouts) => {
    // Only persist user-initiated changes (edit mode); the grid also emits
    // on mount and breakpoint changes.
    if (!editing) return;
    const next = all as unknown as GridLayouts;
    setLayouts(next);
    schedule({ layouts: next });
  };

  return { widgets, layouts, setConfig, add, duplicate, remove, setHidden, onLayoutChange, replace, flush };
}

export type WidgetDocApi = ReturnType<typeof useWidgetDoc>;

export function WidgetGrid({ doc, defs, editing, onEditLayout, width }: { doc: WidgetDocApi; defs: Map<string, WidgetDef>; editing: boolean; onEditLayout: () => void; width: number }) {
  const density = useSetting("appearance.density");
  const visible = useMemo(() => doc.widgets.filter((w) => !w.hidden && defs.has(w.type)), [doc.widgets, defs]);

  const gridLayouts = useMemo(() => {
    const ids = new Set(visible.map((w) => w.id));
    const out: Layouts = {};
    for (const [bp, items] of Object.entries(doc.layouts)) {
      out[bp] = items
        .filter((i) => ids.has(i.i))
        .map((i) => {
          const def = defs.get(visible.find((w) => w.id === i.i)!.type)!;
          return { ...i, minW: Math.min(def.minSize.w, COLS[bp as keyof typeof COLS] ?? 12), minH: def.minSize.h };
        });
    }
    // Ensure every visible widget has a position at least on lg.
    if (!out.lg) out.lg = [];
    for (const w of visible) {
      if (!out.lg.some((i) => i.i === w.id)) {
        const def = defs.get(w.type)!;
        out.lg.push({ i: w.id, x: 0, y: Infinity, w: def.defaultSize.w, h: def.defaultSize.h, minW: def.minSize.w, minH: def.minSize.h });
      }
    }
    // Re-derive smaller layouts that are missing, incomplete or don't fit their columns.
    const derived = deriveLayouts(out.lg as GridItem[]);
    for (const bp of ["md", "sm"] as const) {
      const items = out[bp];
      const valid = items && items.length === out.lg.length && items.every((i) => i.x + i.w <= COLS[bp]);
      if (!valid) out[bp] = derived[bp];
    }
    return out;
  }, [doc.layouts, visible, defs]);

  if (width <= 0) return null;
  return (
    <Responsive
      className="react-grid-layout"
      width={width - 16}
      layouts={gridLayouts}
      breakpoints={BREAKPOINTS}
      cols={COLS}
      rowHeight={ROW_HEIGHT[density]}
      margin={[12, 12]}
      containerPadding={[8, 10]}
      isDraggable={editing}
      isResizable={editing}
      compactType="vertical"
      draggableCancel=".no-drag"
      onLayoutChange={doc.onLayoutChange}
      useCSSTransforms
    >
      {visible.map((w) => {
        const l = (gridLayouts.lg ?? []).find((i) => i.i === w.id);
        return (
          <div key={w.id}>
            <WidgetFrame
              widget={w}
              def={defs.get(w.type)!}
              editing={editing}
              size={{ w: l?.w ?? 4, h: l?.h ?? 4 }}
              setConfig={(p) => doc.setConfig(w.id, p)}
              onDuplicate={() => doc.duplicate(w)}
              onHide={() => doc.setHidden(w, true)}
              onRemove={() => doc.remove(w)}
              onEditLayout={onEditLayout}
            />
          </div>
        );
      })}
    </Responsive>
  );
}

function WidgetFrame({
  widget,
  def,
  editing,
  size,
  setConfig,
  onDuplicate,
  onHide,
  onRemove,
  onEditLayout,
}: {
  widget: WidgetInstance;
  def: WidgetDef;
  editing: boolean;
  size: { w: number; h: number };
  setConfig: (p: Record<string, unknown>) => void;
  onDuplicate: () => void;
  onHide: () => void;
  onRemove: () => void;
  onEditLayout: () => void;
}) {
  const [configOpen, setConfigOpen] = useState(false);
  const title = def.title?.(widget.config) ?? ((widget.config.title as string) || def.name);
  const menu: MenuItems = [
    def.Config && { label: "Configure", icon: Settings2, onSelect: () => setConfigOpen(true) },
    !def.single && { label: "Duplicate", icon: Copy, onSelect: onDuplicate },
    { label: "Hide", icon: EyeOff, onSelect: onHide },
    !editing && { label: "Edit layout", icon: Pencil, onSelect: onEditLayout },
    { type: "separator" },
    { label: "Remove widget", icon: X, danger: true, onSelect: onRemove },
  ];
  const Body = def.Component;
  const Header = def.HeaderActions;
  return (
    <ContextMenu items={() => menu}>
      <section className="widget" data-editing={editing} aria-label={title}>
        <div className="widget__head">
          <h2 className="widget__title">
            <def.icon strokeWidth={1.75} />
            <span className="widget__title-text">{title}</span>
          </h2>
          <div className="widget__actions no-drag">
            {!editing && Header && <Header id={widget.id} config={widget.config} setConfig={setConfig} size={size} editing={editing} />}
            {def.Config && (
              <Popover open={configOpen} onOpenChange={setConfigOpen} align="end" pad trigger={<IconButton icon={Settings2} label="Configure widget" size="sm" />}>
                <def.Config config={widget.config} setConfig={setConfig} />
              </Popover>
            )}
            {editing ? (
              <IconButton icon={X} label="Remove widget" size="sm" onClick={onRemove} />
            ) : (
              <Dropdown items={menu} align="end">
                <IconButton icon={Ellipsis} label="Widget actions" size="sm" noTooltip />
              </Dropdown>
            )}
          </div>
        </div>
        <div className={`widget__body ${def.flush ? "widget__body--flush" : ""}`}>
          <Body id={widget.id} config={widget.config} setConfig={setConfig} size={size} editing={editing} />
        </div>
      </section>
    </ContextMenu>
  );
}

/** "Add widget" dialog, optionally grouped into sections. */
export function WidgetCatalogue({
  open,
  onOpenChange,
  groups,
  doc,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  groups: { title?: string; defs: WidgetDef[] }[];
  doc: WidgetDocApi;
}) {
  const hidden = doc.widgets.filter((w) => w.hidden);
  const allDefs = new Map(groups.flatMap((g) => g.defs).map((d) => [d.type, d]));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add widget" wide>
      {groups.map((g, gi) => (
        <div key={gi} className="col" style={{ gap: 6 }}>
          {g.title && <div className="section-title">{g.title}</div>}
          <div className="catalogue">
            {g.defs.map((d) => {
              const exists = d.single && doc.widgets.some((w) => w.type === d.type && !w.hidden);
              return (
                <button
                  key={d.type}
                  type="button"
                  className="catalogue__item"
                  disabled={exists}
                  style={exists ? { opacity: 0.45 } : undefined}
                  onClick={() => {
                    doc.add(d);
                    onOpenChange(false);
                  }}
                >
                  <d.icon strokeWidth={1.75} />
                  <div>
                    <div className="catalogue__name">{d.name}</div>
                    <div className="catalogue__desc">{exists ? "Already on this layout" : d.description}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {hidden.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <div className="section-title">Hidden widgets</div>
          {hidden.map((w) => (
            <div key={w.id} className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
              <span>{(w.config.title as string) || allDefs.get(w.type)?.name || w.type}</span>
              <Button
                size="sm"
                icon={Eye}
                onClick={() => {
                  doc.setHidden(w, false);
                  onOpenChange(false);
                }}
              >
                Show
              </Button>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
