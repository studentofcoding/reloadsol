"use client";

import React, { useMemo } from "react";
import { Chart } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  BarElement,
  BarController,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler,
} from "chart.js";
import type { ChartData, ChartDataset, ChartOptions, TooltipItem } from "chart.js";
import "chartjs-adapter-date-fns";
import type { OutcomeChartPoint } from "@/strategies/types";
import { formatAppDateTime } from "@/utils/datetime";
import {
  formatVolume,
  hasVolumeData,
  isVolumePresent,
  volumeBarColors,
  volumeBarValues,
} from "@/components/strategies/trade-window-chart-utils";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  BarElement,
  BarController,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler,
);

type TradeWindowChartProps = {
  points: OutcomeChartPoint[];
  entryAt: string;
  exitAt: string;
  pnlPct?: number | null;
  source?: string;
  volumeNote?: string;
};

function formatPrice(value: number): string {
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.0001) return value.toFixed(6);
  return value.toExponential(2);
}

export default function TradeWindowChart({
  points,
  entryAt,
  exitAt,
  pnlPct,
  source,
  volumeNote,
}: TradeWindowChartProps) {
  const entryMs = new Date(entryAt).getTime();
  const exitMs = new Date(exitAt).getTime();
  const isProfit = pnlPct != null && pnlPct >= 0;
  const lineColor = isProfit ? "#10b981" : "#ef4444";
  const showVolume = hasVolumeData(points);

  const chartData = useMemo((): ChartData<"line" | "bar"> => {
    const priceDataset: ChartDataset<"line" | "bar"> = {
      type: "line",
      label: "Price (USD)",
      data: points.map((p) => ({
        x: new Date(p.timestamp).getTime(),
        y: p.price_usd,
      })),
      borderColor: lineColor,
      backgroundColor: isProfit
        ? "rgba(16, 185, 129, 0.12)"
        : "rgba(239, 68, 68, 0.12)",
      borderWidth: 2,
      fill: true,
      tension: 0.3,
      pointRadius: points.length <= 2 ? 6 : 3,
      pointBackgroundColor: lineColor,
      pointBorderColor: "#ffffff",
      pointBorderWidth: 1,
      yAxisID: "y",
      order: 1,
    };

    const datasets: ChartDataset<"line" | "bar">[] = [priceDataset];

    if (showVolume) {
      const barValues = volumeBarValues(points);
      const barColors = volumeBarColors(points);
      datasets.push({
        type: "bar",
        label: "Vol 5m",
        data: points.map((p, index) => ({
          x: new Date(p.timestamp).getTime(),
          y: barValues[index],
        })),
        backgroundColor: barColors,
        borderColor: barColors,
        borderWidth: 1,
        yAxisID: "y1",
        order: 2,
        barPercentage: 0.85,
        categoryPercentage: 0.9,
      });
    }

    return { datasets };
  }, [points, lineColor, isProfit, showVolume]);

  const options = useMemo(
    (): ChartOptions<"line" | "bar"> => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: {
          display: showVolume,
          labels: {
            color: "#9ca3af",
            boxWidth: 10,
            font: { size: 10 },
          },
        },
        tooltip: {
          backgroundColor: "rgba(0, 0, 0, 0.85)",
          callbacks: {
            label: (ctx: TooltipItem<"line" | "bar">) => {
              const label = ctx.dataset.label ?? "";
              const y = ctx.parsed.y;
              if (label.startsWith("Vol")) {
                const vol = points[ctx.dataIndex]?.volume_5m;
                if (!isVolumePresent(vol)) {
                  return `${label}: missing`;
                }
                return `${label}: ${formatVolume(vol)}`;
              }
              return `Price: $${formatPrice(y ?? 0)}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "time",
          min: entryMs,
          max: exitMs,
          time: {
            displayFormats: {
              minute: "HH:mm",
              hour: "MMM d HH:mm",
              day: "MMM d",
            },
          },
          grid: { color: "rgba(75, 85, 99, 0.3)" },
          ticks: { color: "#9ca3af", maxTicksLimit: 6 },
        },
        y: {
          type: "linear",
          position: "left",
          grid: { color: "rgba(75, 85, 99, 0.3)" },
          ticks: {
            color: lineColor,
            callback: (v) => `$${formatPrice(Number(v))}`,
          },
        },
        ...(showVolume
          ? {
              y1: {
                type: "linear" as const,
                position: "right" as const,
                grid: { drawOnChartArea: false },
                ticks: {
                  color: "#60a5fa",
                  callback: (v) => formatVolume(Number(v)),
                },
              },
            }
          : {}),
      },
    }),
    [entryMs, exitMs, lineColor, showVolume, points],
  );

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h4 className="text-xs font-semibold text-gray-300">Trade window (entry → exit)</h4>
        {source && (
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">
            source: {source}
          </span>
        )}
      </div>
      <div className="h-48">
        <Chart type="line" data={chartData} options={options} />
      </div>
      <div className="flex flex-wrap gap-3 mt-2 text-[10px] text-gray-400">
        <span>
          Entry: <span className="text-green-400">{formatAppDateTime(entryAt)}</span>
        </span>
        <span>
          Exit: <span className="text-red-400">{formatAppDateTime(exitAt)}</span>
        </span>
        {pnlPct != null && (
          <span className={isProfit ? "text-green-400" : "text-red-400"}>
            PnL: {pnlPct.toFixed(2)}%
          </span>
        )}
        {showVolume && (
          <span className="text-gray-500">
            Vol bars: green = up vs prior sample, red = down · gap = missing volume
            (tracker)
          </span>
        )}
        {!showVolume && volumeNote && (
          <span className="text-amber-600/80">{volumeNote}</span>
        )}
      </div>
    </div>
  );
}
