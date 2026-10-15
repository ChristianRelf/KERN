/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

// Dependency explorer: packages from manifests and lockfiles, with the
// declared range and - only when a lockfile says so - the resolved
// version. A virtualised list is the default; the graph shows one
// package's neighbourhood so it never draws thousands of nodes. Advisory
// lookups (OSV) are optional and explicit. Nothing is installed or
// upgraded from here.

import { Network, List, RefreshCw, ShieldAlert, ShieldCheck, Search, ExternalLink } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AdvisoryFinding, DepPackage, Project, Repository } from "@/lib/types";
import { api, describeError } from "@/lib/ipc";
import { invalidate, queryClient } from "@/lib/query";
import { toastError } from "@/stores/toast";
import { useSetting } from "@/stores/settings";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, Segmented, Select, Skeleton } from "@/components/ui/Controls";
import { Dialog, confirm } from "@/components/ui/Dialog";
import { Tooltip } from "@/components/ui/Tooltip";
import { openLink } from "@/features/links/links";
import { relativeTime } from "@/lib/dates";

const DependencyGraph = lazy(() => import("./DependencyGraph"));

type Scope = "direct" | "all" | "advisories";

export const depKey = (p: Pick<DepPackage, "ecosystem" | "name" | "resolved">) => `${p.ecosystem}:${p.name}@${p.resolved ?? ""}`;

export default function DependenciesSection({ project, repo }: { project: Project; repo: Repository | null }) {
  const network = useSetting("privacy.network");
  const target = repo?.id ?? null;
  const cacheKey = ["deps", project.id, target];
  const { data: cached } = useQuery({ queryKey: [...cacheKey, "cached"], queryFn: () => api.deps.cached(project.id, target) });
  const { data: scanned, isFetching, refetch, error } = useQuery({
    queryKey: [...cacheKey, "scan"],
    queryFn: () => api.deps.scan(project.id, target),
    // Use the cached report first; rescan on demand (or when there's none).
    enabled: cached !== undefined && !cached.report,
    retry: false,
  });
  const report = scanned ?? cached?.report ?? null;
  const [advisories, setAdvisories] = useState(cached?.advisories ?? null);
  const adv = advisories ?? cached?.advisories ?? null;
  const [checking, setChecking] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");
  const [scope, setScope] = useState<Scope>("direct");
  const [eco, setEco] = useState("all");
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState<DepPackage | null>(null);

  const findings = useMemo(() => new Map((adv?.findings ?? []).map((f) => [`${f.ecosystem}:${f.name}@${f.version}`, f])), [adv]);
  const ecosystems = useMemo(() => [...new Set((report?.packages ?? []).map((p) => p.ecosystem))], [report]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (report?.packages ?? []).filter(
      (p) =>
        (scope === "all" || (scope === "direct" ? p.direct !== false : findings.has(depKey(p)))) &&
        (eco === "all" || p.ecosystem === eco) &&
        (!s || p.name.toLowerCase().includes(s)),
    );
  }, [report, scope, eco, q, findings]);

  const rescan = async () => {
    const r = await refetch();
    if (r.data) queryClient.setQueryData([...cacheKey, "cached"], { report: r.data, advisories: adv });
  };

  const check = async () => {
    const ok = await confirm({
      title: "Check for known vulnerabilities?",
      message: `Sends the names and resolved versions of ${report?.packages.filter((p) => p.resolved).length ?? 0} packages (nothing else from the project) to OSV.dev, an open vulnerability database.`,
      confirmLabel: "Check",
    });
    if (!ok) return;
    setChecking(true);
    try {
      setAdvisories(await api.deps.advisories(project.id, target));
      invalidate("health");
    } catch (e) {
      toastError(describeError(e, "Couldn't check advisories."));
    } finally {
      setChecking(false);
    }
  };

  if (error && !report) return <EmptyState compact icon={Network}>{describeError(error, "Couldn't read dependencies.")}</EmptyState>;
  if (!report) return <Skeleton height={80} />;
  if (!report.manifests.length)
    return (
      <EmptyState compact icon={Network}>
        No dependency manifests found (package.json, Cargo.toml, pyproject.toml, requirements.txt, go.mod, pom.xml, .csproj…).
      </EmptyState>
    );
  const direct = report.packages.filter((p) => p.direct !== false).length;
  return (
    <div className="col deps" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          {direct} direct · {report.packages.length} total · {report.manifests.map((m) => `${m.path}${m.lockfile ? ` + ${m.lockfile.split("/").pop()}` : ""}`).join(", ")}
          {report.truncated && " · list truncated"}
        </span>
        <span className="spacer" />
        <IconButton icon={RefreshCw} label={`Rescan (last ${relativeTime(report.scannedAt)})`} size="sm" className={isFetching ? "spin" : undefined} onClick={() => void rescan()} />
        <Segmented
          size="sm"
          value={view}
          onChange={setView}
          ariaLabel="View"
          options={[
            { value: "list", icon: List, tooltip: "List" },
            { value: "graph", icon: Network, tooltip: "Graph" },
          ]}
        />
      </div>
      <AdvisoryBar adv={adv} network={network} checking={checking} onCheck={() => void check()} onShow={() => setScope("advisories")} />
      {view === "list" ? (
        <>
          <div className="row" style={{ gap: 8 }}>
            <div className="input-wrap grow">
              <Search />
              <input className="input" placeholder="Filter packages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter packages" />
            </div>
            <Segmented
              size="sm"
              value={scope}
              onChange={setScope}
              ariaLabel="Packages shown"
              options={[
                { value: "direct", label: "Direct" },
                { value: "all", label: "All" },
                ...(adv ? [{ value: "advisories" as Scope, label: `Advisories (${adv.findings.length})` }] : []),
              ]}
            />
            {ecosystems.length > 1 && <Select value={eco} onChange={setEco} ariaLabel="Ecosystem" options={[{ value: "all", label: "All ecosystems" }, ...ecosystems.map((e) => ({ value: e, label: e }))]} />}
          </div>
          <PackageList packages={shown} findings={findings} onOpen={setFocus} />
        </>
      ) : (
        <Suspense fallback={<Skeleton height={300} />}>
          <DependencyGraph report={report} findings={findings} onOpen={setFocus} />
        </Suspense>
      )}
      {focus && <PackageDialog p={focus} finding={findings.get(depKey(focus))} onClose={() => setFocus(null)} />}
    </div>
  );
}

function AdvisoryBar({ adv, network, checking, onCheck, onShow }: { adv: { checkedAt: number; checked: number; unchecked: number; findings: AdvisoryFinding[]; source: string } | null; network: boolean; checking: boolean; onCheck: () => void; onShow: () => void }) {
  return (
    <div className="deps-adv" data-found={adv && adv.findings.length > 0 ? true : undefined}>
      {adv && adv.findings.length > 0 ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
      <span className="grow">
        {!adv
          ? "Advisories haven't been checked."
          : adv.findings.length
            ? `${adv.findings.length} package${adv.findings.length === 1 ? " has" : "s have"} known advisories (${adv.source}, ${relativeTime(adv.checkedAt)}).`
            : `No known advisories for ${adv.checked} checked package${adv.checked === 1 ? "" : "s"} (${adv.source}, ${relativeTime(adv.checkedAt)}). That doesn't guarantee they're secure.`}
        {adv && adv.unchecked > 0 && <span className="faint"> {adv.unchecked} without a resolved version couldn't be checked.</span>}
      </span>
      {adv && adv.findings.length > 0 && (
        <Button size="sm" variant="ghost" onClick={onShow}>
          Show
        </Button>
      )}
      <Tooltip content={network ? undefined : "External network requests are off in Privacy settings"} disabled={network}>
        <span>
          <Button size="sm" disabled={!network || checking} onClick={onCheck}>
            {checking ? "Checking…" : adv ? "Check again" : "Check advisories"}
          </Button>
        </span>
      </Tooltip>
    </div>
  );
}

function PackageList({ packages, findings, onOpen }: { packages: DepPackage[]; findings: Map<string, AdvisoryFinding>; onOpen: (p: DepPackage) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: packages.length, getScrollElement: () => ref.current, estimateSize: () => 30, overscan: 12 });
  if (!packages.length) return <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No packages match.</span>;
  return (
    <div className="deps-list" ref={ref}>
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((it) => {
          const p = packages[it.index];
          const f = findings.get(depKey(p));
          return (
            <button key={it.key} type="button" className="dep-row" style={{ transform: `translateY(${it.start}px)` }} onClick={() => onOpen(p)}>
              <span className="truncate dep-row__name mono">{p.name}</span>
              <span className="mono faint truncate dep-row__ver" title="Declared">
                {p.declared ?? ""}
              </span>
              <Tooltip content={p.resolved ? "Resolved version (from the lockfile)" : "No lockfile entry, so the installed version isn't known"}>
                <span className="mono truncate dep-row__ver" data-unknown={!p.resolved || undefined}>
                  {p.resolved ?? "-"}
                </span>
              </Tooltip>
              <span className="faint dep-row__meta">
                {p.direct === null ? "" : p.direct ? "direct" : "transitive"}
                {p.group !== "prod" && ` · ${p.group}`}
              </span>
              <span className="faint dep-row__meta">{p.ecosystem}</span>
              {f ? <ShieldAlert size={13} className="dep-row__alert" aria-label="Has advisories" /> : <span style={{ width: 13 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PackageDialog({ p, finding, onClose }: { p: DepPackage; finding?: AdvisoryFinding; onClose: () => void }) {
  const registry: Record<string, string> = {
    npm: `https://www.npmjs.com/package/${p.name}`,
    "crates.io": `https://crates.io/crates/${p.name}`,
    PyPI: `https://pypi.org/project/${p.name}/`,
    Go: `https://pkg.go.dev/${p.name}`,
    NuGet: `https://www.nuget.org/packages/${p.name}`,
    Maven: `https://central.sonatype.com/artifact/${p.name.replace(":", "/")}`,
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={<span className="mono">{p.name}</span>}>
      <div className="props">
        <span className="props__label">Declared</span>
        <span className="mono">{p.declared ?? "-"}</span>
        <span className="props__label">Resolved</span>
        <span className="mono">{p.resolved ?? "Unknown (no lockfile entry)"}</span>
        <span className="props__label">Kind</span>
        <span>
          {p.direct === null ? "Unknown" : p.direct ? "Direct" : "Transitive"} · {p.group}
        </span>
        <span className="props__label">From</span>
        <span className="mono">{p.manifest}</span>
      </div>
      {finding && (
        <div className="col" style={{ gap: 8 }}>
          <div className="section-title">Advisories</div>
          {finding.advisories.map((a) => (
            <div key={a.id} className="advisory">
              <div className="row" style={{ gap: 6 }}>
                <ShieldAlert size={13} />
                <b className="mono">{a.id}</b>
                {a.severity && <span className="chip">{a.severity}</span>}
                <span className="spacer" />
                <IconButton icon={ExternalLink} label="Open advisory" size="sm" onClick={() => void openLink(a.url)} />
              </div>
              {a.summary && <span style={{ fontSize: "var(--fs-sm)" }}>{a.summary}</span>}
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                {a.affected && `Affected: ${a.affected}. `}
                {a.fixed ? `Fixed in ${a.fixed}.` : "No fixed version listed."}
                {a.aliases.length > 0 && ` Also known as ${a.aliases.slice(0, 3).join(", ")}.`}
              </span>
            </div>
          ))}
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>Kern doesn't upgrade packages. Update it with your package manager when you're ready.</span>
        </div>
      )}
      {registry[p.ecosystem] && (
        <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => void openLink(registry[p.ecosystem])} style={{ alignSelf: "flex-start" }}>
          View on {p.ecosystem}
        </Button>
      )}
    </Dialog>
  );
}
