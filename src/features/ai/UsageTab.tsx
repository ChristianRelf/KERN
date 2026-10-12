import { ArrowRight, Clock } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AiBreakdown } from "@/lib/types";
import { api } from "@/lib/ipc";
import { Segmented, Skeleton } from "@/components/ui/Controls";
import { Tooltip } from "@/components/ui/Tooltip";
import { relativeTime } from "@/lib/dates";
import { useAiAccounts } from "./AccountsTab";
import { CATEGORY_LABEL, PROVIDER_NAME, STATUS_LABEL, formatTokens, formatUsd } from "./meta";
import type { AiErrorCategory, AiProvider } from "@/lib/types";

const RANGES = { "7": 7, "30": 30, "90": 90 } as const;

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="ai-tile">
      <span className="ai-tile__label">{label}</span>
      <span className="ai-tile__value">{value}</span>
      {sub && <span className="ai-tile__sub">{sub}</span>}
    </div>
  );
}

function Breakdown({ title, rows, label }: { title: string; rows: AiBreakdown[]; label?: (r: AiBreakdown) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.requests));
  return (
    <div className="ai-breakdown">
      <div className="ai-breakdown__title">{title}</div>
      {!rows.length && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>No requests</span>}
      {rows.slice(0, 6).map((r) => (
        <div key={r.key} className="ai-breakdown__row">
          <span className="truncate">{label ? label(r) : r.label}</span>
          <span className="ai-breakdown__bar" aria-hidden>
            <span style={{ width: `${(r.requests / max) * 100}%` }} />
          </span>
          <span className="tabular faint">{r.requests}</span>
          <span className="tabular faint" style={{ width: 56, textAlign: "right" }}>
            {formatTokens(r.tokens)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function UsageTab() {
  const [range, setRange] = useState<keyof typeof RANGES>("30");
  const since = useMemo(() => Date.now() - RANGES[range] * 86_400_000, [range]);
  const { data: u } = useQuery({ queryKey: ["ai", "usage", range], queryFn: () => api.ai.usage(since), staleTime: 15_000 });
  const { data: accounts } = useAiAccounts();
  const cooling = (accounts ?? []).filter((a) => a.cooldownUntil);
  const days = useMemo(() => {
    // Fill missing days so the strip reads as a timeline.
    const map = new Map((u?.days ?? []).map((d) => [d.day, d]));
    const out = [];
    for (let i = RANGES[range] - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      out.push(map.get(key) ?? { day: key, requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 });
    }
    return out;
  }, [u, range]);
  const peak = Math.max(1, ...days.map((d) => d.requests));

  if (!u) return <Skeleton height={160} />;
  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="row">
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Locally tracked: requests Kern made, from provider responses. Provider-reported limits are on each account; budgets are your own.
        </span>
        <span className="spacer" />
        <Segmented size="sm" value={range} onChange={setRange} options={[{ value: "7", label: "7d" }, { value: "30", label: "30d" }, { value: "90", label: "90d" }]} ariaLabel="Range" />
      </div>
      <div className="ai-tiles">
        <Tile label="Requests" value={String(u.requests)} sub={u.failures ? `${u.failures} failed` : "none failed"} />
        <Tile label="Input tokens" value={formatTokens(u.inputTokens)} sub={u.cachedTokens ? `${formatTokens(u.cachedTokens)} cached` : undefined} />
        <Tile label="Output tokens" value={formatTokens(u.outputTokens)} />
        <Tile label="Estimated cost" value={u.cost !== null ? formatUsd(u.cost) : "-"} sub={u.cost !== null ? "for priced models" : "set prices under Routing"} />
      </div>
      <div className="ai-strip" aria-label="Requests per day">
        {days.map((d) => (
          <Tooltip key={d.day} content={`${d.day}: ${d.requests} requests${d.failures ? `, ${d.failures} failed` : ""} · ${formatTokens(d.inputTokens + d.outputTokens)} tokens`}>
            <span className="ai-strip__day">
              <span className="ai-strip__bar" style={{ height: `${Math.max(d.requests ? 8 : 2, (d.requests / peak) * 100)}%` }} data-empty={!d.requests || undefined}>
                {d.failures > 0 && <span className="ai-strip__fail" style={{ height: `${(d.failures / d.requests) * 100}%` }} />}
              </span>
            </span>
          </Tooltip>
        ))}
      </div>
      <div className="ai-breakdowns">
        <Breakdown title="Providers" rows={u.byProvider} label={(r) => PROVIDER_NAME[r.key as AiProvider] ?? r.key} />
        <Breakdown title="Models" rows={u.byModel} />
        <Breakdown title="Accounts" rows={u.byAccount} />
      </div>
      {cooling.length > 0 && (
        <div>
          <div className="set-group__title">Known cooldowns</div>
          {cooling.map((a) => (
            <div key={a.id} className="list-row">
              <Clock strokeWidth={1.75} />
              <span className="grow">{a.name}</span>
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                {STATUS_LABEL[a.status]} until {new Date(a.cooldownUntil!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          ))}
        </div>
      )}
      <div>
        <div className="set-group__title">Account switching</div>
        {!u.failovers.length ? (
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>No switches yet.</span>
        ) : (
          u.failovers.map((f) => (
            <div key={f.id} className="list-row">
              <span className="grow row" style={{ gap: 6, fontSize: "var(--fs-sm)" }}>
                {f.fromName ?? "Removed account"} <ArrowRight size={12} className="faint" /> {f.toName ?? <span className="faint">no account available</span>}
                <span className="faint">· {CATEGORY_LABEL[f.reason as AiErrorCategory] ?? f.reason}</span>
              </span>
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{relativeTime(f.createdAt)}</span>
            </div>
          ))
        )}
      </div>
      <div>
        <div className="set-group__title">Recent requests</div>
        {!u.recent.length ? (
          <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>Nothing yet.</span>
        ) : (
          <div className="ai-table" role="table">
            {u.recent.map((e) => (
              <div key={e.id} className="ai-table__row" role="row" data-failed={!e.success || undefined}>
                <span className="faint">{relativeTime(e.startedAt)}</span>
                <span className="truncate">{e.accountName ?? "Removed account"}</span>
                <span className="truncate mono faint">{e.purpose === "validation" ? "connection test" : (e.model ?? "")}</span>
                <span className="tabular">{e.success ? `${e.inputTokens ?? 0} / ${e.outputTokens ?? 0}` : (CATEGORY_LABEL[e.errorCategory as AiErrorCategory] ?? e.errorCategory ?? "Failed")}</span>
                <span className="tabular faint">{e.durationMs} ms</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
