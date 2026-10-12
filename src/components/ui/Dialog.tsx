import { Dialog as D } from "radix-ui";
import { X } from "lucide-react";
import { create } from "zustand";
import { useState, type ReactNode } from "react";
import { Button, IconButton } from "./Button";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
  centered,
  hideClose,
  className = "",
  onOpenAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  centered?: boolean;
  hideClose?: boolean;
  className?: string;
  onOpenAutoFocus?: (e: Event) => void;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="dialog-overlay" />
        <D.Content
          className={`dialog ${wide ? "dialog--wide" : ""} ${centered ? "dialog--centered" : ""} ${className}`}
          aria-describedby={undefined}
          onOpenAutoFocus={onOpenAutoFocus}
        >
          {title ? (
            <div className="dialog__header">
              <D.Title className="dialog__title grow">{title}</D.Title>
              {!hideClose && (
                <D.Close asChild>
                  <IconButton icon={X} label="Close" size="sm" noTooltip />
                </D.Close>
              )}
            </div>
          ) : (
            <D.Title className="sr-only">Dialog</D.Title>
          )}
          {(description || children) && (
            <div className="dialog__body">
              {description && <D.Description className="dialog__desc">{description}</D.Description>}
              {children}
            </div>
          )}
          {footer && <div className="dialog__footer">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ------------------------------------------------------------ confirm()
// Used only for irreversible actions; reversible ones use undo instead.

interface ConfirmReq {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ req: ConfirmReq | null }>(() => ({ req: null }));

export function confirm(opts: Omit<ConfirmReq, "resolve">): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ req: { ...opts, resolve } }));
}

export function ConfirmHost() {
  const req = useConfirm((s) => s.req);
  const [busy, setBusy] = useState(false);
  const close = (ok: boolean) => {
    req?.resolve(ok);
    setBusy(false);
    useConfirm.setState({ req: null });
  };
  return (
    <Dialog
      open={!!req}
      onOpenChange={(o) => !o && close(false)}
      title={req?.title}
      description={req?.message}
      centered
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            variant={req?.danger ? "danger" : "primary"}
            disabled={busy}
            autoFocus
            onClick={() => {
              setBusy(true);
              close(true);
            }}
          >
            {req?.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    />
  );
}

// ------------------------------------------------------------ prompt()

interface PromptReq {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  resolve: (v: string | null) => void;
}

const usePrompt = create<{ req: PromptReq | null }>(() => ({ req: null }));

export function prompt(opts: Omit<PromptReq, "resolve">): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ req: { ...opts, resolve } }));
}

export function PromptHost() {
  const req = usePrompt((s) => s.req);
  return req ? <PromptDialog key={req.title + (req.initial ?? "")} req={req} /> : null;
}

function PromptDialog({ req }: { req: PromptReq }) {
  const [value, setValue] = useState(req.initial ?? "");
  const close = (v: string | null) => {
    req.resolve(v);
    usePrompt.setState({ req: null });
  };
  const submit = () => {
    if (value.trim()) close(value.trim());
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close(null)}
      title={req.title}
      centered
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!value.trim()}>
            {req.confirmLabel ?? "Save"}
          </Button>
        </>
      }
    >
      <div className="field">
        {req.label && <label className="field__label">{req.label}</label>}
        <input
          className="input"
          autoFocus
          value={value}
          placeholder={req.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
    </Dialog>
  );
}
