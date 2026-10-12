import { Check, Copy, LayoutGrid, Ellipsis, Pencil, Plus, RotateCcw, Star, Trash, History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import type { Dashboard, GridLayouts, WidgetInstance } from "@/lib/types";
import { useDashboards } from "@/hooks/data";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { navigate } from "@/stores/router";
import { useSetting } from "@/stores/settings";
import { useToday } from "@/hooks/useToday";
import { parseDateStr } from "@/lib/dates";
import { Button, IconButton } from "@/components/ui/Button";
import { Dropdown, type MenuItems } from "@/components/ui/Menu";
import { Dialog, confirm, prompt } from "@/components/ui/Dialog";
import { Select, Skeleton } from "@/components/ui/Controls";
import { WIDGET_GROUPS, WIDGET_MAP } from "./registry";
import { TEMPLATES, buildTemplate } from "./templates";
import { useDashboardUi } from "./store";
import { WidgetCatalogue, WidgetGrid, useWidgetDoc, useWidth } from "./WidgetGrid";
import { resumeWork } from "@/features/workspace/store";

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
  const showHeader = useSetting("dashboard.showHeader");
  const today = useToday();
  const [catalogueOpen, setCatalogueOpen] = useState(false);
  const [newLayoutOpen, setNewLayoutOpen] = useState(false);
  const { ref: dashRef, width } = useWidth();

  const persist = useCallback(
    (p: { widgets?: WidgetInstance[]; layouts?: GridLayouts }) =>
      void api.dashboards
        .update(dashboard.id, p)
        .then((d) => queryClient.setQueryData<Dashboard[]>(["dashboards"], (old) => old?.map((x) => (x.id === d.id ? d : x))))
        .catch((e) => toastError(describeError(e, "Couldn't save the dashboard."), () => void api.dashboards.update(dashboard.id, p).then(() => invalidate("dashboards")))),
    [dashboard.id],
  );
  const doc = useWidgetDoc({ widgets: dashboard.widgets, layouts: dashboard.layouts }, WIDGET_MAP, persist, editing);
  const { widgets, layouts, flush } = doc;
  useEffect(() => () => setEditing(false), [setEditing]);

  const visible = widgets.filter((w) => !w.hidden && WIDGET_MAP.has(w.type));

  const applyTemplate = async (templateId: string) => {
    const t = TEMPLATES.find((x) => x.id === templateId);
    if (!t) return;
    const ok = await confirm({
      title: `Reset “${dashboard.name}” to the ${t.name} layout?`,
      message: "Widgets and their settings on this layout are replaced.",
      confirmLabel: "Reset layout",
    });
    if (!ok) return;
    doc.replace(buildTemplate(t));
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
              <>
                <IconButton icon={History} label="Resume work" onClick={() => void resumeWork()} />
                <IconButton icon={Pencil} label="Edit layout" onClick={() => setEditing(true)} />
              </>
            )}
            <Dropdown items={layoutMenu} align="end">
              <IconButton icon={Ellipsis} label="Layouts" noTooltip />
            </Dropdown>
          </div>
        </header>
      )}
      <div className="dash" data-editing={editing} ref={dashRef}>
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
          <WidgetGrid doc={doc} defs={WIDGET_MAP} editing={editing} onEditLayout={() => setEditing(true)} width={width} />
        )}
      </div>
      <WidgetCatalogue open={catalogueOpen} onOpenChange={setCatalogueOpen} groups={WIDGET_GROUPS} doc={doc} />
      {newLayoutOpen && <NewLayoutDialog onClose={() => setNewLayoutOpen(false)} />}
    </div>
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
