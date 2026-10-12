// Doughnut of Kern's storage by category. Lazy-loaded: Chart.js only ships
// to the page when storage is shown.
//
// Greyscale by design. Identity never relies on tone alone: segments are
// separated by a 2px surface gap, tones alternate light/dark around the ring
// (validated: adjacent ΔE ≥ 21 for normal and colour-blind vision), and the
// legend beside the chart always shows every category with its exact size.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArcElement, Chart as ChartJS, Tooltip, type ChartOptions, type TooltipModel } from "chart.js";
import { Doughnut } from "react-chartjs-2";
import type { StorageCategory } from "@/lib/types";
import { formatBytes } from "@/lib/dates";
import { CATEGORY_LABEL, displayCategories } from "./categories";

ChartJS.register(ArcElement, Tooltip);

// Fixed tone per category slot, so a category keeps its tone between scans.
const TONES = {
  dark: ["#e6e6e6", "#5c5c5c", "#a8a8a8", "#3a3a3a", "#c9c9c9", "#808080"],
  light: ["#262626", "#a3a3a3", "#555555", "#cfcfcf", "#3d3d3d", "#7a7a7a"],
};

function useTheme() {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export default function StorageChart({
  categories,
  total,
  size = 168,
  compact,
  showLegend = true,
}: {
  categories: StorageCategory[];
  total: number;
  size?: number;
  compact?: boolean;
  showLegend?: boolean;
}) {
  const theme = useTheme();
  const rows = useMemo(() => displayCategories(categories), [categories]);
  const visible = useMemo(() => rows.filter((r) => r.bytes > 0), [rows]);
  const [hover, setHover] = useState<number | null>(null);
  // HTML tooltip (a canvas tooltip would be clipped by the small canvas).
  const [tip, setTip] = useState<{ x: number; y: number; index: number } | null>(null);
  const chartRef = useRef<ChartJS<"doughnut"> | null>(null);
  // While a legend row is hovered it owns the tooltip; chart redraws mustn't clear it.
  const legendOwnsTip = useRef(false);
  const tones = TONES[theme];
  const surface = css("--surface") || (theme === "light" ? "#ffffff" : "#161616");

  const data = useMemo(
    () => ({
      labels: visible.map((r) => CATEGORY_LABEL[r.id]),
      datasets: [
        {
          data: visible.map((r) => r.bytes),
          backgroundColor: visible.map((r) => tones[r.slot]),
          hoverBackgroundColor: visible.map((r) => tones[r.slot]),
          borderColor: surface,
          hoverBorderColor: surface,
          borderWidth: 2,
          borderRadius: 2,
          hoverOffset: compact ? 0 : 4,
        },
      ],
    }),
    [visible, tones, surface, compact],
  );

  const options = useMemo<ChartOptions<"doughnut">>(
    () => ({
      responsive: false,
      maintainAspectRatio: false,
      cutout: "72%",
      animation: { duration: document.documentElement.dataset.motion === "off" ? 0 : 280 },
      layout: { padding: compact ? 0 : 4 },
      onHover: (_e, els) => setHover(els[0]?.index ?? null),
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: false,
          external: ({ tooltip }: { tooltip: TooltipModel<"doughnut"> }) => {
            if (legendOwnsTip.current) return;
            if (compact || tooltip.opacity === 0 || !tooltip.dataPoints?.length) return setTip((t) => (t ? null : t));
            const next = { x: tooltip.caretX, y: tooltip.caretY, index: tooltip.dataPoints[0].dataIndex };
            // Only update when something changed: the chart calls this on every redraw.
            setTip((t) => (t && t.x === next.x && t.y === next.y && t.index === next.index ? t : next));
          },
        },
      },
    }),
    [total, compact],
  );

  // Hovering a legend row highlights its segment (and shows its tooltip).
  const focusSegment = (index: number | null) => {
    setHover(index);
    legendOwnsTip.current = index !== null;
    const chart = chartRef.current;
    if (!chart) return;
    const active = index === null ? [] : [{ datasetIndex: 0, index }];
    chart.setActiveElements(active);
    chart.update("none");
    const arc = index === null || compact ? null : chart.getDatasetMeta(0).data[index];
    const pos = arc?.tooltipPosition(true);
    setTip(index !== null && pos && pos.x !== null && pos.y !== null ? { x: pos.x, y: pos.y, index } : null);
  };

  return (
    <div className={`storage-chart ${compact ? "storage-chart--compact" : ""}`}>
      <div className="storage-chart__ring" style={{ width: size, height: size }}>
        {total > 0 ? (
          <Doughnut ref={chartRef} data={data} options={options} width={size} height={size} aria-label="Storage by category" role="img" />
        ) : (
          <div className="storage-chart__empty" style={{ width: size, height: size }} />
        )}
        {tip && visible[tip.index] && (
          <div className="chart-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
            <span className="chart-tip__label">{CATEGORY_LABEL[visible[tip.index].id]}</span>
            <span className="chart-tip__value">
              {formatBytes(visible[tip.index].bytes)}
              <span className="faint">
                {" · "}
                {(() => {
                  const pct = total ? (visible[tip.index].bytes / total) * 100 : 0;
                  return pct < 0.1 ? "<0.1" : pct.toFixed(1);
                })()}
                % of tracked usage
              </span>
            </span>
          </div>
        )}
        <div className="storage-chart__center" aria-hidden>
          <span className="storage-chart__total">{formatBytes(total)}</span>
          {!compact && <span className="storage-chart__caption">Kern data</span>}
        </div>
      </div>
      {showLegend && (
        <ul className="storage-legend" aria-label="Storage by category">
          {rows.map((r) => {
            const i = visible.indexOf(r);
            const pct = total ? (r.bytes / total) * 100 : 0;
            return (
              <li
                key={r.id}
                className="storage-legend__row"
                data-active={(hover !== null && hover === i) || undefined}
                data-dim={(hover !== null && hover !== i) || undefined}
                onMouseEnter={() => i >= 0 && focusSegment(i)}
                onMouseLeave={() => focusSegment(null)}
              >
                <span className="storage-legend__key" style={{ background: tones[r.slot] }} aria-hidden />
                <span className="grow truncate">{CATEGORY_LABEL[r.id]}</span>
                <span className="storage-legend__pct tabular">{r.bytes > 0 ? `${pct < 0.1 ? "<0.1" : pct.toFixed(pct < 10 ? 1 : 0)}%` : ""}</span>
                <span className="storage-legend__value tabular">{r.bytes > 0 ? formatBytes(r.bytes) : "-"}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
