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

interface TokenDetailsModalProps {
  token: any;
  onClose: () => void;
  onBuy: () => void;
}

export default function TokenDetailsModal({
  token,
  onClose,
  onBuy,
}: TokenDetailsModalProps) {
  const chartData = useMemo(() => {
    let historyData = token.price_history;

    // Parse JSONB if it comes as a string (Supabase sometimes returns JSONB as string)
    if (typeof historyData === "string") {
      try {
        historyData = JSON.parse(historyData);
      } catch (e) {
        console.error("Failed to parse price_history:", e);
        historyData = [];
      }
    }

    if (!historyData || !Array.isArray(historyData) || historyData.length === 0)
      return null;

    // Sort by timestamp just in case
    const sortedHistory = [...historyData].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    return {
      labels: sortedHistory.map((h) => new Date(h.timestamp)),
      datasets: [
        {
          label: "Price (USD)",
          data: sortedHistory.map((h) => h.price_usd),
          borderColor: "#3b82f6", // blue-500
          backgroundColor: "rgba(59, 130, 246, 0.1)",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: true,
          tension: 0.4,
        },
        {
          label: "Initial Price",
          data: sortedHistory.map(() => token.initial_price_usd),
          borderColor: "rgba(156, 163, 175, 0.5)", // gray-400
          borderWidth: 1,
          borderDash: [5, 5],
          pointRadius: 0,
          pointHoverRadius: 0,
          fill: false,
        },
      ],
    };
  }, [token.price_history, token.initial_price_usd]);

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        mode: "index" as const,
        intersect: false,
        callbacks: {
          label: (context: any) => {
            return `$${context.raw.toFixed(8)}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: "time" as const,
        time: {
          unit: "minute" as const,
          displayFormats: {
            minute: "HH:mm",
          },
        },
        grid: {
          color: "rgba(255, 255, 255, 0.05)",
        },
        ticks: {
          color: "#9ca3af",
          maxTicksLimit: 8,
        },
      },
      y: {
        grid: {
          color: "rgba(255, 255, 255, 0.05)",
        },
        ticks: {
          color: "#9ca3af",
          callback: (value: any) => `$${value.toFixed(6)}`,
        },
      },
    },
    interaction: {
      mode: "nearest" as const,
      axis: "x" as const,
      intersect: false,
    },
  };

  // Calculations
  const rnr =
    token.peak_price_usd && token.initial_price_usd
      ? (token.peak_price_usd / token.initial_price_usd).toFixed(2)
      : "N/A";

  const formatTime = (dateStr: string) => {
    if (!dateStr) return "N/A";
    return new Date(dateStr).toLocaleString();
  };

  const formatPrice = (price: number) => {
    if (!price) return "N/A";
    return `$${price.toFixed(8)}`;
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-gray-900 rounded-xl w-full max-w-5xl max-h-[90vh] overflow-y-auto border border-gray-700 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="bg-gray-800 p-4 sticky top-0 z-10 flex justify-between items-center border-b border-gray-700">
          <div className="flex items-center space-x-3">
            {token.logo_url ? (
              <img
                src={token.logo_url}
                alt={token.token_symbol}
                className="w-10 h-10 rounded-full"
              />
            ) : (
              <div className="w-10 h-10 bg-gray-700 rounded-full flex items-center justify-center text-lg font-bold">
                {(token.token_symbol || "?").charAt(0)}
              </div>
            )}
            <div>
              <h2 className="text-xl font-bold text-white">
                {token.token_symbol || "Unknown"}
              </h2>
              <div className="text-sm text-gray-400 font-mono">
                {token.token_name}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-2xl px-2"
          >
            ×
          </button>
        </div>

        <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column: Chart */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-gray-800 rounded-lg p-4 h-[400px] border border-gray-700">
              <h3 className="text-sm font-medium text-gray-400 mb-2">
                Price History
              </h3>
              {chartData ? (
                <Line data={chartData} options={chartOptions} />
              ) : (
                <div className="h-full flex items-center justify-center text-gray-500">
                  No price history available
                </div>
              )}
            </div>

            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-medium text-gray-400 mb-3">
                Timeline
              </h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center border-b border-gray-700 pb-2">
                  <span className="text-gray-400">Tracking Started (Buy)</span>
                  <div className="text-right">
                    <div className="text-white">
                      {formatTime(token.tracking_started_at)}
                    </div>
                    <div className="text-xs text-gray-500">
                      @{formatPrice(token.initial_price_usd)}
                    </div>
                  </div>
                </div>
                {token.status_changed_at && (
                  <div className="flex justify-between items-center border-b border-gray-700 pb-2">
                    <span className="text-gray-400">
                      Tracking Stopped (Sell)
                    </span>
                    <div className="text-right">
                      <div className="text-white">
                        {formatTime(token.status_changed_at)}
                      </div>
                      <div className="text-xs text-gray-500">
                        @{formatPrice(token.last_price_usd)}
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">Current Status</span>
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium uppercase ${
                      token.status === "won"
                        ? "bg-green-900/30 text-green-400"
                        : token.status === "lost"
                          ? "bg-red-900/30 text-red-400"
                          : "bg-blue-900/30 text-blue-400"
                    }`}
                  >
                    {token.status}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Stats */}
          <div className="space-y-4">
            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
              <h3 className="text-sm font-medium text-gray-400 mb-4">
                Performance Metrics
              </h3>

              <div className="grid grid-cols-1 gap-4">
                <div className="bg-gray-700/30 p-3 rounded-lg">
                  <div className="text-xs text-gray-400 mb-1">
                    Potential Upside
                  </div>
                  <div
                    className={`text-2xl font-bold ${token.peak_gain_percentage >= 0 ? "text-green-400" : "text-red-400"}`}
                  >
                    {token.peak_gain_percentage > 0 ? "+" : ""}
                    {token.peak_gain_percentage.toFixed(2)}%
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Peak vs Initial
                  </div>
                </div>

                <div className="bg-gray-700/30 p-3 rounded-lg">
                  <div className="text-xs text-gray-400 mb-1">
                    Reward Ratio (RnR)
                  </div>
                  <div className="text-2xl font-bold text-blue-400">{rnr}x</div>
                  <div className="text-xs text-gray-500 mt-1">
                    Peak / Initial Price
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-gray-800 rounded-lg p-4 border border-gray-700 space-y-3">
              <h3 className="text-sm font-medium text-gray-400">
                Price Points
              </h3>

              <div className="flex justify-between">
                <span className="text-gray-400">Initial</span>
                <span className="font-mono text-white">
                  {formatPrice(token.initial_price_usd)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Peak</span>
                <span className="font-mono text-green-400">
                  {formatPrice(token.peak_price_usd)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-400">Last/Current</span>
                <span className="font-mono text-white">
                  {formatPrice(token.last_price_usd)}
                </span>
              </div>
            </div>

            <button
              onClick={onBuy}
              className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-colors shadow-lg flex items-center justify-center gap-2"
            >
              <span>🛒</span> Open Buy Modal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
