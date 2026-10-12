import { ArrowUpRight, HardDrive, RefreshCw } from "lucide-react";
import { lazy, Suspense } from "react";
import type { WidgetProps } from "@/features/dashboard/types";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, Skeleton } from "@/components/ui/Controls";
import { navigate } from "@/stores/router";
import { formatBytes, relativeTime } from "@/lib/dates";
import { CATEGORY_LABEL, largest } from "./categories";
import { useStorageReport, useStorageScan } from "./StorageSection";

const StorageChart = lazy(() => import("./StorageChart"));

/** Compact storage summary for the dashboard. Uses the last scan; never scans by itself. */
export function StorageWidget({ size }: WidgetProps) {
  const { data: report, isLoading } = useStorageReport();
  const scan = useStorageScan();
  if (isLoading) return <Skeleton height={60} />;
  if (!report)
    return (
      <EmptyState compact icon={HardDrive} action={<Button size="sm" icon={RefreshCw} disabled={scan.running} onClick={() => void scan.run(false)}>{scan.running ? "Scanning…" : "Measure storage"}</Button>}>
        Storage hasn't been measured yet.
      </EmptyState>
    );
  const top = largest(report.categories);
  const roomy = size.w >= 4 && size.h >= 4;
  const ring = size.h >= 4 ? 96 : 64;
  return (
    <div className="storage-widget">
      {size.h >= 3 ? (
        <Suspense fallback={<Skeleton height={ring} width={ring} />}>
          <StorageChart categories={report.categories} total={report.totalBytes} size={ring} compact showLegend={roomy} />
        </Suspense>
      ) : (
        <div className="storage-widget__line">
          <span className="storage-widget__total">{formatBytes(report.totalBytes)}</span>
        </div>
      )}
      <div className="storage-widget__foot">
        <span className="faint truncate">
          {top ? `Largest: ${CATEGORY_LABEL[top.id]} (${formatBytes(top.bytes)})` : "Nothing stored yet"} · {relativeTime(report.scannedAt)}
        </span>
        <span className="spacer" />
        <IconButton icon={RefreshCw} label="Scan again" size="sm" disabled={scan.running} className={scan.running ? "spin" : undefined} onClick={() => void scan.run(false)} />
        <IconButton icon={ArrowUpRight} label="Storage settings" size="sm" onClick={() => navigate({ name: "settings", section: "data" })} />
      </div>
    </div>
  );
}
