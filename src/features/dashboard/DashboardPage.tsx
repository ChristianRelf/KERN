import { Check, Copy, EyeOff, LayoutGrid, Ellipsis, Pencil, Plus, RotateCcw, Settings2, Star, Trash, X, Eye } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Responsive, WidthProvider, type Layout, type Layouts } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { format } from "date-fns";
import type { Dashboard, GridItem, GridLayouts, WidgetInstance } from "@/lib/types";
import { useDashboards } from "@/hooks/data";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { toastError, toast } from "@/stores/toast";
import { navigate } from "@/stores/router";
import { useSetting } from "@/stores/settings";
import { useToday } from "@/hooks/useToday";
import { parseDateStr } from "@/lib/dates";
import { Button, IconButton } from "@/components/ui/Button";
import { ContextMenu, Dropdown, type MenuItems } from "@/components/ui/Menu";
import { Dialog, confirm, prompt } from "@/components/ui/Dialog";
import { Popover, Select, Skeleton } from "@/components/ui/Controls";
import { WIDGETS, WIDGET_MAP } from "./registry";
import { TEMPLATES, buildTemplate, deriveLayouts, newWidgetId } from "./templates";
import { useDashboardUi } from "./store";
import type { WidgetDef } from "./types";

const Grid = WidthProvider(Responsive);
const BREAKPOINTS = { lg: 1100, md: 720, sm: 0 };
const COLS = { lg: 12, md: 8, sm: 4 };
const ROW_HEIGHT = { compact: 30, comfortable: 34, relaxed: 38 } as const;

let creatingDefault: Promise<unknown> | null = null;

export function DashboardPage({ dashboardId }: { dashboardId?: string }) {
  const { data: dashboards, isLoading } = useDashboards();

  useEffect(() => {
    if (isLoading || !dashboards || dashboards.length || creatingDefault) return;
    const t = buildTemplate(TEMPLATES[0]);
    creatingDefault = api.dashboards
      .create("Daily", t.widgets, t.layouts)
      .then(() => invalidate("dashboards"))
      .catch((e) => toastError(describeError(e, "Couldn't create the dashboard.")))
      .finally(() => (creatingDefault = null));
  }, [dashboards, isLoading]);

  const current = dashboards?.find((d) => d.id === dashboardId) ?? dashboards?.find((d) => d.isDefault) ?? dashboards?.[0];
  if (!current)
    return (
      <div className="page">
        <header className="page-header">
          <h1 className="page-header__title">
            <LayoutGrid /> Dashboard
          </h1>
        </header>
        <div className="page-loading">
          <Skeleton height={180} />
        </div>
      </div>
    );
  return <DashboardView key={current.id} dashboard={current} all={dashboards!} />;
}

function DashboardView({ dashboard, all }: { dashboard: Dashboard; all: Dashboard[] }) {
  const editing = useDashboardUi((s) => s.editing);
  const setEditing = useDashboardUi((s) => s.setEditing);
  const density = useSetting("appearance.density");
  const showHeader = useSetting("dashboard.showHeader");
  const today = useToday();
  const [widgets, setWidgets] = useState<WidgetInstance[]>(dashboard.widgets);
  const [layouts, setLayouts] = useState<GridLayouts>(dashboard.layouts);
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [newLayoutOpen, setNewLayoutOpen] = useState(false);
  const pending = useRef<{ widgets?: WidgetInstance[]; layouts?: GridLayouts }>({});
  const timer = useRef<number | undefined>(undefined);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = {};
    if (!p.widgets && !p.layouts) return;
    void api.dashboards
      .update(dashboard.id, p)
      .then((d) => queryClient.setQueryData<Dashboard[]>(["dashboards"], (old) => old?.map((x) => (x.id === d.id ? d : x))))
      .catch((e) => toastError(describeError(e, "Couldn't save the dashboard."), () => void api.dashboards.update(dashboard.id, p).then(() => invalidate("dashboards"))));
  }, [dashboard.id]);

  const schedule = useCallback(
    (p: { widgets?: WidgetInstance[]; layouts?: GridLayouts }) => {
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
  useEffect(() => () => setEditing(false), [setEditing]);

  const visible = widgets.filter((w) => !w.hidden && WIDGET_MAP.has(w.type));
  const hidden = widgets.filter((w) => w.hidden);

  const updateWidgets = (next: WidgetInstance[]) => {
    setWidgets(next);
    schedule({ widgets: next });
  };

  const setConfig = (id: string, patch: Record<string, unknown>) =>
    setWidgets((prev) => {
      const next = prev.map((w) => (w.id === id ? { ...w, config: { ...w.config, ...patch } } : w));
      schedule({ widgets: next });
      return next;
    });

  const addWidget = (def: WidgetDef) => {
    const id = newWidgetId();
    const item: GridItem = { i: id, x: 0, y: Infinity, w: def.defaultSize.w, h: def.defaultSize.h, minW: def.minSize.w, minH: def.minSize.h };
    const nextLayouts: GridLayouts = {};
    for (const bp of Object.keys(COLS) as (keyof typeof COLS)[]) {
      nextLayouts[bp] = [...(layouts[bp] ?? []), { ...item, w: Math.min(item.w, COLS[bp]) }];
    }
    const next = [...widgets, { id, type: def.type, config: structuredClone(def.defaultConfig) }];
    setWidgets(next);
    setLayouts(nextLayouts);
    schedule({ widgets: next, layouts: nextLayouts });
    setCatalogueOpen(false);
  };

  const duplicate = (w: WidgetInstance) => {
    const def = WIDGET_MAP.get(w.type);
    if (!def) return;
    const id = newWidgetId();
    const src = (layouts.lg ?? []).find((l) => l.i === w.id);
    const nextLayouts: GridLayouts = {};
    for (const bp of Object.keys(COLS) as (keyof typeof COLS)[]) {
      const s = (layouts[bp] ?? []).find((l) => l.i === w.id) ?? src;
      nextLayouts[bp] = [...(layouts[bp] ?? []), { i: id, x: s?.x ?? 0, y: Infinity, w: s?.w ?? def.defaultSize.w, h: s?.h ?? def.defaultSize.h, minW: def.minSize.w, minH: def.minSize.h }];
    }
    const next = [...widgets, { id, type: w.type, config: structuredClone(w.config) }];
    setWidgets(next);
    setLayouts(nextLayouts);
    schedule({ widgets: next, layouts: nextLayouts });
  };

  const remove = (w: WidgetInstance) => {
    const prevW = widgets;
    const prevL = layouts;
    const next = widgets.filter((x) => x.id !== w.id);
    const nextLayouts: GridLayouts = Object.fromEntries(Object.entries(layouts).map(([bp, l]) => [bp, l.filter((i) => i.i !== w.id)]));
    setWidgets(next);
    setLayouts(nextLayouts);
    schedule({ widgets: next, layouts: nextLayouts });
    toast(`Removed ${WIDGET_MAP.get(w.type)?.name ?? "widget"}`, {
      action: {
        label: "Undo",
        run: () => {
          setWidgets(prevW);
          setLayouts(prevL);
          schedule({ widgets: prevW, layouts: prevL });
        },
      },
    });
  };

  const setHidden = (w: WidgetInstance, hiddenFlag: boolean) => updateWidgets(widgets.map((x) => (x.id === w.id ? { ...x, hidden: hiddenFlag } : x)));

  const onLayoutChange = (_: Layout[], all: Layouts) => {
    // Only persist user-initiated changes (edit mode); the grid also emits
    // on mount and breakpoint changes.
    if (!editing) return;
    const next = all as unknown as GridLayouts;
    setLayouts(next);
    schedule({ layouts: next });
  };

  const applyTemplate = async (templateId: string) => {
    const t = TEMPLATES.find((x) => x.id === templateId);
    if (!t) return;
    const ok = await confirm({
      title: `Reset “${dashboard.name}” to the ${t.name} layout?`,
      message: "Widgets and their settings on this layout are replaced.",
      confirmLabel: "Reset layout",
    });
    if (!ok) return;
    const built = buildTemplate(t);
    setWidgets(built.widgets);
    setLayouts(built.layouts);
    schedule(built);
  };

  const layoutMenu: MenuItems = [
    ...(all.length > 1
      ? all.map((d) => ({
          label: d.name,
          checked: d.id === dashboard.id,
          onSelect: () => navigate({ name: "dashboard", id: d.id }, { replace: true }),
        }))
      : []),
    all.length > 1 && { type: "separator" },
    { label: "New layout…", icon: Plus, onSelect: () => setNewLayoutOpen(true) },
    {
      label: "Rename layout",
      icon: Pencil,
      onSelect: async () => {
        const name = await prompt({ title: "Rename layout", initial: dashboard.name });
        if (name) await api.dashboards.update(dashboard.id, { name }).then(() => invalidate("dashboards"));
      },
    },
    {
      label: "Duplicate layout",
      icon: Copy,
      onSelect: async () => {
        flush();
        const d = await api.dashboards.create(`${dashboard.name} copy`, widgets, layouts);
        invalidate("dashboards");
        navigate({ name: "dashboard", id: d.id }, { replace: true });
      },
    },
    !dashboard.isDefault && {
      label: "Use as home",
      icon: Star,
      onSelect: () => void api.dashboards.update(dashboard.id, { isDefault: true }).then(() => invalidate("dashboards")),
    },
    {
      type: "submenu",
      label: "Reset to template",
      icon: RotateCcw,
      items: TEMPLATES.map((t) => ({ label: t.name, onSelect: () => void applyTemplate(t.id) })),
    },
    all.length > 1 && { type: "separator" },
    all.length > 1 && {
      label: "Delete layout",
      icon: Trash,
      danger: true,
      onSelect: async () => {
        if (!(await confirm({ title: `Delete “${dashboard.name}”?`, message: "This layout and its widget settings are removed.", confirmLabel: "Delete", danger: true }))) return;
        await api.dashboards.delete(dashboard.id).catch((e) => toastError(describeError(e)));
        invalidate("dashboards");
        navigate({ name: "dashboard" }, { replace: true });
      },
    },
  ];

  const gridLayouts = useMemo(() => {
    const ids = new Set(visible.map((w) => w.id));
    const out: Layouts = {};
    for (const [bp, items] of Object.entries(layouts)) {
      out[bp] = items
        .filter((i) => ids.has(i.i))
        .map((i) => {
          const def = WIDGET_MAP.get(visible.find((w) => w.id === i.i)!.type)!;
          return { ...i, minW: Math.min(def.minSize.w, COLS[bp as keyof typeof COLS] ?? 12), minH: def.minSize.h };
        });
    }
    // Ensure every visible widget has a position at least on lg.
    if (!out.lg) out.lg = [];
    for (const w of visible) {
      if (!out.lg.some((i) => i.i === w.id)) {
        const def = WIDGET_MAP.get(w.type)!;
        out.lg.push({ i: w.id, x: 0, y: Infinity, w: def.defaultSize.w, h: def.defaultSize.h, minW: def.minSize.w, minH: def.minSize.h });
      }
    }
    if (!layouts.md || !layouts.sm) {
      const derived = deriveLayouts(out.lg as GridItem[]);
      out.md = out.md ?? derived.md;
      out.sm = out.sm ?? derived.sm;
    }
    return out;
  }, [layouts, visible]);

  return (
    <div className="page">
      {showHeader && (
        <header className="page-header">
          <h1 className="page-header__title">
            <LayoutGrid />
            {all.length > 1 ? dashboard.name : "Dashboard"}
          </h1>
          <span className="dash-date">{format(parseDateStr(today), "EEEE d MMMM")}</span>
          <div className="page-header__actions">
            {editing ? (
              <>
                <Button size="sm" icon={Plus} onClick={() => setCatalogueOpen(true)}>
                  Add widget
                </Button>
                <Button size="sm" variant="primary" icon={Check} onClick={() => setEditing(false)}>
                  Done
                </Button>
              </>
            ) : (
              <IconButton icon={Pencil} label="Edit layout" onClick={() => setEditing(true)} />
            )}
            <Dropdown items={layoutMenu} align="end">
              <IconButton icon={Ellipsis} label="Layouts" noTooltip />
            </Dropdown>
          </div>
        </header>
      )}
      <div className="dash" data-editing={editing}>
        {!showHeader && editing && (
          <div className="row" style={{ justifyContent: "flex-end", padding: "8px 4px 0", gap: 6 }}>
            <Button size="sm" icon={Plus} onClick={() => setCatalogueOpen(true)}>
              Add widget
            </Button>
            <Button size="sm" variant="primary" icon={Check} onClick={() => setEditing(false)}>
              Done
            </Button>
          </div>
        )}
        {visible.length === 0 ? (
          <div className="empty" style={{ marginTop: 60 }}>
            <LayoutGrid strokeWidth={1.5} />
            <div className="empty__title">This layout is empty</div>
            <Button
              icon={Plus}
              onClick={() => {
                setEditing(true);
                setCatalogueOpen(true);
              }}
            >
              Add a widget
            </Button>
          </div>
        ) : (
          <Grid
            className="react-grid-layout"
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
            onLayoutChange={onLayoutChange}
            useCSSTransforms
          >
            {visible.map((w) => {
              const l = (gridLayouts.lg ?? []).find((i) => i.i === w.id);
              return (
                <div key={w.id}>
                  <WidgetFrame
                    widget={w}
                    editing={editing}
                    size={{ w: l?.w ?? 4, h: l?.h ?? 4 }}
                    setConfig={(p) => setConfig(w.id, p)}
                    onDuplicate={() => duplicate(w)}
                    onHide={() => setHidden(w, true)}
                    onRemove={() => remove(w)}
                    onEditLayout={() => setEditing(true)}
                  />
                </div>
              );
            })}
          </Grid>
        )}
      </div>
      <Dialog open={catalogueOpen} onOpenChange={setCatalogueOpen} title="Add widget" wide>
        <div className="catalogue">
          {WIDGETS.map((d) => {
            const exists = d.single && widgets.some((w) => w.type === d.type && !w.hidden);
            return (
              <button key={d.type} type="button" className="catalogue__item" disabled={exists} style={exists ? { opacity: 0.45 } : undefined} onClick={() => addWidget(d)}>
                <d.icon strokeWidth={1.75} />
                <div>
                  <div className="catalogue__name">{d.name}</div>
                  <div className="catalogue__desc">{exists ? "Already on this layout" : d.description}</div>
                </div>
              </button>
            );
          })}
        </div>
        {hidden.length > 0 && (
          <div className="col" style={{ gap: 4 }}>
            <div className="section-title">Hidden widgets</div>
            {hidden.map((w) => {
              const d = WIDGET_MAP.get(w.type);
              return (
                <div key={w.id} className="row" style={{ justifyContent: "space-between", fontSize: "var(--fs-sm)" }}>
                  <span>{(w.config.title as string) || d?.name}</span>
                  <Button
                    size="sm"
                    icon={Eye}
                    onClick={() => {
                      setHidden(w, false);
                      setCatalogueOpen(false);
                    }}
                  >
                    Show
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Dialog>
      {newLayoutOpen && <NewLayoutDialog onClose={() => setNewLayoutOpen(false)} />}
    </div>
  );
}

function WidgetFrame({
  widget,
  editing,
  size,
  setConfig,
  onDuplicate,
  onHide,
  onRemove,
  onEditLayout,
}: {
  widget: WidgetInstance;
  editing: boolean;
  size: { w: number; h: number };
  setConfig: (p: Record<string, unknown>) => void;
  onDuplicate: () => void;
  onHide: () => void;
  onRemove: () => void;
  onEditLayout: () => void;
}) {
  const def = WIDGET_MAP.get(widget.type)!;
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
              <Popover
                open={configOpen}
                onOpenChange={setConfigOpen}
                align="end"
                pad
                trigger={<IconButton icon={Settings2} label="Configure widget" size="sm" />}
              >
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

function NewLayoutDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("daily");
  const create = async () => {
    const t = TEMPLATES.find((x) => x.id === template)!;
    const built = buildTemplate(t);
    try {
      const d = await api.dashboards.create(name.trim() || t.name, built.widgets, built.layouts);
      invalidate("dashboards");
      navigate({ name: "dashboard", id: d.id }, { replace: true });
      onClose();
    } catch (e) {
      toastError(describeError(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New dashboard layout"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <div className="field">
        <label className="field__label">Name</label>
        <input className="input" autoFocus value={name} placeholder={TEMPLATES.find((t) => t.id === template)?.name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
      </div>
      <div className="field">
        <label className="field__label">Start from</label>
        <Select value={template} onChange={setTemplate} options={TEMPLATES.map((t) => ({ value: t.id, label: t.name }))} />
        <span className="field__hint">{TEMPLATES.find((t) => t.id === template)?.description}</span>
      </div>
    </Dialog>
  );
}
