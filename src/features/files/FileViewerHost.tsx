// Opens a file in Kern's viewer from anywhere (search results, a resumed
// workspace), for a project's folder or one of its repositories.

import type { FileEntry, ProjectFolder } from "@/lib/types";
import { api, describeError, KernError } from "@/lib/ipc";
import { useUi } from "@/stores/ui";
import { toastError } from "@/stores/toast";
import { confirm } from "@/components/ui/Dialog";
import { useProjectFolder } from "@/features/projects/folders";
import { useRepos } from "@/features/dev/hooks";
import { FileViewer } from "./FileViewer";

export function FileViewerHost() {
  const target = useUi((s) => s.openFile);
  const repoId = target?.repositoryId ?? null;
  const { data: folder } = useProjectFolder(target?.projectId, !!target && !repoId);
  const { data: repos } = useRepos(target?.projectId, !!target && !!repoId);
  if (!target) return null;
  const close = () => useUi.getState().set({ openFile: null });
  let root: ProjectFolder | null | undefined = folder;
  if (repoId) {
    const r = repos?.find((x) => x.id === repoId);
    if (!r?.localPath) return null;
    const trusted = r.trust === "trusted";
    root = {
      projectId: target.projectId,
      path: r.localPath,
      name: r.name,
      status: r.localStatus === "ok" ? "ok" : "missing",
      trust: trusted ? "trusted" : "restricted",
      capabilities: { browse: true, openDocuments: true, openPrograms: trusted, modify: trusted, aiFiles: false, aiFilesReason: null },
      linkedAt: r.createdAt,
    };
  }
  if (!root) return null;
  const name = target.rel.split("/").pop() ?? target.rel;
  const entry: FileEntry = { name, rel: target.rel, isDir: false, isLink: false, size: null, modified: null, program: false, sensitive: false, hidden: name.startsWith(".") };
  const openExternal = async (e: FileEntry) => {
    try {
      await api.folders.open(target.projectId, e.rel, false, repoId);
    } catch (err) {
      if (err instanceof KernError && err.message === "confirm_program") {
        if (await confirm({ title: `Run ${e.name}?`, message: "This is a program or script. Only run it if you trust where it came from.", confirmLabel: "Run", danger: true }))
          await api.folders.open(target.projectId, e.rel, true, repoId).catch((x) => toastError(describeError(x)));
      } else toastError(describeError(err, "Couldn't open the file."));
    }
  };
  return <FileViewer projectId={target.projectId} repositoryId={repoId} folder={root} entry={entry} onClose={close} onOpenExternal={(e) => void openExternal(e)} />;
}
