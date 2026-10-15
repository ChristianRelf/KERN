/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { useUi } from "@/stores/ui";
import { Dialog } from "@/components/ui/Dialog";
import { TaskDetail } from "./TaskDetail";

/** Task details as a modal (detail mode "modal"). */
export function TaskModal() {
  const id = useUi((s) => s.modalTaskId);
  const set = useUi((s) => s.set);
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && set({ modalTaskId: null })} title="Task" wide>
      {id && <TaskDetail id={id} onClose={() => set({ modalTaskId: null })} />}
    </Dialog>
  );
}
