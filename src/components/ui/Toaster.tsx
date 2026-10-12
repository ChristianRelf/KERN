import { CircleAlert, Check, Info } from "lucide-react";
import { useToasts } from "@/stores/toast";

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = t.tone === "error" ? CircleAlert : t.tone === "success" ? Check : Info;
        return (
          <div key={t.id} className="toast" data-tone={t.tone}>
            <Icon strokeWidth={1.75} />
            <span className="toast__msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
