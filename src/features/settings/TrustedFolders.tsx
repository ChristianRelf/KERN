/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { FolderOpen, FolderX, ShieldCheck, ShieldHalf, Trash } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, describeError } from "@/lib/ipc";
import { invalidate } from "@/lib/query";
import type { TrustRecord } from "@/lib/types";
import { IconButton } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import { askTrust, shortPath } from "@/features/projects/folders";
import { toastError } from "@/stores/toast";

/** Review, revoke or forget folder trust decisions. */
export function TrustedFolders() {
  const { data } = useQuery({ queryKey: ["trusted"], queryFn: api.folders.trusted });
  const update = async (r: TrustRecord, trust: TrustRecord["trust"] | null) => {
    if (trust === "trusted" && (await askTrust({ path: r.path, name: r.path.split(/[\\/]/).pop() ?? r.path, trust: r.trust, linkedProjects: r.projects })) !== "trusted") return;
    try {
      await api.folders.updateTrusted(r.path, trust);
      invalidate("trusted", "folder", "files", "projects", "project");
    } catch (e) {
      toastError(describeError(e));
    }
  };
  if (!data?.length) return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No folder decisions yet. They appear here when you link a project to a folder.</span>;
  return (
    <div className="col" style={{ gap: 2, width: "100%" }}>
      {data.map((r) => (
        <div key={r.path} className="list-row" style={{ minHeight: 34 }}>
          {r.exists ? <FolderOpen strokeWidth={1.75} /> : <FolderX strokeWidth={1.75} />}
          <span className="col grow" style={{ minWidth: 0 }}>
            <Tooltip content={r.path}>
              <span className="truncate mono" style={{ fontSize: "var(--fs-xs)" }}>
                {shortPath(r.path, 70)}
              </span>
            </Tooltip>
            <span className="faint truncate" style={{ fontSize: "var(--fs-2xs)" }}>
              {r.trust === "trusted" ? "Trusted" : "Restricted"}
              {r.projects.length ? ` · ${r.projects.join(", ")}` : " · not linked to a project"}
              {!r.exists && " · folder not found"}
            </span>
          </span>
          <div className="list-row__actions">
            {r.trust === "trusted" ? (
              <IconButton icon={ShieldHalf} label="Revoke trust (restricted mode)" size="sm" onClick={() => void update(r, "restricted")} />
            ) : (
              <IconButton icon={ShieldCheck} label="Trust folder…" size="sm" onClick={() => void update(r, "trusted")} />
            )}
            <IconButton icon={Trash} label="Forget this decision (ask again next time)" size="sm" onClick={() => void update(r, null)} />
          </div>
        </div>
      ))}
    </div>
  );
}
