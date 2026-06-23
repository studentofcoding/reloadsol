"use client";

import React, { useMemo } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
  Filler,
} from "chart.js";
import "chartjs-adapter-date-fns";
import type { OutcomeChartPoint } from "@/strategies/types";
import { formatAppDateTime } from "@/utils/datetime";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
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
}: TradeWindowChartProps) {
  const entryMs = new Date(entryAt).getTime();
  const exitMs = new Date(exitAt).getTime();
  const isProfit = pnlPct != null && pnlPct >= 0;
  const lineColor = isProfit ? "#10b981" : "#ef4444";

  const chartData = useMemo(
    () => ({
      datasets: [
        {
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
        },
      ],
    }),
    [points, lineColor, isProfit],
  );

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(0, 0, 0, 0.85)",
          callbacks: {
            label: (ctx: { parsed: { y: number | null } }) =>
              `Price: $${formatPrice(ctx.parsed.y ?? 0)}`,
          },
        },
      },
      scales: {
        x: {
          type: "time" as const,
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
          grid: { color: "rgba(75, 85, 99, 0.3)" },
          ticks: {
            color: "#9ca3af",
            callback: (v: number | string) => `$${formatPrice(Number(v))}`,
          },
        },
      },
    }),
    [entryMs, exitMs],
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
        <Line data={chartData} options={options} />
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
      </div>
    </div>
  );
}
