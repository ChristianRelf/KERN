/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { Tooltip as T } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import { comboParts } from "@/lib/shortcuts";

export function TooltipProvider({ children }: { children: ReactNode }) {
  // A short intentional delay; moving across adjacent items shows instantly.
  return (
    <T.Provider delayDuration={450} skipDelayDuration={250}>
      {children}
    </T.Provider>
  );
}

export function Tooltip({
  content,
  shortcut,
  side = "bottom",
  children,
  disabled,
}: {
  content: ReactNode;
  shortcut?: string | null;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
  disabled?: boolean;
}) {
  if (disabled || !content) return children;
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content className="tooltip" side={side} sideOffset={6} collisionPadding={8}>
          <span>{content}</span>
          {shortcut && (
            <span className="kbd">
              {comboParts(shortcut).map((p, i) => (
                <kbd key={i}>{p}</kbd>
              ))}
            </span>
          )}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
