// Settings → Developer tools: terminal, external editor, linked-folder
// search index, local services and work-session prompts. Everything here is
// optional; none of it affects projects without code.

import { FolderOpen, RefreshCw, Trash } from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, describeError } from "@/lib/ipc";
import { setSetting, useSetting } from "@/stores/settings";
import { toast, toastError } from "@/stores/toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Controls";
import { confirm } from "@/components/ui/Dialog";
import type { GroupDef } from "./controls";
import { SSegmented, SSlider, SToggle } from "./controls";

function ShellSelect() {
  const value = useSetting("terminal.shell");
  const { data: shells } = useQuery({ queryKey: ["pty", "shells"], queryFn: api.pty.shells, staleTime: Infinity });
  return (
    <Select
      value={value || "default"}
      onChange={(v) => void setSetting("terminal.shell", v === "default" ? "" : v)}
      ariaLabel="Shell"
      options={[{ value: "default", label: shells?.[0] ? `Default (${shells[0].name})` : "Default" }, ...(shells ?? []).map((s) => ({ value: s.id, label: s.name }))]}
    />
  );
}

function TextSetting({ k, placeholder, browse }: { k: "terminal.defaultCwd" | "dev.editor"; placeholder: string; browse?: boolean }) {
  const value = useSetting(k);
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="row" style={{ gap: 4 }}>
      <input className="input input--sm mono" style={{ width: 240 }} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && void setSetting(k, v.trim())} aria-label={placeholder} />
      {browse && (
        <IconButton
          icon={FolderOpen}
          label="Choose folder"
          size="sm"
          onClick={async () => {
            const f = await openDialog({ directory: true, title: "Default terminal folder" });
            if (typeof f === "string") void setSetting(k, f);
          }}
        />
      )}
    </div>
  );
}

function IndexStatus() {
  const { data, refetch } = useQuery({ queryKey: ["files", "indexStatus"], queryFn: api.files.status });
  const [busy, setBusy] = useState(false);
  return (
    <div className="row" style={{ gap: 8, fontSize: "var(--fs-sm)" }}>
      <span className="faint">{data ? `${data.files.toLocaleString()} files from ${data.indexed} of ${data.roots} linked folder${data.roots === 1 ? "" : "s"}${data.indexing ? " · indexing…" : ""}` : "…"}</span>
      <Button
        size="sm"
        icon={RefreshCw}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api.files.index(null, true);
            toast(`Indexed ${r.files.toLocaleString()} files (${r.updated} updated)`);
          } catch (e) {
            toastError(describeError(e));
          } finally {
            setBusy(false);
            void refetch();
          }
        }}
      >
        {busy ? "Indexing…" : "Update now"}
      </Button>
      <IconButton
        icon={Trash}
        label="Clear the index"
        size="sm"
        onClick={async () => {
          if (!(await confirm({ title: "Clear the file index?", message: "It's rebuilt the next time you search files or code. Your files aren't touched.", confirmLabel: "Clear" }))) return;
          await api.files.clear().catch((e) => toastError(describeError(e)));
          void refetch();
        }}
      />
    </div>
  );
}

export function developerGroups(): GroupDef[] {
  return [
    {
      title: "Terminal",
      rows: [
        { label: "Shell", keywords: "powershell cmd bash zsh wsl", control: <ShellSelect /> },
        { label: "Default folder", hint: "Used when a project has no linked folder.", keywords: "working directory cwd", control: <TextSetting k="terminal.defaultCwd" placeholder="Home folder" browse /> },
        { label: "Font size", control: <SSlider k="terminal.fontSize" min={10} max={18} step={0.5} format={(v) => `${v}px`} /> },
        {
          label: "Terminals shown",
          hint: "Terminals keep running either way.",
          control: <SSegmented k="terminal.scope" options={[{ value: "all", label: "All" }, { value: "project", label: "Current project's" }]} />,
        },
      ],
    },
    {
      title: "Editor",
      rows: [{ label: "Open folders with", hint: "A command such as code, cursor or idea. Leave empty to use the system file manager.", keywords: "vscode external editor", control: <TextSetting k="dev.editor" placeholder="code" /> }],
    },
    {
      title: "Search",
      rows: [
        { label: "Search linked folders", hint: "Indexes file names in linked folders and repositories, skipping dependencies, build output, ignored and secret-looking files.", keywords: "index files", control: <SToggle k="search.indexFiles" /> },
        { label: "Search inside code", hint: "Also indexes the text of small source files.", control: <SToggle k="search.codeSearch" /> },
        { label: "Index", block: <IndexStatus /> },
      ],
    },
    {
      title: "Services & sessions",
      rows: [
        { label: "Check services while a project is open", hint: "Only the services you've added, on their own interval. Nothing is checked in the background.", control: <SToggle k="services.pollWhileOpen" /> },
        { label: "Ask about time away", hint: "When a session was running while the computer slept or Kern was closed.", keywords: "idle gap sleep", control: <SToggle k="sessions.gapPrompt" /> },
      ],
    },
  ];
}
