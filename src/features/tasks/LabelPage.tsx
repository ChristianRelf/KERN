import { Pencil, Tag, Trash } from "lucide-react";
import { useLabels, useTasks } from "@/hooks/data";
import { TaskList } from "./TaskList";
import { LabelColorPicker, labelColor } from "./labels";
import { IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Controls";
import { confirm, prompt } from "@/components/ui/Dialog";
import { api, describeError } from "@/lib/ipc";
import { invalidate, invalidateTasks } from "@/lib/query";
import { navigate } from "@/stores/router";
import { toastError } from "@/stores/toast";

/** All open tasks with a label. */
export function LabelPage({ labelId }: { labelId: string }) {
  const { data: labels } = useLabels();
  const label = labels?.find((l) => l.id === labelId);
  const { data: tasks } = useTasks({ labelIds: [labelId], order: "due" });
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-header__title">
          <Tag style={{ color: labelColor(label) }} /> {label?.name ?? "Label"}
        </h1>
        <div className="page-header__actions">
          {label && (
            <>
              <LabelColorPicker label={label} size={12} />
              <IconButton
                icon={Pencil}
                label="Rename label"
                onClick={async () => {
                  const name = await prompt({ title: "Rename label", initial: label.name });
                  if (name) await api.labels.update(label.id, name).then(() => invalidate("labels")).catch((e) => toastError(describeError(e)));
                }}
              />
              <IconButton
                icon={Trash}
                label="Delete label"
                onClick={async () => {
                  if (!(await confirm({ title: `Delete label “${label.name}”?`, message: "It's removed from all tasks. Tasks themselves are kept.", confirmLabel: "Delete label", danger: true }))) return;
                  await api.labels.delete(label.id);
                  invalidate("labels");
                  invalidateTasks();
                  navigate({ name: "tasks" }, { replace: true });
                }}
              />
            </>
          )}
        </div>
      </header>
      <TaskList
        sections={[{ key: "label", tasks: tasks ?? [], addDefaults: { labelIds: [labelId], status: "todo" }, collapsible: false }]}
        quickAddPosition="top"
        empty={<EmptyState icon={Tag}>No open tasks with this label.</EmptyState>}
      />
    </div>
  );
}
