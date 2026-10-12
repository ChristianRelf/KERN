import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Tooltip } from "./Tooltip";
import { comboParts } from "@/lib/shortcuts";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "md" | "sm";
  icon?: LucideIcon;
  block?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button(
  { variant = "default", size = "md", icon: Icon, block, className = "", children, type = "button", ...rest },
  ref,
) {
  const cls = [
    "btn",
    variant !== "default" && `btn--${variant}`,
    size === "sm" && "btn--sm",
    block && "btn--block",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button ref={ref} type={type} className={cls} {...rest}>
      {Icon && <Icon strokeWidth={1.75} />}
      {children}
    </button>
  );
});

type IconBtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  shortcut?: string | null;
  size?: "md" | "sm";
  active?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  /** Skip the tooltip (e.g. when wrapped by a menu trigger with its own). */
  noTooltip?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconBtnProps>(function IconButton(
  { icon: Icon, label, shortcut, size = "md", active, className = "", tooltipSide, noTooltip, type = "button", ...rest },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      data-active={active || undefined}
      className={`icon-btn ${size === "sm" ? "icon-btn--sm" : ""} ${className}`}
      {...rest}
    >
      <Icon strokeWidth={1.75} />
    </button>
  );
  if (noTooltip) return btn;
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {btn}
    </Tooltip>
  );
});

export function Kbd({ combo, children }: { combo?: string | null; children?: ReactNode }) {
  const parts = combo ? comboParts(combo) : [];
  return (
    <span className="kbd">
      {parts.map((p, i) => (
        <kbd key={i}>{p}</kbd>
      ))}
      {children && <kbd>{children}</kbd>}
    </span>
  );
}
