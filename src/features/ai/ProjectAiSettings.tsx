import { Sparkles } from "lucide-react";
import type { Project, ProjectAiPrefs } from "@/lib/types";
import { Popover, Select, Switch } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { useSetting } from "@/stores/settings";
import { updateProject } from "@/features/projects/actions";
import { useProjectFolder } from "@/features/projects/folders";
import { navigate } from "@/stores/router";
import { useAiAccounts } from "./AccountsTab";

/** Per-project AI preferences (shown in the project's Details). */
export function ProjectAiSettings({ project }: { project: Project }) {
  const prefs: ProjectAiPrefs = project.aiPrefs ?? {};
  const inherit = prefs.inherit !== false;
  const { data: accounts } = useAiAccounts();
  const { data: folder } = useProjectFolder(project.id, !!project.folderPath);
  const globalFolders = useSetting("privacy.aiLinkedFolders");
  const globalContent = useSetting("privacy.aiProjectContent");
  const account = accounts?.find((a) => a.id === prefs.accountId);
  const set = (p: ProjectAiPrefs) => void updateProject(project.id, { aiPrefs: { ...prefs, ...p } });

  // File access needs: a linked, trusted folder + global permission + this switch.
  const blocker = !project.folderPath
    ? "Link a folder first."
    : folder && folder.trust !== "trusted"
      ? "The folder is in restricted mode. Trust it first."
      : !globalFolders
        ? "AI access to linked folders is off in Privacy settings."
        : null;

  const summary = !accounts?.length ? "Not set up" : inherit ? "Default routing" : (account?.name ?? "Default routing");

  return (
    <Popover
      pad
      trigger={
        <button type="button" className="prop-btn" data-empty={inherit}>
          <Sparkles size={14} />
          <span className="truncate">{summary}</span>
        </button>
      }
    >
      <div className="col" style={{ gap: 12, width: 300, fontSize: "var(--fs-sm)" }}>
        <b>AI for this project</b>
        {!accounts?.length ? (
          <span className="faint">
            No AI accounts yet.{" "}
            <button type="button" className="link-btn" onClick={() => navigate({ name: "api", tab: "accounts" })}>
              Add one
            </button>
          </span>
        ) : (
          <>
            <label className="row" style={{ gap: 8 }}>
              <Switch checked={inherit} onChange={(v) => set({ inherit: v })} label="Use the default routing" />
              Use the default account routing
            </label>
            {!inherit && (
              <>
                <div className="col" style={{ gap: 4 }}>
                  <span className="faint">Preferred account</span>
                  <Select
                    value={prefs.accountId ?? "default"}
                    onChange={(v) => set({ accountId: v === "default" ? null : v, model: null })}
                    ariaLabel="Preferred account"
                    options={[{ value: "default", label: "Primary account" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
                  />
                </div>
                <div className="col" style={{ gap: 4 }}>
                  <span className="faint">Preferred model</span>
                  {account?.models.length ? (
                    <Select
                      value={prefs.model ?? "default"}
                      onChange={(v) => set({ model: v === "default" ? null : v })}
                      ariaLabel="Preferred model"
                      options={[{ value: "default", label: `Account default${account.preferredModel ? ` (${account.preferredModel})` : ""}` }, ...account.models.map((m) => ({ value: m, label: m }))]}
                    />
                  ) : (
                    <input className="input mono" defaultValue={prefs.model ?? ""} placeholder="Account default" onBlur={(e) => set({ model: e.target.value.trim() || null })} aria-label="Preferred model" />
                  )}
                </div>
              </>
            )}
          </>
        )}
        <Tooltip content={globalContent ? "Catch-up summaries may send this project's task titles, note titles, milestones and activity to your AI provider, after showing you what's included." : "AI access to project content is off in Privacy settings."}>
          <label className="row" style={{ gap: 8, opacity: globalContent ? 1 : 0.55 }}>
            <Switch checked={prefs.contentAccess !== false && globalContent} disabled={!globalContent} onChange={(v) => set({ contentAccess: v })} label="Allow AI catch-up summaries" />
            Allow AI catch-up summaries
          </label>
        </Tooltip>
        <Tooltip content={blocker ?? "AI features may read files in this project's folder. Files that look like secrets (.env, keys) are always excluded."}>
          <label className="row" style={{ gap: 8, opacity: blocker ? 0.55 : 1 }}>
            <Switch checked={!!prefs.fileAccess && !blocker} disabled={!!blocker} onChange={(v) => set({ fileAccess: v })} label="Allow AI to read the linked folder" />
            Allow AI to read the linked folder
          </label>
        </Tooltip>
        {blocker && <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: -6 }}>{blocker}</span>}
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Trusting a folder never sends its files anywhere by itself — this permission is separate.</span>
      </div>
    </Popover>
  );
}
