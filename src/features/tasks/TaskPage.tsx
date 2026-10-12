import { ArrowLeft, SquareCheckBig } from "lucide-react";
import { useRouter } from "@/stores/router";
import { IconButton } from "@/components/ui/Button";
import { TaskDetail } from "./TaskDetail";

/** Full-page task details (detail mode "page", or "Open as page"). */
export function TaskPage({ id }: { id: string }) {
  const back = useRouter((s) => s.goBack);
  const canBack = useRouter((s) => s.back.length > 0);
  return (
    <div className="page">
      <header className="page-header">
        {canBack && <IconButton icon={ArrowLeft} label="Back" shortcut="Alt+ArrowLeft" onClick={back} />}
        <h1 className="page-header__title">
          <SquareCheckBig /> Task
        </h1>
      </header>
      <div className="page-body page-body--pad">
        <div className="page-body--readable" style={{ maxWidth: 720 }}>
          <TaskDetail id={id} onClose={back} />
        </div>
      </div>
    </div>
  );
}
