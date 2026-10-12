// Suggests syntax plugins for the languages a linked project folder uses,
// e.g. "This project uses TypeScript" when it's full of .ts files. Asks once
// per project per session; "Don't ask again" remembers the languages.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FileKindCount, Project } from "@/lib/types";
import { api } from "@/lib/ipc";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Controls";
import { Dialog } from "@/components/ui/Dialog";
import { setSetting, useSetting } from "@/stores/settings";
import { formatBytes } from "@/lib/dates";
import { SYNTAXES, type SyntaxPlugin } from "./catalog";
import { installSyntaxes, useInstalledGrammars } from "./syntax";

const askedThisSession = new Set<string>();

export interface Suggestion {
  syntax: SyntaxPlugin;
  files: number;
}

/** Code languages with at least two files (or one well-known file name) that aren't installed or declined. */
export function suggestSyntaxes(kinds: FileKindCount[], installed: string[], declined: string[], max = 4): Suggestion[] {
  const out: Suggestion[] = [];
  for (const s of SYNTAXES) {
    if (s.kind !== "code" || installed.includes(s.id) || declined.includes(s.id)) continue;
    const byExt = kinds.filter((k) => s.exts.includes(k.key)).reduce((n, k) => n + k.count, 0);
    const byName = kinds.filter((k) => s.names.includes(k.key)).reduce((n, k) => n + k.count, 0);
    if (byExt >= 2 || byName >= 1) out.push({ syntax: s, files: byExt + byName });
  }
  return out.sort((a, b) => b.files - a.files).slice(0, max);
}

export function SyntaxPrompt({ project }: { project: Pick<Project, "id" | "folderPath"> }) {
  const enabled = useSetting("plugins.suggestSyntax");
  const network = useSetting("privacy.network");
  const declined = useSetting("plugins.declined");
  const { data: installed } = useInstalledGrammars();
  const want = enabled && network && !!project.folderPath && !askedThisSession.has(project.id);
  const { data: kinds } = useQuery({
    queryKey: ["files", "kinds", project.id],
    queryFn: () => api.folders.kinds(project.id),
    enabled: want,
    staleTime: 10 * 60_000,
    retry: false,
  });
  const suggestions = useMemo(() => (kinds && installed ? suggestSyntaxes(kinds, installed, declined) : []), [kinds, installed, declined]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!want || !suggestions.length) return;
    askedThisSession.add(project.id);
    setPicked(new Set(suggestions.map((s) => s.syntax.id)));
    setOpen(true);
  }, [want, suggestions]);

  const chosen = suggestions.filter((s) => picked.has(s.syntax.id));
  const install = async () => {
    setBusy(true);
    const ok = await installSyntaxes(chosen.map((s) => s.syntax));
    setBusy(false);
    if (ok) setOpen(false);
  };
  const neverAsk = () => {
    void setSetting("plugins.declined", [...new Set([...declined, ...suggestions.map((s) => s.syntax.id)])]);
    setOpen(false);
  };

  const single = suggestions.length === 1 ? suggestions[0].syntax : null;
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      centered
      title={single ? `This project uses ${single.name}` : "Install syntax highlighting?"}
      footer={
        <>
          <Button variant="ghost" onClick={neverAsk}>
            Don't ask again
          </Button>
          <span className="spacer" />
          <Button onClick={() => setOpen(false)}>Not now</Button>
          <Button variant="primary" autoFocus disabled={!chosen.length || busy} onClick={() => void install()}>
            {busy ? "Installing…" : single ? `Install ${single.name} syntax` : `Install ${chosen.length}`}
          </Button>
        </>
      }
    >
      <p className="dialog__desc">
        Kern can colour {single ? `${single.name} code` : "these languages"} when you open files from this project. Syntaxes are small downloads from the jsDelivr CDN, checked before they're installed. You can manage them in Settings → Plugins.
      </p>
      <div className="syntax-suggest">
        {suggestions.map(({ syntax, files }) => (
          <label key={syntax.id} className="syntax-suggest__row">
            <Checkbox
              checked={picked.has(syntax.id)}
              onChange={(v) =>
                setPicked((p) => {
                  const n = new Set(p);
                  if (v) n.add(syntax.id);
                  else n.delete(syntax.id);
                  return n;
                })
              }
              label={syntax.name}
            />
            <span className="grow">{syntax.name}</span>
            <span className="faint">
              {files.toLocaleString()} file{files === 1 ? "" : "s"} · {formatBytes(syntax.size)}
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}
