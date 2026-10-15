/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// One menu description renders as either a dropdown or a context menu, so
// every object's actions are defined once and stay consistent.

import { ContextMenu as CM, DropdownMenu as DM } from "radix-ui";
import { Check, ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { formatCombo } from "@/lib/shortcuts";

export type MenuEntry =
  | {
      type?: "item";
      label: string;
      icon?: LucideIcon;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      onSelect: () => void;
    }
  | { type: "separator" }
  | { type: "label"; label: string }
  | { type: "submenu"; label: string; icon?: LucideIcon; items: MenuEntry[]; disabled?: boolean };

export type MenuItems = (MenuEntry | false | null | undefined)[];

const clean = (items: MenuItems): MenuEntry[] => {
  const out = items.filter(Boolean) as MenuEntry[];
  // Drop leading/trailing/double separators produced by conditionals.
  return out.filter(
    (e, i) =>
      e.type !== "separator" ||
      (i > 0 && i < out.length - 1 && out[i - 1].type !== "separator"),
  );
};

type Prims = typeof DM | typeof CM;

function renderEntries(P: Prims, items: MenuEntry[]): ReactNode {
  return items.map((e, i) => {
    if (e.type === "separator") return <P.Separator key={i} className="menu__sep" />;
    if (e.type === "label")
      return (
        <P.Label key={i} className="menu__label">
          {e.label}
        </P.Label>
      );
    if (e.type === "submenu") {
      const Icon = e.icon;
      return (
        <P.Sub key={i}>
          <P.SubTrigger className="menu__item" disabled={e.disabled}>
            {Icon && <Icon strokeWidth={1.75} />}
            <span className="truncate">{e.label}</span>
            <ChevronRight size={14} className="menu__sub-arrow" />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent className="menu" sideOffset={4} collisionPadding={8}>
              {renderEntries(P, clean(e.items))}
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      );
    }
    const Icon = e.icon;
    return (
      <P.Item
        key={i}
        className={`menu__item ${e.danger ? "menu__item--danger" : ""}`}
        disabled={e.disabled}
        onSelect={() => e.onSelect()}
      >
        {Icon && <Icon strokeWidth={1.75} />}
        <span className="truncate">{e.label}</span>
        {e.checked && <Check size={14} className="menu__check" />}
        {e.shortcut && !e.checked && <span className="menu__hint">{formatCombo(e.shortcut)}</span>}
      </P.Item>
    );
  });
}

export function Dropdown({
  items,
  children,
  align = "start",
  side = "bottom",
  onOpenChange,
  minWidth,
}: {
  items: MenuItems | (() => MenuItems);
  children: ReactElement;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  onOpenChange?: (open: boolean) => void;
  minWidth?: number;
}) {
  return (
    <DM.Root onOpenChange={onOpenChange} modal={false}>
      <DM.Trigger asChild>{children}</DM.Trigger>
      <DM.Portal>
        <DM.Content className="menu" align={align} side={side} sideOffset={4} collisionPadding={8} style={{ minWidth }}>
          {renderEntries(DM, clean(typeof items === "function" ? items() : items))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

/** Wraps children with a right-click menu. Items are computed on open. */
export function ContextMenu({
  items,
  children,
  disabled,
  onOpenChange,
}: {
  items: () => MenuItems;
  children: ReactElement;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  if (disabled) return children;
  return (
    <CM.Root onOpenChange={onOpenChange} modal={false}>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className="menu" collisionPadding={8}>
          <LazyEntries items={items} />
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

/** Renders entries inside an existing Radix menu content element. */
export function MenuContent({ kind, items }: { kind: "context" | "dropdown"; items: MenuItems }) {
  return <>{renderEntries(kind === "context" ? CM : DM, clean(items))}</>;
}

function LazyEntries({ items }: { items: () => MenuItems }) {
  return <>{renderEntries(CM, clean(items()))}</>;
}
