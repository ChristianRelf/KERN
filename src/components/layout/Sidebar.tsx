import {
  ChevronDown,
  Coffee,
  FolderKanban,
  Inbox,
  LayoutGrid,
  ListFilter,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Presentation,
  Search,
  Settings,
  SquareCheckBig,
  StickyNote,
  Sunrise,
  Timer,
  Trash,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useGroups, useOverview, useProjects, useViews } from "@/hooks/data";
import { useRouter, navigate, type Route } from "@/stores/router";
import { useSetting, setSetting } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { IconButton } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { ContextMenu, Dropdown } from "@/components/ui/Menu";
import { Ring } from "@/components/ui/Controls";
import { ProjectGlyph } from "@/features/projects/ProjectGlyph";
import { newGroup, projectMenu } from "@/features/projects/actions";
import { useFocus, remainingOf, KIND_LABEL } from "@/features/focus/store";
import { useNow } from "@/hooks/useToday";
import { formatClock } from "@/lib/dates";
import { api } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import type { NavItemId } from "@/features/settings/schema";
import type { Project, ProjectGroup } from "@/lib/types";
import { resolveBindings } from "@/lib/shortcuts";
import { prompt, confirm } from "@/components/ui/Dialog";
import { APP_NAME } from "@/app/brand";
import { BrandMark } from "@/app/BrandMark";

export const NAV: Record<NavItemId, { label: string; icon: LucideIcon; route: Route; shortcut?: string }> = {
  dashboard: { label: "Dashboard", icon: LayoutGrid, route: { name: "dashboard" }, shortcut: "goDashboard" },
  tasks: { label: "My Tasks", icon: SquareCheckBig, route: { name: "tasks" }, shortcut: "goTasks" },
  inbox: { label: "Inbox", icon: Inbox, route: { name: "inbox" }, shortcut: "goInbox" },
  projects: { label: "Projects", icon: FolderKanban, route: { name: "projects" }, shortcut: "goProjects" },
  whiteboards: { label: "Whiteboards", icon: Presentation, route: { name: "whiteboards" }, shortcut: "goWhiteboards" },
  notes: { label: "Notes", icon: StickyNote, route: { name: "notes" }, shortcut: "goNotes" },
  search: { label: "Search", icon: Search, route: { name: "search" } },
  focus: { label: "Focus", icon: Timer, route: { name: "focus" }, shortcut: "focusMode" },
  rundown: { label: "Daily Rundown", icon: Sunrise, route: { name: "rundown" }, shortcut: "rundown" },
};

function isActive(item: NavItemId, r: Route): boolean {
  switch (item) {
    case "dashboard":
      return r.name === "dashboard";
    case "tasks":
      return r.name === "tasks";
    case "inbox":
      return r.name === "inbox";
    case "projects":
      return r.name === "projects";
    case "whiteboards":
      return r.name === "whiteboards" || r.name === "whiteboard";
    case "notes":
      return r.name === "notes";
    case "search":
      return r.name === "search";
    case "focus":
      return r.name === "focus";
    case "rundown":
      return r.name === "rundown";
  }
}

export function Sidebar() {
  const collapsed = useSetting("appearance.sidebarCollapsed");
  const width = useSetting("appearance.sidebarWidth");
  const navItems = useSetting("appearance.navItems");
  const shortcuts = resolveBindings(useSetting("keyboard.shortcuts"));
  const route = useRouter((s) => s.route);
  const { data: overview } = useOverview();
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const resizing = useRef(false);

  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(184, Math.min(380, startW + ev.clientX - startX));
      setLiveWidth(w);
    };
    const up = () => {
      resizing.current = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLiveWidth(null);
      void setSetting("appearance.sidebarWidth", Math.round(w));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const counts: Partial<Record<NavItemId, number>> = {
    inbox: overview?.inbox,
    tasks: overview ? overview.dueToday + overview.overdue : undefined,
  };

  return (
    <aside
      className="sidebar"
      data-collapsed={collapsed}
      data-resizing={liveWidth !== null}
      style={{ "--sidebar-w": `${liveWidth ?? width}px` } as CSSProperties}
      aria-label="Navigation"
    >
      <div className="sidebar__top">
        <div className="brand">
          <Tooltip content={collapsed ? "Expand sidebar" : undefined} side="right" disabled={!collapsed}>
            <button
              type="button"
              className="row"
              style={{ gap: 8 }}
              onClick={() => collapsed && void setSetting("appearance.sidebarCollapsed", false)}
              aria-label={collapsed ? "Expand sidebar" : APP_NAME}
            >
              <BrandMark className="brand__mark" />
            </button>
          </Tooltip>
          <span className="brand__name truncate">{APP_NAME}</span>
        </div>
        <IconButton icon={Search} label="Search & commands" shortcut={shortcuts.palette} size="sm" onClick={() => useUi.getState().setPalette(true)} />
        <IconButton icon={Plus} label="Quick capture" shortcut={shortcuts.quickCapture} size="sm" onClick={() => useUi.getState().openCapture()} />
      </div>

      <div className="sidebar__scroll">
        <nav className="col" style={{ gap: 1 }}>
          {navItems.map((id) => {
            const item = NAV[id];
            if (!item) return null;
            const count = counts[id];
            return (
              <NavButton
                key={id}
                icon={item.icon}
                label={item.label}
                active={isActive(id, route)}
                count={count}
                collapsed={collapsed}
                shortcut={item.shortcut ? shortcuts[item.shortcut] : undefined}
                onClick={() => navigate(item.route)}
              />
            );
          })}
        </nav>
        {!collapsed && <ViewsSection />}
        {!collapsed && <ProjectsSection />}
      </div>

      <div className="sidebar__bottom">
        <FocusPill collapsed={collapsed} />
        <NavButton
          icon={Trash}
          label="Trash"
          active={route.name === "trash"}
          collapsed={collapsed}
          onClick={() => navigate({ name: "trash" })}
        />
        <div className="row" style={{ gap: 2 }}>
          <div className="grow">
            <NavButton
              icon={Settings}
              label="Settings"
              active={route.name === "settings"}
              collapsed={collapsed}
              shortcut={shortcuts.goSettings}
              onClick={() => navigate({ name: "settings" })}
            />
          </div>
          {!collapsed && (
            <IconButton
              icon={PanelLeftClose}
              label="Collapse sidebar"
              shortcut={shortcuts.toggleSidebar}
              size="sm"
              onClick={() => void setSetting("appearance.sidebarCollapsed", true)}
            />
          )}
        </div>
        {collapsed && (
          <NavButton
            icon={PanelLeftOpen}
            label="Expand sidebar"
            collapsed
            shortcut={shortcuts.toggleSidebar}
            onClick={() => void setSetting("appearance.sidebarCollapsed", false)}
          />
        )}
      </div>
      {!collapsed && (
        <div
          className="resize-handle sidebar-resize"
          data-dragging={liveWidth !== null}
          onPointerDown={onResizeStart}
          onDoubleClick={() => void setSetting("appearance.sidebarWidth", 236)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />
      )}
    </aside>
  );
}

function NavButton({
  icon: Icon,
  label,
  active,
  count,
  collapsed,
  shortcut,
  onClick,
  glyph,
  actions,
  dot,
}: {
  icon?: LucideIcon;
  label: string;
  active?: boolean;
  count?: number;
  collapsed?: boolean;
  shortcut?: string | null;
  onClick: () => void;
  glyph?: React.ReactNode;
  actions?: React.ReactNode;
  dot?: boolean;
}) {
  const btn = (
    <button type="button" className="nav-item" data-active={active || undefined} onClick={onClick} aria-current={active ? "page" : undefined}>
      {glyph ?? (Icon && <Icon strokeWidth={1.75} />)}
      <span className="nav-item__label">{label}</span>
      {!!count && <span className="nav-item__count">{count}</span>}
      {dot && collapsed && <span className="nav-item__dot" />}
      {actions && <span className="nav-item__actions">{actions}</span>}
    </button>
  );
  return collapsed ? (
    <Tooltip content={count ? `${label} · ${count}` : label} shortcut={shortcut} side="right">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

function SectionHead({
  label,
  collapsed,
  onToggle,
  actions,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="sidebar__section-head" data-collapsed={collapsed}>
      <button type="button" className="sidebar__section-toggle" onClick={onToggle} aria-expanded={!collapsed}>
        {label}
        <ChevronDown />
      </button>
      {actions}
    </div>
  );
}

function ViewsSection() {
  const { data: views } = useViews();
  const route = useRouter((s) => s.route);
  const [open, setOpen] = useState(true);
  if (!views?.length) return null;
  return (
    <div className="sidebar__section">
      <SectionHead label="Views" collapsed={!open} onToggle={() => setOpen(!open)} />
      {open &&
        views.map((v) => (
          <ContextMenu
            key={v.id}
            items={() => [
              {
                label: "Rename",
                onSelect: async () => {
                  const name = await prompt({ title: "Rename view", initial: v.name });
                  if (name) {
                    await api.views.update(v.id, { name });
                    invalidate("views");
                  }
                },
              },
              {
                label: "Delete view",
                danger: true,
                onSelect: async () => {
                  if (await confirm({ title: `Delete "${v.name}"?`, message: "Only the saved filter is removed; tasks are unaffected.", confirmLabel: "Delete", danger: true })) {
                    await api.views.delete(v.id);
                    invalidate("views");
                    if (route.name === "view" && route.id === v.id) navigate({ name: "tasks" }, { replace: true });
                  }
                },
              },
            ]}
          >
            <div>
              <NavButton
                icon={ListFilter}
                label={v.name}
                active={route.name === "view" && route.id === v.id}
                onClick={() => navigate({ name: "view", id: v.id })}
              />
            </div>
          </ContextMenu>
        ))}
    </div>
  );
}

function sortProjects(list: Project[], order: "manual" | "recent" | "name") {
  const copy = [...list];
  if (order === "name") copy.sort((a, b) => a.name.localeCompare(b.name));
  else if (order === "recent") copy.sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
  else copy.sort((a, b) => a.sortOrder - b.sortOrder);
  return copy;
}

function ProjectsSection() {
  const { data: projects } = useProjects(false);
  const { data: groups } = useGroups();
  const grouping = useSetting("projects.grouping");
  const order = useSetting("projects.sidebarOrder");
  const showProgress = useSetting("projects.showProgress");
  const route = useRouter((s) => s.route);
  const [open, setOpen] = useState(true);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const pinned = useMemo(() => sortProjects((projects ?? []).filter((p) => p.pinned), order), [projects, order]);
  const rest = useMemo(() => sortProjects((projects ?? []).filter((p) => !p.pinned), order), [projects, order]);
  const useGroupsLayout = grouping === "groups" && (groups?.length ?? 0) > 0;

  // Flat order used for drag & drop: ungrouped first, then each group.
  const sections = useMemo(() => {
    if (!useGroupsLayout) return [{ group: null, items: rest }];
    const out: { group: ProjectGroup | null; items: Project[] }[] = [
      { group: null, items: rest.filter((p) => !p.groupId || !groups!.some((g) => g.id === p.groupId)) },
    ];
    for (const g of groups!) out.push({ group: g, items: rest.filter((p) => p.groupId === g.id) });
    return out;
  }, [rest, groups, useGroupsLayout]);

  const onDragEnd = useCallback(
    async (e: DragEndEvent) => {
      if (!e.over || e.active.id === e.over.id) return;
      const flat = sections.flatMap((s) => s.items);
      const from = flat.findIndex((p) => p.id === e.active.id);
      const to = flat.findIndex((p) => p.id === e.over!.id);
      if (from < 0 || to < 0) return;
      const moved = arrayMove(flat, from, to);
      const target = flat[to];
      const dragged = flat[from];
      const ids = [...pinned.map((p) => p.id), ...moved.map((p) => p.id)];
      if (useGroupsLayout && (target.groupId ?? null) !== (dragged.groupId ?? null)) {
        await api.projects.update(dragged.id, { groupId: target.groupId ?? null });
      }
      await api.projects.reorder(ids);
      invalidate("projects");
    },
    [sections, pinned, useGroupsLayout],
  );

  const activeProjectId = route.name === "project" ? route.id : null;
  const item = (p: Project) => (
    <SortableProject key={p.id} project={p} active={activeProjectId === p.id} showProgress={showProgress} groups={groups ?? []} draggable={order === "manual"} />
  );

  return (
    <>
      {pinned.length > 0 && (
        <div className="sidebar__section">
          <SectionHead label="Pinned" collapsed={false} onToggle={() => undefined} />
          {pinned.map((p) => (
            <ProjectItem key={p.id} project={p} active={activeProjectId === p.id} showProgress={showProgress} groups={groups ?? []} />
          ))}
        </div>
      )}
      <div className="sidebar__section">
        <SectionHead
          label="Projects"
          collapsed={!open}
          onToggle={() => setOpen(!open)}
          actions={
            <Dropdown
              items={[
                { label: "New project", icon: Plus, onSelect: () => useUi.getState().set({ createProjectOpen: true }) },
                { label: "New group", icon: FolderKanban, onSelect: () => void newGroup() },
              ]}
              align="end"
            >
              <IconButton icon={Plus} label="New project or group" size="sm" noTooltip />
            </Dropdown>
          }
        />
        {open && (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
            <SortableContext items={sections.flatMap((s) => s.items.map((p) => p.id))} strategy={verticalListSortingStrategy}>
              {sections.map((s) =>
                s.group ? (
                  <GroupBlock key={s.group.id} group={s.group}>
                    {s.items.map(item)}
                  </GroupBlock>
                ) : (
                  <div key="ungrouped">{s.items.map(item)}</div>
                ),
              )}
            </SortableContext>
          </DndContext>
        )}
        {open && !projects?.length && (
          <button type="button" className="nav-item" onClick={() => useUi.getState().set({ createProjectOpen: true })}>
            <Plus strokeWidth={1.75} />
            <span className="nav-item__label">New project</span>
          </button>
        )}
      </div>
    </>
  );
}

function GroupBlock({ group, children }: { group: ProjectGroup; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(group.collapsed);
  const toggle = () => {
    setCollapsed(!collapsed);
    void api.groups.update(group.id, { collapsed: !collapsed }).then(() => invalidate("groups"));
  };
  return (
    <div style={{ marginTop: 4 }}>
      <ContextMenu
        items={() => [
          {
            label: "Rename group",
            onSelect: async () => {
              const name = await prompt({ title: "Rename group", initial: group.name });
              if (name) {
                await api.groups.update(group.id, { name });
                invalidate("groups");
              }
            },
          },
          {
            label: "Delete group",
            danger: true,
            onSelect: async () => {
              if (await confirm({ title: `Delete group "${group.name}"?`, message: "Projects in it are kept and become ungrouped.", confirmLabel: "Delete group", danger: true })) {
                await api.groups.delete(group.id);
                invalidate("groups", "projects");
              }
            },
          },
        ]}
      >
        <div>
          <SectionHead label={group.name} collapsed={collapsed} onToggle={toggle} />
        </div>
      </ContextMenu>
      {!collapsed && children}
    </div>
  );
}

function SortableProject(props: { project: Project; active: boolean; showProgress: boolean; groups: ProjectGroup[]; draggable: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.project.id,
    disabled: !props.draggable,
  });
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    position: "relative",
    zIndex: isDragging ? 2 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} tabIndex={-1}>
      <ProjectItem {...props} />
    </div>
  );
}

function ProjectItem({
  project: p,
  active,
  showProgress,
  groups,
}: {
  project: Project;
  active: boolean;
  showProgress: boolean;
  groups: ProjectGroup[];
}) {
  const progress = p.taskTotal ? p.taskDone / p.taskTotal : 0;
  const open = p.taskTotal - p.taskDone;
  return (
    <ContextMenu items={() => projectMenu(p, groups)}>
      <div>
        <NavButton
          label={p.name}
          glyph={<ProjectGlyph project={p} />}
          active={active}
          onClick={() => navigate({ name: "project", id: p.id })}
          count={showProgress ? undefined : open || undefined}
          actions={
            showProgress && p.taskTotal > 0 ? (
              <Tooltip content={`${p.taskDone} of ${p.taskTotal} done`} side="right">
                <span className="row" style={{ marginRight: 6 }}>
                  <Ring value={progress} size={14} stroke={2} />
                </span>
              </Tooltip>
            ) : undefined
          }
        />
      </div>
    </ContextMenu>
  );
}

function FocusPill({ collapsed }: { collapsed: boolean }) {
  const focus = useFocus();
  const running = focus.phase === "running";
  const now = useNow(1000, focus.phase !== "idle");
  if (focus.phase === "idle") return null;
  const remaining = remainingOf(focus, now);
  const Icon = focus.kind === "focus" ? Timer : Coffee;
  const label = `${KIND_LABEL[focus.kind]}${running ? "" : " (paused)"}`;
  const pill = (
    <button type="button" className="focus-pill" onClick={() => navigate({ name: "focus" })} aria-label={label} style={collapsed ? { justifyContent: "center", padding: 0 } : undefined}>
      <Icon strokeWidth={1.75} />
      {!collapsed && (
        <>
          <span className="grow truncate" style={{ textAlign: "left" }}>
            {focus.taskTitle ?? KIND_LABEL[focus.kind]}
          </span>
          <span style={{ opacity: running ? 1 : 0.55 }}>{formatClock(remaining)}</span>
        </>
      )}
    </button>
  );
  return (
    <Tooltip content={`${label} · ${formatClock(remaining)}`} side="right" disabled={!collapsed}>
      {pill}
    </Tooltip>
  );
}
