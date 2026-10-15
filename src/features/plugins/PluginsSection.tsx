/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Settings → Plugins: install and remove syntax highlighting for the file
// viewer, and control the per-project suggestions.

import { Check, Download, Search, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Controls";
import { setSetting, useSetting } from "@/stores/settings";
import { SToggle } from "@/features/settings/controls";
import { formatBytes } from "@/lib/dates";
import { SYNTAXES, type SyntaxPlugin } from "./catalog";
import { installSyntaxes, removeSyntax, useInstalledGrammars } from "./syntax";
import { SyntaxIcon } from "./SyntaxIcon";

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row__text">
        <span className="set-row__label">{label}</span>
        {hint && <span className="set-row__hint">{hint}</span>}
      </div>
      {children && <div className="set-row__control">{children}</div>}
    </div>
  );
}

const extsLabel = (s: SyntaxPlugin) =>
  [...s.exts.map((e) => `.${e}`), ...s.names]
    .slice(0, 6)
    .join(" ");

export function PluginsSection() {
  const { data: installed } = useInstalledGrammars();
  const declined = useSetting("plugins.declined");
  const network = useSetting("privacy.network");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SYNTAXES.filter((s) => !q || s.name.toLowerCase().includes(q) || s.exts.some((e) => e.includes(q.replace(/^\./, "")))).sort((a, b) => a.name.localeCompare(b.name));
  }, [query]);
  const isInstalled = (s: SyntaxPlugin) => !!installed?.includes(s.id);
  const mine = list.filter(isInstalled);
  const rest = list.filter((s) => !isInstalled(s));

  const run = async (s: SyntaxPlugin, f: () => Promise<unknown>) => {
    setBusy(s.id);
    await f();
    setBusy(null);
  };

  const item = (s: SyntaxPlugin) => (
    <Row
      key={s.id}
      label={
        <span className="row" style={{ gap: 8 }}>
          <SyntaxIcon id={s.id} />
          {s.name} {isInstalled(s) && <Check size={12} className="faint" aria-label="Installed" />}
        </span>
      }
      hint={
        <>
          <span className="mono">{extsLabel(s)}</span> · {formatBytes(s.size)}
          {s.license ? ` · ${s.license}` : ""}
        </>
      }
    >
      {isInstalled(s) ? (
        <Button size="sm" variant="ghost" icon={Trash2} disabled={busy === s.id} onClick={() => void run(s, () => removeSyntax(s, installed ?? []))}>
          Remove
        </Button>
      ) : (
        <Button size="sm" icon={Download} disabled={busy === s.id || !network} onClick={() => void run(s, () => installSyntaxes([s]))}>
          {busy === s.id ? "Installing…" : "Install"}
        </Button>
      )}
    </Row>
  );

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <div className="set-group__title">Syntax highlighting</div>
        <div className="set-group">
          <Row
            label="About syntaxes"
            hint="Syntaxes colour code in Kern's file viewer. Each one is a TextMate grammar (data, not code) downloaded from the jsDelivr CDN and checked against a known checksum before it's installed."
          />
          <Row label="Suggest syntaxes for my projects" hint="When a linked folder uses a language you haven't installed, Kern offers to add it.">
            <SToggle k="plugins.suggestSyntax" />
          </Row>
          {declined.length > 0 && (
            <Row label="Languages you said not to suggest" hint={declined.map((d) => SYNTAXES.find((s) => s.id === d)?.name ?? d).join(", ")}>
              <Button size="sm" variant="ghost" onClick={() => void setSetting("plugins.declined", [])}>
                Ask again
              </Button>
            </Row>
          )}
          {!network && <Row label="Downloads are off" hint="External network requests are turned off in Privacy settings, so new syntaxes can't be installed." />}
        </div>
      </div>

      <label className="file-browser__filter" style={{ width: 260, margin: 0 }}>
        <Search size={13} aria-hidden />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search languages or extensions" aria-label="Search syntaxes" spellCheck={false} />
      </label>

      {!installed ? (
        <Skeleton height={120} />
      ) : (
        <>
          {mine.length > 0 && (
            <div>
              <div className="set-group__title">Installed · {mine.length}</div>
              <div className="set-group">{mine.map(item)}</div>
            </div>
          )}
          <div>
            <div className="set-group__title">Available · {rest.length}</div>
            <div className="set-group">{rest.length ? rest.map(item) : <Row label="Nothing matches that search." />}</div>
          </div>
        </>
      )}
    </div>
  );
}
