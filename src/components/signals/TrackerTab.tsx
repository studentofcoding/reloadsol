"use client";

import React, { useState, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { formatAppDateTime } from "@/utils/datetime";
import ChartBuyModal from "@/components/ChartBuyModal";
import DlmmChartActions from "@/components/dlmm/DlmmChartActions";
import { RUG_LIST_QUERY_KEY } from "@/hooks/useRugList";
import { useQueryClient } from "@tanstack/react-query";
import {
  useMCapTracker,
  FilterOptions,
  McapTrackingData,
} from "@/hooks/useMCapTracker";
import { useTokenAnalytics } from "@/hooks/useTokenAnalytics";
import type { EnrichedTokenData } from "@/utils/data-aggregation";
import {
  deriveTrackerTokenInsights,
  formatScore0To100,
  formatTrackingAge,
} from "@/components/signals/tracker-insights";

// Interfaces imported from hook

const LoadingSkeleton = () => (
  <div className="animate-pulse space-y-4">
    {[...Array(5)].map((_, i) => (
      <div key={i} className="bg-gray-800 rounded-lg p-4 h-32"></div>
    ))}
  </div>
);

function PnlDistributionChart({
  counts,
  labels,
  negativeSplitIndex,
}: {
  counts: number[] | Array<{ count: number; range?: string }>;
  labels?: string[];
  negativeSplitIndex?: number;
}) {
  const items = Array.isArray(counts) ? counts : [];

  // Normalize to { count, range } entries regardless of input shape
  const hist = items.map((entry, idx) => {
    if (typeof entry === "number") {
      return { count: entry, range: labels?.[idx] ?? "" };
    }
    const obj = entry as { count: number; range?: string };
    return {
      count: Number.isFinite(obj.count) ? obj.count : 0,
      range: obj.range ?? labels?.[idx] ?? "",
    };
  });

  const maxCount = Math.max(1, ...hist.map((h) => h.count));
  const split =
    typeof negativeSplitIndex === "number"
      ? negativeSplitIndex
      : Math.floor(hist.length / 2);

  // Compute summary stats
  const totalCount = hist.reduce(
    (acc, h) => acc + (Number.isFinite(h.count) ? h.count : 0),
    0,
  );
  const isNegativeIdx = (idx: number, range: string) =>
    (range && range.includes("-")) || idx < split;

  const lossCount = hist.reduce(
    (acc, h, idx) => acc + (isNegativeIdx(idx, h.range) ? h.count : 0),
    0,
  );
  const winCount = Math.max(0, totalCount - lossCount);

  const lossPct =
    totalCount > 0 ? Math.round((lossCount / totalCount) * 100) : 0;
  const winPct = totalCount > 0 ? Math.round((winCount / totalCount) * 100) : 0;

  return (
    <div className="space-y-1">
      {/* Summary: % Loss / % Win and total samples */}
      <div className="flex items-center justify-between text-xs mb-1">
        <div>
          <span className="text-red-400">Loss: {lossPct}%</span>
          <span className="mx-2 text-gray-400">|</span>
          <span className="text-green-400">Win: {winPct}%</span>
        </div>
        <div className="text-gray-400">Total: {totalCount}</div>
      </div>

      {hist.map((h, idx) => {
        const widthPct =
          maxCount > 0 ? Math.round((h.count / maxCount) * 100) : 0;
        const isNegative = isNegativeIdx(idx, h.range);
        const binPct =
          totalCount > 0 ? Math.round((h.count / totalCount) * 100) : 0;

        return (
          <div key={idx} className="flex items-center gap-2">
            <div className="w-36 text-gray-400 text-xs">{h.range}</div>
            <div className="flex-1 bg-gray-600 rounded h-3">
              <div
                className={`h-3 rounded ${isNegative ? "bg-red-500" : "bg-green-500"}`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <div className="w-24 text-right text-gray-300 text-xs">
              {h.count} ({binPct}%)
            </div>
          </div>
        );
      })}
    </div>
  );
}

function parsePnlThresholdKey(key: string): number {
  const match = key.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

const DEFAULT_FILTERS: Omit<FilterOptions, "search"> = {
  sortBy: "last_updated_at",
  sortOrder: "desc",
  minGrowth: "",
  maxGrowth: "",
  minMcap: "",
  maxMcap: "",
  excludeZeroPnl: false,
  timeFilter: "all",
  performanceFilter: "all",
};

export default function TrackerTab() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const urlSearch = searchParams.get("search")?.trim() ?? "";
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(100);
  const [refetchingTokens, setRefetchingTokens] = useState<Set<string>>(
    new Set(),
  );
  const [stoppingTokens, setStoppingTokens] = useState<Set<string>>(new Set());
  // const [isPnlTimeWindowsExpanded, setIsPnlTimeWindowsExpanded] = useState(true)
  const [activeMcapFilter, setActiveMcapFilter] = useState<string | null>(null);
  // Desired display GMT offset (GMT+X), integer hours from -12 to +14
  const [displayGmtOffset, setDisplayGmtOffset] = useState<number>(7);

  const APP_TZ_OFFSET = 7;

  const [expandedAnalytics, setExpandedAnalytics] = useState<
    Record<string, boolean>
  >({});
  const [expandedBuckets, setExpandedBuckets] = useState<
    Record<string, boolean>
  >({});

  // Modal state
  const [modalTokenAddress, setModalTokenAddress] = useState<string | null>(
    null,
  );

  const toggleBucketDetails = (key: string) => {
    setExpandedBuckets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  const updateSearch = (value: string) => {
    setPage(1);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "tracker");
    const trimmed = value.trim();
    if (trimmed) params.set("search", trimmed);
    else params.delete("search");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  // Compute effective mcap filters
  const effectiveMcapFilters = React.useMemo(() => {
    if (activeMcapFilter) {
      const mcapRanges = {
        under50k: { min: 0, max: 49999 },
        from51to100k: { min: 50000, max: 100000 },
        from101to200k: { min: 100001, max: 200000 },
        from201to500k: { min: 200001, max: 500000 },
        from501kto1M: { min: 500001, max: 1000000 },
        over1M: { min: 1000001, max: Number.MAX_SAFE_INTEGER },
      };
      const range = mcapRanges[activeMcapFilter as keyof typeof mcapRanges];
      if (range) {
        return {
          minMcap: range.min.toString(),
          maxMcap:
            range.max === Number.MAX_SAFE_INTEGER ? "" : range.max.toString(),
        };
      }
    }
    return { minMcap: filters.minMcap, maxMcap: filters.maxMcap };
  }, [activeMcapFilter, filters.minMcap, filters.maxMcap]);

  const queryFilters = useMemo<FilterOptions>(
    () => ({ ...filters, search: urlSearch, ...effectiveMcapFilters }),
    [filters, urlSearch, effectiveMcapFilters],
  );

  const {
    data: apiResponse,
    isLoading: loading,
    error: queryError,
    refetch,
  } = useMCapTracker({
    filters: queryFilters,
    page,
    limit,
  });

  const error = queryError ? queryError.message : "";
  const tokens = useMemo(() => apiResponse?.data || [], [apiResponse?.data]);
  const tokenAddresses = useMemo(
    () => tokens.map((t) => t.token_address),
    [tokens],
  );
  const analyticsQuery = useTokenAnalytics(tokenAddresses);
  const analyticsData = analyticsQuery.data ?? {};
  const analyticsLoading = analyticsQuery.isFetching;
  const stats = apiResponse?.stats || null;
  const pagination = apiResponse?.pagination || {
    page: 1,
    limit: 100,
    total: 0,
    totalPages: 0,
  };

  // Helpers for timezone shifting and peak recompute (ensure these exist once)
  const padHourStr = (h: number | string) => {
    const n = typeof h === "string" ? parseInt(h, 10) : h;
    const norm = ((n % 24) + 24) % 24;
    return norm.toString().padStart(2, "0");
  };
  const shiftDistribution = (dist: Record<string, number>, shift: number) => {
    const result: Record<string, number> = {};
    for (let i = 0; i < 24; i++) result[i.toString().padStart(2, "0")] = 0;
    Object.entries(dist || {}).forEach(([k, v]) => {
      const fromH = parseInt(k, 10);
      const toH = (((fromH + shift) % 24) + 24) % 24;
      const toKey = toH.toString().padStart(2, "0");
      result[toKey] = (result[toKey] || 0) + (Number.isFinite(v) ? v : 0);
    });
    return result;
  };
  const recomputePeakHoursFromDistribution = (
    dist: Record<string, number>,
    topN = 3,
  ) =>
    Object.entries(dist)
      .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
      .slice(0, topN)
      .filter(([, c]) => (c ?? 0) > 0)
      .map(([hour]) => `${hour}:00`);

  const gmtOptions = Array.from({ length: 27 }, (_, idx) => idx - 12);

  const renderBucketHistogram = (bucketKey: string) => {
    if (!stats?.mcapRangeAnalysis) return null;
    const bucket =
      stats.mcapRangeAnalysis[
        bucketKey as keyof typeof stats.mcapRangeAnalysis
      ];
    if (!bucket || typeof bucket !== "object") return null;
    return (
      <PnlDistributionChart
        counts={
          (bucket as { growthHistogram?: number[] | Array<{ count: number; range?: string }> })
            .growthHistogram ?? []
        }
        negativeSplitIndex={3}
      />
    );
  };

  const toggleAnalytics = (tokenAddress: string) => {
    setExpandedAnalytics((prev) => ({
      ...prev,
      [tokenAddress]: !prev[tokenAddress],
    }));
  };

  const dateFmt = (iso?: string | null) => formatAppDateTime(iso);

  const handleOpenChart = (tokenAddress: string) => {
    setModalTokenAddress(tokenAddress);
  };

  const getAnomalyColor = (anomalyType?: string) => {
    if (!anomalyType) return "text-gray-400";
    if (anomalyType === "positive") return "text-red-400";
    if (anomalyType === "negative") return "text-blue-400";
    return "text-yellow-400";
  };

  const getMomentumColor = (momentum?: number) => {
    if (momentum === undefined || momentum === null) return "text-gray-400";
    if (momentum > 0.1) return "text-green-400";
    if (momentum < -0.1) return "text-red-400";
    return "text-yellow-400";
  };

  const getMomentumCategoryColor = (category?: string) => {
    if (!category) return "text-gray-400";
    if (category === "explosive") return "text-green-500";
    if (category === "strong") return "text-green-400";
    if (category === "moderate") return "text-yellow-400";
    if (category === "weak") return "text-orange-400";
    if (category === "negative") return "text-red-400";
    return "text-gray-400";
  };

  const getMomentumSignalColor = (signalType?: string) => {
    if (!signalType) return "text-gray-400";
    if (signalType === "bullish_breakout") return "text-green-400";
    if (signalType === "bearish_breakout") return "text-red-400";
    if (signalType === "neutral") return "text-yellow-400";
    return "text-gray-400";
  };

  const getRiskColor = (riskScore?: number) => {
    if (riskScore === undefined || riskScore === null || !Number.isFinite(riskScore))
      return "text-gray-400";
    if (riskScore >= 70) return "text-red-400";
    if (riskScore >= 45) return "text-yellow-400";
    return "text-green-400";
  };

  const handleMcapRangeFilter = (rangeKey: string) => {
    if (activeMcapFilter === rangeKey) {
      // If clicking the same filter, clear it
      setActiveMcapFilter(null);
    } else {
      // Set new filter and clear any conflicting manual MCap filters
      setActiveMcapFilter(rangeKey);
      setFilters((prev) => ({
        ...prev,
        minMcap: "",
        maxMcap: "",
      }));
    }
    // Reset to first page when filtering
    setPage(1);
  };

  // Analytics loaded via useTokenAnalytics

  // Utility functions
  const formatNumber = (num?: number | null): string => {
    // Guard against undefined, null, or non-finite values
    if (num === null || num === undefined) return "$0";
    const n = Number(num);
    if (!Number.isFinite(n)) return "$0";

    if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  };

  const formatSolAmount = (solAmount: number): string => {
    if (!Number.isFinite(solAmount)) return "—";
    if (solAmount >= 1000) return `${(solAmount / 1000).toFixed(2)}K SOL`;
    if (solAmount >= 1) return `${solAmount.toFixed(2)} SOL`;
    return `${solAmount.toFixed(4)} SOL`;
  };

  const formatPercentage = (percent: number): string => {
    if (!Number.isFinite(percent)) return "—";
    return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
  };

  const getGrowthColor = (percent: number): string => {
    if (Math.abs(percent) < 0.01) return "text-gray-400";
    return percent >= 0 ? "text-green-400" : "text-red-400";
  };

  const getGrowthIcon = (percent: number): string => {
    if (Math.abs(percent) < 0.01) return "➖";
    return percent >= 0 ? "📈" : "📉";
  };


  const refetchTokenMcap = async (tokenAddress: string) => {
    const tok = tokens.find((t) => t.token_address === tokenAddress);
    if (tok?.is_finished) return;
    if (refetchingTokens.has(tokenAddress)) return;

    setRefetchingTokens((prev) => new Set(prev).add(tokenAddress));

    try {
      const response = await fetch(
        `/api/mcap-tracking?action=refetch&token=${tokenAddress}`,
      );
      const data = await response.json();

      if (data.success) {

        // Refresh the full data to update stats (including finished status)
        await refetch();

        console.log(`MCap refetched for ${tokenAddress}:`, data.display);
      } else {
        console.error("Failed to refetch MCap:", data.error);
      }
    } catch (error) {
      console.error("Error refetching MCap:", error);
    } finally {
      setRefetchingTokens((prev) => {
        const newSet = new Set(prev);
        newSet.delete(tokenAddress);
        return newSet;
      });
    }
  };

  const stopTrackingToken = async (
    tokenAddress: string,
    tokenSymbol: string,
  ) => {
    if (stoppingTokens.has(tokenAddress)) return;

    const token = tokens.find((t) => t.token_address === tokenAddress);
    console.log("[mcap-tracker] stop tracking request", {
      tokenAddress,
      tokenSymbol,
      currentMcap: token?.current_mcap,
      growthPercent: token?.mcap_growth_percent,
    });

    setStoppingTokens((prev) => new Set(prev).add(tokenAddress));

    try {
      const stopResponse = await fetch(`/api/mcap-tracking?action=stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses: [tokenAddress], reason: "rug" }),
      });

      const stopResult = await stopResponse.json();

      if (!stopResponse.ok || stopResult.success === false) {
        console.error("Failed to stop tracking:", stopResult.error);
        return;
      }

      const labelResponse = await fetch("/api/mcap-tracking/label", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenAddress, label: "rugged" }),
      });

      const labelResult = await labelResponse.json();

      if (!labelResponse.ok || labelResult.success === false) {
        console.error("Failed to mark token as loss:", labelResult.error);
      } else {
        void queryClient.invalidateQueries({ queryKey: RUG_LIST_QUERY_KEY });
      }

      await refetch();
    } catch (error) {
      console.error("Error stopping tracking:", error);
    } finally {
      setStoppingTokens((prev) => {
        const next = new Set(prev);
        next.delete(tokenAddress);
        return next;
      });
    }
  };

  const exportToCSV = () => {
    const headers = [
      "Symbol",
      "Address",
      "First MCap",
      "Current MCap",
      "Growth %",
      "First SOL",
      "Current SOL",
      "SOL Growth %",
      "First Seen",
      "Last Updated",
      "80%",
      "120%",
      "200%",
    ];

    const csvData = tokens.map((token) => [
      token.token_symbol,
      token.token_address,
      token.first_mcap,
      token.current_mcap,
      token.mcap_growth_percent,
      token.solPerToken.first,
      token.solPerToken.current,
      token.solPerToken.growth,
      dateFmt(token.first_seen_at),
      dateFmt(token.last_updated_at),
      dateFmt(token.when_reach_80pct),
      dateFmt(token.when_reach_120pct),
      dateFmt(token.when_reach_200pct),
    ]);

    const csvContent = [headers, ...csvData]
      .map((row) => row.map((cell) => `"${cell}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mcap-tracking-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && tokens.length === 0) {
    return (
      <div className="text-white">
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <h2 className="text-xl font-semibold mb-2">MCap tracker</h2>
            <p className="text-gray-400">Loading market cap tracking data...</p>
          </div>
          <LoadingSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto text-white">
      {/* Chart Buy Modal */}
      {modalTokenAddress && (
        <ChartBuyModal
          tokenAddress={modalTokenAddress}
          onClose={() => setModalTokenAddress(null)}
          onNavigate={(direction) => {
            if (!tokens.length) return;
            const currentIndex = tokens.findIndex(
              (t) => t.token_address === modalTokenAddress,
            );
            if (currentIndex === -1) return;

            const nextIndex =
              direction === "next" ? currentIndex + 1 : currentIndex - 1;
            if (nextIndex >= 0 && nextIndex < tokens.length) {
              setModalTokenAddress(tokens[nextIndex].token_address);
            }
          }}
          hasPrev={
            tokens.findIndex((t) => t.token_address === modalTokenAddress) > 0
          }
          hasNext={
            tokens.findIndex((t) => t.token_address === modalTokenAddress) <
            tokens.length - 1
          }
        />
      )}

      {/* Header */}
      <div className="mb-8 mx-auto">
        <h2 className="text-xl font-semibold my-2">MCap tracker</h2>
        <p className="text-gray-400">
          Monitor token market cap changes and growth patterns over time
        </p>
        {stats && (
          <p className="text-sm text-blue-400 mt-2">
            SOL Price: ${stats.solPriceUSD.toFixed(2)}
          </p>
        )}

      </div>

      {/* Enhanced Statistics Overview */}
      {stats && (
        <>
          {/* Main Stats */}
          <div className="grid grid-cols-1 md:grid-cols-7 gap-4 mb-8">
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="text-2xl font-bold text-blue-400">
                {stats.total.toLocaleString()}
              </div>
              <div className="text-sm text-gray-400">Total Tokens</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="text-2xl font-bold text-green-400">
                {stats.gainers.toLocaleString()}
              </div>
              <div className="text-sm text-gray-400">Gainers</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="text-2xl font-bold text-red-400">
                {stats.losers.toLocaleString()}
              </div>
              <div className="text-sm text-gray-400">Losers</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="text-2xl font-bold text-gray-400">
                {stats.zeroPercent.toLocaleString()}
              </div>
              <div className="text-sm text-gray-400">
                0% PnL ({stats.zeroPercentage.toFixed(1)}%)
              </div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4">
              <div
                className={`text-2xl font-bold ${getGrowthColor(stats.avgGrowth)}`}
              >
                {formatPercentage(stats.avgGrowth)}
              </div>
              <div className="text-sm text-gray-400">Avg Growth</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4">
              <div
                className={`text-2xl font-bold ${getGrowthColor(stats.highestGrowth ?? 0)}`}
              >
                {formatPercentage(stats.highestGrowth ?? 0)}
              </div>
              <div className="text-sm text-gray-400">Highest %</div>
            </div>
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="text-2xl font-bold text-purple-400">
                {formatNumber(stats.totalMcap)}
              </div>
              <div className="text-sm text-gray-400">Total MCap</div>
            </div>
          </div>

          {/* Buy & Sell Time Windows (Combined) with inline timezone controls and legend */}
          {stats.pnlTimeWindows && stats.pnlBuyTimeWindows && (
            <div className="bg-gray-800 rounded-lg p-6 mb-8">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-2">
                <h3 className="text-xl font-bold">
                  Buy & Sell Time Windows (Combined)
                </h3>
                <div className="flex items-center gap-4">
                  <label className="text-sm text-gray-300 flex items-center gap-2">
                    Display in:
                    <select
                      className="bg-gray-700 rounded px-2 py-1 text-sm"
                      value={displayGmtOffset}
                      onChange={(e) =>
                        setDisplayGmtOffset(parseInt(e.target.value, 10))
                      }
                    >
                      {gmtOptions.map((off) => (
                        <option key={off} value={off}>
                          {off >= 0 ? `GMT+${off}` : `GMT${off}`}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              {/* Legend */}
              <div className="flex items-center gap-6 text-xs text-gray-300 mb-3">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded bg-emerald-400"></span>
                  <span>Buy (neon)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded bg-black border border-gray-600"></span>
                  <span>Sell (black)</span>
                </div>
              </div>

              {/* Basis/Source summary */}
              <div className="text-xs text-gray-400 mb-4">
                Buy basis:{" "}
                {stats.timeWindowMeta?.buyPeakHourBasis ?? "first_seen_at"} |
                Sell basis:{" "}
                {stats.timeWindowMeta?.sellPeakHourBasis ?? "last_updated_at"} |
                Source TZ: Asia/Bangkok (GMT+7) | Display TZ:{" "}
                {displayGmtOffset >= 0
                  ? `GMT+${displayGmtOffset}`
                  : `GMT${displayGmtOffset}`}
                {displayGmtOffset === APP_TZ_OFFSET ? " (Bangkok)" : ""}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {Array.from(
                  new Set([
                    ...Object.keys(stats.pnlTimeWindows || {}),
                    ...Object.keys(stats.pnlBuyTimeWindows || {}),
                  ]),
                )
                  .sort(
                    (a, b) =>
                      parsePnlThresholdKey(a) - parsePnlThresholdKey(b),
                  )
                  .map((threshold) => {
                    const sell = stats.pnlTimeWindows[threshold];
                    const buy = stats.pnlBuyTimeWindows
                      ? stats.pnlBuyTimeWindows[threshold]
                      : undefined;

                    const displayShift = displayGmtOffset - APP_TZ_OFFSET;
                    const adjustedSellDist = sell
                      ? shiftDistribution(sell.timeDistribution, displayShift)
                      : {};
                    const adjustedBuyDist = buy
                      ? shiftDistribution(
                          buy.timeDistribution,
                          displayShift,
                        )
                      : {};

                    // Recompute peak hours in display TZ
                    const sellPeak = sell
                      ? recomputePeakHoursFromDistribution(adjustedSellDist)
                      : [];
                    const buyPeak = buy
                      ? recomputePeakHoursFromDistribution(adjustedBuyDist)
                      : [];

                    // Separate maxima for better per-series contrast
                    const sellMax =
                      adjustedSellDist &&
                      Object.values(adjustedSellDist).length > 0
                        ? Math.max(...Object.values(adjustedSellDist))
                        : 0;
                    const buyMax =
                      adjustedBuyDist &&
                      Object.values(adjustedBuyDist).length > 0
                        ? Math.max(...Object.values(adjustedBuyDist))
                        : 0;

                    const formatTimeToReach = (hours: number) => {
                      if (!hours || hours <= 0) return "N/A";
                      if (hours < 1) return `${Math.round(hours * 60)}m`;
                      if (hours < 24) return `${hours.toFixed(1)}h`;
                      const days = Math.floor(hours / 24);
                      const remainingHours = Math.round(hours % 24);
                      return remainingHours > 0
                        ? `${days}d ${remainingHours}h`
                        : `${days}d`;
                    };

                    // Threshold color for heading only
                    const thresholdNum = parsePnlThresholdKey(threshold);
                    const headingColor = (() => {
                      if (thresholdNum >= 1000) return "text-purple-400";
                      if (thresholdNum >= 500) return "text-pink-400";
                      if (thresholdNum >= 200) return "text-yellow-400";
                      if (thresholdNum >= 100) return "text-green-400";
                      return "text-blue-400";
                    })();

                    return (
                      <div
                        key={threshold}
                        className="bg-gray-700 rounded-lg p-4"
                      >
                        <h4
                          className={`text-lg font-semibold mb-3 ${headingColor}`}
                        >
                          {threshold} Threshold
                        </h4>

                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-gray-400">
                              Tokens Reached (Buy):
                            </span>
                            <span className="text-white font-medium">
                              {buy?.count ?? 0}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-400">
                              Tokens Reached (Sell):
                            </span>
                            <span className="text-white font-medium">
                              {sell?.count ?? 0}
                            </span>
                          </div>

                          <div className="flex justify-between">
                            <span className="text-gray-400">
                              Avg Time (Buy):
                            </span>
                            <span className="text-white">
                              {formatTimeToReach(buy?.avgTimeToReach ?? 0)}
                            </span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-400">
                              Avg Time (Sell):
                            </span>
                            <span className="text-white">
                              {formatTimeToReach(sell?.avgTimeToReach ?? 0)}
                            </span>
                          </div>

                          {buyPeak.length > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-400">
                                Peak Hours for Buy:
                              </span>
                              <span className="text-emerald-300 text-xs">
                                {buyPeak.slice(0, 3).join(", ")}
                                {buyPeak.length > 3 && "..."}
                              </span>
                            </div>
                          )}
                          {sellPeak.length > 0 && (
                            <div className="flex justify-between">
                              <span className="text-gray-400">
                                Peak Hours for Sell:
                              </span>
                              <span className="text-gray-200 text-xs">
                                {sellPeak.slice(0, 3).join(", ")}
                                {sellPeak.length > 3 && "..."}
                              </span>
                            </div>
                          )}

                          {/* Overlayed hourly distribution (Buy top stripe, Sell bottom stripe) */}
                          <div className="mt-3">
                            <span className="text-gray-400 text-xs mb-2 block">
                              Hourly Distribution (display TZ):
                            </span>
                            <div className="grid grid-cols-6 gap-1">
                              {Array.from({ length: 24 }, (_, hour) => {
                                const key = hour.toString().padStart(2, "0");
                                const buyCount =
                                  (adjustedBuyDist as any)[key] || 0;
                                const sellCount =
                                  (adjustedSellDist as any)[key] || 0;
                                const buyOpacity =
                                  buyMax > 0
                                    ? Math.max(0.12, buyCount / buyMax)
                                    : 0.12;
                                const sellOpacity =
                                  sellMax > 0
                                    ? Math.max(0.12, sellCount / sellMax)
                                    : 0.12;
                                return (
                                  <div
                                    key={key}
                                    className="h-3 rounded-sm border border-gray-600/40 px-[1px] py-[1px]"
                                    title={`${key}:00 — Buy ${buyCount}, Sell ${sellCount}`}
                                  >
                                    <div className="flex flex-col h-full gap-[1px]">
                                      {/* Buy stripe (top) */}
                                      <div
                                        className="h-1 bg-emerald-400 rounded-sm"
                                        style={{ opacity: buyOpacity }}
                                      />
                                      {/* Sell stripe (bottom) */}
                                      <div
                                        className="h-1 bg-black rounded-sm border border-gray-700"
                                        style={{ opacity: sellOpacity }}
                                      />
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            <div className="flex justify-between text-xs text-gray-500 mt-1">
                              <span>00h</span>
                              <span>12h</span>
                              <span>24h</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {/* MCap Range Analysis */}
          {stats.mcapRangeAnalysis && (
          <div className="bg-gray-800 rounded-lg p-6 mb-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold">MCap Range Analysis</h3>
              {activeMcapFilter && (
                <button
                  onClick={() => setActiveMcapFilter(null)}
                  className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded-md text-sm transition-colors"
                >
                  Clear Filter
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <button
                onClick={() => handleMcapRangeFilter("under50k")}
                className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                  activeMcapFilter === "under50k"
                    ? "ring-2 ring-blue-400 bg-gray-600"
                    : ""
                }`}
              >
                <div className="flex items-start justify-between">
                  <h4 className="text-lg font-semibold text-blue-400 mb-2">
                    &lt;50K MCap
                  </h4>
                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMcapRangeFilter("under50k");
                      }}
                      className="px-2 py-1 text-xs rounded bg-blue-500 hover:bg-blue-600"
                    >
                      Filter
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBucketDetails("under50k");
                      }}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500"
                    >
                      {expandedBuckets["under50k"] ? "Hide" : "Details"}
                    </button>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Count:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.under50k.count}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Multiplier:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.under50k.avgMultiplier.toFixed(
                        2,
                      )}
                      x
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Max Drawdown:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.under50k.maxDrawdown,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.under50k.maxDrawdown,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Growth:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.under50k.avgGrowth,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.under50k.avgGrowth,
                      )}
                    </span>
                  </div>

                  {expandedBuckets["under50k"] && (
                    <div className="pt-3 mt-3 border-t border-gray-600 space-y-2">
                      {/* Extra metrics in details */}
                      <div className="flex justify-between">
                        <span className="text-gray-400">Median Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.under50k.medianGrowth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.under50k.medianGrowth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.under50k.p75Growth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.under50k.p75Growth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">
                          Median Multiplier:
                        </span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.under50k.medianMultiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Multiplier:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.under50k.p75Multiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stop Loss Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.under50k.stopLossRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stuck Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.under50k.stuckRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Hit Rate ≥120%:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.under50k.hitRate120.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>

                      {/* PnL Distribution Chart */}
                      <div className="mt-3">
                        <div className="text-gray-300 text-xs mb-1">
                          PnL distribution
                        </div>
                        {renderBucketHistogram("under50k")}
                      </div>
                    </div>
                  )}
                </div>
              </button>

              <button
                onClick={() => handleMcapRangeFilter("from51to100k")}
                className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                  activeMcapFilter === "from51to100k"
                    ? "ring-2 ring-green-400 bg-gray-600"
                    : ""
                }`}
              >
                <div className="flex items-start justify-between">
                  <h4 className="text-lg font-semibold text-green-400 mb-2">
                    50K-100K MCap
                  </h4>
                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMcapRangeFilter("from51to100k");
                      }}
                      className="px-2 py-1 text-xs rounded bg-green-500 hover:bg-green-600"
                    >
                      Filter
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBucketDetails("from51to100k");
                      }}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500"
                    >
                      {expandedBuckets["from51to100k"] ? "Hide" : "Details"}
                    </button>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Count:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.from51to100k.count}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Multiplier:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.from51to100k.avgMultiplier.toFixed(
                        2,
                      )}
                      x
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Max Drawdown:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.from51to100k.maxDrawdown,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.from51to100k.maxDrawdown,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Growth:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.from51to100k.avgGrowth,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.from51to100k.avgGrowth,
                      )}
                    </span>
                  </div>

                  {expandedBuckets["from51to100k"] && (
                    <div className="pt-3 mt-3 border-t border-gray-600 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Median Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.from51to100k.medianGrowth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.from51to100k.medianGrowth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.from51to100k.p75Growth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.from51to100k.p75Growth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">
                          Median Multiplier:
                        </span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from51to100k.medianMultiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Multiplier:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from51to100k.p75Multiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stop Loss Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from51to100k.stopLossRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stuck Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from51to100k.stuckRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Hit Rate ≥120%:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from51to100k.hitRate120.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>

                      <div className="mt-3">
                        <div className="text-gray-300 text-xs mb-1">
                          PnL distribution
                        </div>
                        {renderBucketHistogram("from51to100k")}
                      </div>
                    </div>
                  )}
                </div>
              </button>

              <button
                onClick={() => handleMcapRangeFilter("from101to200k")}
                className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                  activeMcapFilter === "from101to200k"
                    ? "ring-2 ring-purple-400 bg-gray-600"
                    : ""
                }`}
              >
                <div className="flex items-start justify-between">
                  <h4 className="text-lg font-semibold text-purple-400 mb-2">
                    101K-200K MCap
                  </h4>
                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMcapRangeFilter("from101to200k");
                      }}
                      className="px-2 py-1 text-xs rounded bg-purple-500 hover:bg-purple-600"
                    >
                      Filter
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBucketDetails("from101to200k");
                      }}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500"
                    >
                      {expandedBuckets["from101to200k"] ? "Hide" : "Details"}
                    </button>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Count:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.from101to200k.count}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Multiplier:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.from101to200k.avgMultiplier.toFixed(
                        2,
                      )}
                      x
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Max Drawdown:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.from101to200k.maxDrawdown,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.from101to200k.maxDrawdown,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Growth:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.from101to200k.avgGrowth,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.from101to200k.avgGrowth,
                      )}
                    </span>
                  </div>

                  {expandedBuckets["from101to200k"] && (
                    <div className="pt-3 mt-3 border-t border-gray-600 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Median Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.from101to200k.medianGrowth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.from101to200k.medianGrowth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.from101to200k.p75Growth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.from101to200k.p75Growth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">
                          Median Multiplier:
                        </span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from101to200k.medianMultiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Multiplier:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from101to200k.p75Multiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stop Loss Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from101to200k.stopLossRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stuck Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from101to200k.stuckRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Hit Rate ≥120%:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from101to200k.hitRate120.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>

                      <div className="mt-3">
                        <div className="text-gray-300 text-xs mb-1">
                          PnL distribution
                        </div>
                        {renderBucketHistogram("from101to200k")}
                      </div>
                    </div>
                  )}
                </div>
              </button>

              <button
                onClick={() => handleMcapRangeFilter("from201to500k")}
                className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                  activeMcapFilter === "from201to500k"
                    ? "ring-2 ring-yellow-400 bg-gray-600"
                    : ""
                }`}
              >
                <div className="flex items-start justify-between">
                  <h4 className="text-lg font-semibold text-yellow-400 mb-2">
                    201K-500K MCap
                  </h4>
                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMcapRangeFilter("from201to500k");
                      }}
                      className="px-2 py-1 text-xs rounded bg-yellow-500 hover:bg-yellow-600"
                    >
                      Filter
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBucketDetails("from201to500k");
                      }}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500"
                    >
                      {expandedBuckets["from201to500k"] ? "Hide" : "Details"}
                    </button>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Count:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.from201to500k.count}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Multiplier:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.from201to500k.avgMultiplier.toFixed(
                        2,
                      )}
                      x
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Max Drawdown:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.from201to500k.maxDrawdown,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.from201to500k.maxDrawdown,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Growth:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.from201to500k.avgGrowth,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.from201to500k.avgGrowth,
                      )}
                    </span>
                  </div>

                  {expandedBuckets["from201to500k"] && (
                    <div className="pt-3 mt-3 border-t border-gray-600 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Median Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.from201to500k.medianGrowth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.from201to500k.medianGrowth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.from201to500k.p75Growth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.from201to500k.p75Growth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">
                          Median Multiplier:
                        </span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from201to500k.medianMultiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Multiplier:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from201to500k.p75Multiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stop Loss Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from201to500k.stopLossRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stuck Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from201to500k.stuckRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Hit Rate ≥120%:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from201to500k.hitRate120.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>

                      <div className="mt-3">
                        <div className="text-gray-300 text-xs mb-1">
                          PnL distribution
                        </div>
                        {renderBucketHistogram("from201to500k")}
                      </div>
                    </div>
                  )}
                </div>
              </button>

              <button
                onClick={() => handleMcapRangeFilter("from501kto1M")}
                className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                  activeMcapFilter === "from501kto1M"
                    ? "ring-2 ring-orange-400 bg-gray-600"
                    : ""
                }`}
              >
                <div className="flex items-start justify-between">
                  <h4 className="text-lg font-semibold text-orange-400 mb-2">
                    501K-1M MCap
                  </h4>
                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMcapRangeFilter("from501kto1M");
                      }}
                      className="px-2 py-1 text-xs rounded bg-orange-500 hover:bg-orange-600"
                    >
                      Filter
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBucketDetails("from501kto1M");
                      }}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500"
                    >
                      {expandedBuckets["from501kto1M"] ? "Hide" : "Details"}
                    </button>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Count:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.from501kto1M.count}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Multiplier:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.from501kto1M.avgMultiplier.toFixed(
                        2,
                      )}
                      x
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Max Drawdown:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.from501kto1M.maxDrawdown,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.from501kto1M.maxDrawdown,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Growth:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.from501kto1M.avgGrowth,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.from501kto1M.avgGrowth,
                      )}
                    </span>
                  </div>

                  {expandedBuckets["from501kto1M"] && (
                    <div className="pt-3 mt-3 border-t border-gray-600 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Median Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.from501kto1M.medianGrowth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.from501kto1M.medianGrowth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.from501kto1M.p75Growth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.from501kto1M.p75Growth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">
                          Median Multiplier:
                        </span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from501kto1M.medianMultiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Multiplier:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from501kto1M.p75Multiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stop Loss Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from501kto1M.stopLossRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stuck Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from501kto1M.stuckRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Hit Rate ≥120%:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.from501kto1M.hitRate120.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>

                      <div className="mt-3">
                        <div className="text-gray-300 text-xs mb-1">
                          PnL distribution
                        </div>
                        {renderBucketHistogram("from501kto1M")}
                      </div>
                    </div>
                  )}
                </div>
              </button>

              <button
                onClick={() => handleMcapRangeFilter("over1M")}
                className={`bg-gray-700 rounded-lg p-4 text-left transition-all duration-200 hover:bg-gray-600 ${
                  activeMcapFilter === "over1M"
                    ? "ring-2 ring-pink-400 bg-gray-600"
                    : ""
                }`}
              >
                <div className="flex items-start justify-between">
                  <h4 className="text-lg font-semibold text-pink-400 mb-2">
                    &gt;1M MCap
                  </h4>
                  <div className="flex gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMcapRangeFilter("over1M");
                      }}
                      className="px-2 py-1 text-xs rounded bg-pink-500 hover:bg-pink-600"
                    >
                      Filter
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBucketDetails("over1M");
                      }}
                      className="px-2 py-1 text-xs rounded bg-gray-600 hover:bg-gray-500"
                    >
                      {expandedBuckets["over1M"] ? "Hide" : "Details"}
                    </button>
                  </div>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Count:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.over1M.count}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Multiplier:</span>
                    <span className="text-white">
                      {stats.mcapRangeAnalysis.over1M.avgMultiplier.toFixed(2)}x
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Max Drawdown:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.over1M.maxDrawdown,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.over1M.maxDrawdown,
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Growth:</span>
                    <span
                      className={getGrowthColor(
                        stats.mcapRangeAnalysis.over1M.avgGrowth,
                      )}
                    >
                      {formatPercentage(
                        stats.mcapRangeAnalysis.over1M.avgGrowth,
                      )}
                    </span>
                  </div>

                  {expandedBuckets["over1M"] && (
                    <div className="pt-3 mt-3 border-t border-gray-600 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Median Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.over1M.medianGrowth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.over1M.medianGrowth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Growth:</span>
                        <span
                          className={getGrowthColor(
                            stats.mcapRangeAnalysis.over1M.p75Growth,
                          )}
                        >
                          {formatPercentage(
                            stats.mcapRangeAnalysis.over1M.p75Growth,
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">
                          Median Multiplier:
                        </span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.over1M.medianMultiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">P75 Multiplier:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.over1M.p75Multiplier.toFixed(
                            2,
                          )}
                          x
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stop Loss Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.over1M.stopLossRate.toFixed(
                            1,
                          )}
                          %
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Stuck Rate:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.over1M.stuckRate.toFixed(1)}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Hit Rate ≥120%:</span>
                        <span className="text-white">
                          {stats.mcapRangeAnalysis.over1M.hitRate120.toFixed(1)}
                          %
                        </span>
                      </div>

                      <div className="mt-3">
                        <div className="text-gray-300 text-xs mb-1">
                          PnL distribution
                        </div>
                        {renderBucketHistogram("over1M")}
                      </div>
                    </div>
                  )}
                </div>
              </button>
            </div>
          </div>
          )}
        </>
      )}

      {/* Filters and Controls */}
      <div className="bg-gray-800 rounded-lg p-6 mb-8">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
          <h2 className="text-xl font-semibold">Filters & Search</h2>
          <div className="flex items-center space-x-2">
            <label className="flex items-center space-x-2 text-sm">
              <input
                type="checkbox"
                checked={filters.excludeZeroPnl}
                onChange={(e) =>
                  setFilters((prev) => ({
                    ...prev,
                    excludeZeroPnl: e.target.checked,
                  }))
                }
                className="rounded"
              />
              <span>Exclude 0% PnL from avg</span>
            </label>
            <button
              onClick={exportToCSV}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
            >
              Export CSV
            </button>
          </div>
        </div>

        {/* ... existing filter controls ... */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2">Search</label>
            <input
              type="text"
              placeholder="Symbol or address..."
              value={urlSearch}
              onChange={(e) => updateSearch(e.target.value)}
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Sort By</label>
            <select
              value={filters.sortBy}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, sortBy: e.target.value }))
              }
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="last_updated_at">Last Updated</option>
              <option value="first_seen_at">First Seen</option>
              <option value="mcap_growth_percent">Growth %</option>
              <option value="current_mcap">Current MCap</option>
              <option value="first_mcap">First MCap</option>
              <option value="token_symbol">Symbol</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Order</label>
            <select
              value={filters.sortOrder}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  sortOrder: e.target.value as "asc" | "desc",
                }))
              }
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Min Growth %
            </label>
            <input
              type="number"
              placeholder="e.g., -50"
              value={filters.minGrowth}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, minGrowth: e.target.value }))
              }
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              Max Growth %
            </label>
            <input
              type="number"
              placeholder="e.g., 1000"
              value={filters.maxGrowth}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, maxGrowth: e.target.value }))
              }
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Min MCap</label>
            <input
              type="number"
              placeholder="e.g., 50000"
              value={filters.minMcap}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, minMcap: e.target.value }))
              }
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Max MCap</label>
            <input
              type="number"
              placeholder="e.g., 2000000"
              value={filters.maxMcap}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, maxMcap: e.target.value }))
              }
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Time-based and Performance Filters */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Time Period
            </label>
            <select
              value={filters.timeFilter}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  timeFilter: e.target.value as
                    | "1h"
                    | "4h"
                    | "24h"
                    | "3d"
                    | "7d"
                    | "1m"
                    | "all",
                }))
              }
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Time</option>
              <option value="1h">Last 1 Hour</option>
              <option value="4h">Last 4 Hours</option>
              <option value="24h">Last 24 Hours</option>
              <option value="3d">Last 3 Days</option>
              <option value="7d">Last 7 Days</option>
              <option value="1m">Last 1 Month</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">
              Performance Filter
            </label>
            <select
              value={filters.performanceFilter}
              onChange={(e) =>
                setFilters((prev) => ({
                  ...prev,
                  performanceFilter: e.target.value as
                    | "all"
                    | "gainers"
                    | "losers"
                    | "top_performers",
                }))
              }
              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Tokens</option>
              <option value="gainers">Gainers Only (+)</option>
              <option value="losers">Losers Only (-)</option>
              <option value="top_performers">Top Performers ({">"}100%)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-red-900 border border-red-700 rounded-lg p-4 mb-8">
          <div className="text-red-200">Error: {error}</div>
        </div>
      )}

      {/* Token List */}
      <div className="space-y-4 mb-8">
        {loading && tokens.length > 0 && (
          <div className="text-center py-4">
            <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
            <span className="ml-2">Updating...</span>
          </div>
        )}

        {tokens.map((token) => {
          const analytics = analyticsData[token.token_address] as
            | EnrichedTokenData
            | undefined;
          const insights = deriveTrackerTokenInsights(token, analytics);

          return (
          <div
            key={token.token_address}
            className="bg-gray-800 rounded-lg p-6 hover:bg-gray-750 transition-colors"
          >
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between">
              {/* Token Header */}
              <div className="flex items-center space-x-4 mb-4 lg:mb-0">
                <div className="flex-shrink-0">
                  <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-full flex items-center justify-center text-white font-bold text-lg">
                    {token.token_symbol.charAt(0)}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center space-x-2">
                    <h3 className="text-lg font-semibold text-white truncate">
                      {token.token_symbol}
                    </h3>
                    {token.pattern_predicted === "winner" &&
                      token.pattern_p_winner != null && (
                        <span
                          className="shrink-0 rounded bg-emerald-700/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-50"
                          title={`Pattern ML winner (${Math.round(token.pattern_p_winner * 100)}% confidence)`}
                        >
                          Predictive
                        </span>
                      )}
                    <span
                      className={`text-2xl ${getGrowthColor(token.mcap_growth_percent)}`}
                    >
                      {getGrowthIcon(token.mcap_growth_percent)}
                    </span>
                    <button
                      onClick={() => {
                        handleOpenChart(token.token_address);
                        if (!token.is_finished) {
                          void refetchTokenMcap(token.token_address);
                        }
                      }}
                      className="px-2 py-1 bg-green-600 hover:bg-green-700 text-white text-xs rounded transition-colors"
                      title="Open chart (refreshes mcap when tracking active)"
                    >
                      Chart
                    </button>
                    <button
                      onClick={() => handleOpenChart(token.token_address)}
                      className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors"
                      title="Open Chart & Buy"
                    >
                      Buy
                    </button>
                    {!token.is_finished && (
                      <button
                        onClick={() => refetchTokenMcap(token.token_address)}
                        disabled={refetchingTokens.has(token.token_address)}
                        className={`px-2 py-1 text-white text-xs rounded transition-colors ${
                          refetchingTokens.has(token.token_address)
                            ? "bg-yellow-600 hover:bg-yellow-700"
                            : "bg-gray-600 hover:bg-gray-500"
                        }`}
                        title={
                          refetchingTokens.has(token.token_address)
                            ? "Refetching MCap..."
                            : "Refetch MCap only"
                        }
                      >
                        {refetchingTokens.has(token.token_address) ? "🔄" : "↻"}
                      </button>
                    )}
                    <DlmmChartActions
                      tokenAddress={token.token_address}
                      tokenSymbol={token.token_symbol}
                      source="tracker"
                    />
                    <button
                      onClick={() =>
                        stopTrackingToken(
                          token.token_address,
                          token.token_symbol,
                        )
                      }
                      disabled={
                        stoppingTokens.has(token.token_address) ||
                        token.is_finished
                      }
                      className={`px-2 py-1 text-white text-xs rounded transition-colors ${
                        token.is_finished
                          ? "bg-gray-600 cursor-not-allowed"
                          : stoppingTokens.has(token.token_address)
                            ? "bg-yellow-600 hover:bg-yellow-700"
                            : "bg-red-600 hover:bg-red-700"
                      }`}
                      title={
                        token.is_finished
                          ? "Tracking finished"
                          : stoppingTokens.has(token.token_address)
                            ? "Stopping tracking..."
                            : "Stop tracking and mark loss"
                      }
                    >
                      {stoppingTokens.has(token.token_address) ? "⏳" : "⛔"}
                    </button>
                  </div>
                  <p className="text-sm text-gray-400 font-mono truncate">
                    {token.token_address}
                  </p>
                </div>
              </div>

              {/* Performance Metrics */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 lg:gap-6">
                <div className="text-center lg:text-left">
                  <div className="text-sm text-gray-400">First MCap</div>
                  <div className="text-lg font-semibold text-white">
                    {formatNumber(token.first_mcap)}
                  </div>
                  <div className="text-xs text-blue-400">
                    {formatSolAmount(token.solPerToken.first)}
                  </div>
                </div>

                <div className="text-center lg:text-left">
                  <div className="text-sm text-gray-400">Current MCap</div>
                  <div className="text-lg font-semibold text-white">
                    {formatNumber(token.current_mcap)}
                  </div>
                  <div className="text-xs text-blue-400">
                    {formatSolAmount(token.solPerToken.current)}
                  </div>
                </div>

                <div className="text-center lg:text-left">
                  <div className="text-sm text-gray-400">USD Growth</div>
                  <div
                    className={`text-lg font-semibold ${getGrowthColor(token.mcap_growth_percent)}`}
                  >
                    {formatPercentage(token.mcap_growth_percent)}
                  </div>
                </div>

                <div className="text-center lg:text-left">
                  <div className="text-sm text-gray-400">SOL Growth</div>
                  <div
                    className={`text-lg font-semibold ${getGrowthColor(token.solPerToken.growth)}`}
                  >
                    {formatPercentage(token.solPerToken.growth)}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded bg-gray-700 px-2 py-1 text-gray-200">
                Risk: {formatScore0To100(insights.riskScore)} {insights.riskLabel}
              </span>
              <span className="rounded bg-gray-700 px-2 py-1 text-gray-200 capitalize">
                Momentum: {insights.momentumLabel}
              </span>
              <span className="rounded bg-gray-700 px-2 py-1 text-gray-200">
                Milestones: {insights.milestonesReached}/3
              </span>
              <span className="rounded bg-gray-700 px-2 py-1 text-gray-200">
                Age: {formatTrackingAge(insights.trackingAgeHours)}
              </span>
              <span className="rounded bg-gray-700 px-2 py-1 text-gray-200">
                Liquidity:{" "}
                {insights.volToMcapPct != null
                  ? `Vol/MCap ${insights.volToMcapPct.toFixed(1)}% (${insights.liquidityLabel})`
                  : insights.liquidityLabel}
              </span>
              {insights.timelineInconsistent && (
                <span className="rounded bg-amber-900/60 border border-amber-600 px-2 py-1 text-amber-200">
                  Timeline inconsistent
                </span>
              )}
            </div>

            {/* Additional Information */}
            <div className="mt-4 pt-4 border-t border-gray-700">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-gray-400">First Seen:</span>
                  <span className="ml-2 text-white" suppressHydrationWarning>
                    {dateFmt(token.first_seen_at)}
                  </span>
                  <span className="ml-2 text-xs text-gray-500" suppressHydrationWarning>
                    ({formatDistanceToNow(new Date(token.first_seen_at), { addSuffix: true })})
                  </span>
                </div>

                {/* Finished Status */}
                {typeof token.is_finished !== "undefined" && (
                  <div>
                    <span className="text-gray-400">Status:</span>
                    {token.is_finished ? (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-700 text-gray-200 border border-gray-500">
                        Finished
                      </span>
                    ) : (
                      <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-700 text-blue-100 border border-blue-500">
                        Tracking
                      </span>
                    )}
                  </div>
                )}

                {token.is_finished && token.finished_at && (
                  <div>
                    <span className="text-gray-400">Finished At:</span>
                    <span className="ml-2 text-gray-300" suppressHydrationWarning>
                      {dateFmt(token.finished_at)}
                    </span>
                  </div>
                )}

                {token.when_reach_80pct && (
                  <div>
                    <span className="text-gray-400">Reached +80%:</span>
                    <span className="ml-2 text-green-400" suppressHydrationWarning>
                      {dateFmt(token.when_reach_80pct)}
                    </span>
                  </div>
                )}

                {token.when_reach_120pct && (
                  <div>
                    <span className="text-gray-400">Reached +120%:</span>
                    <span className="ml-2 text-green-400" suppressHydrationWarning>
                      {dateFmt(token.when_reach_120pct)}
                    </span>
                  </div>
                )}

                {token.when_reach_200pct && (
                  <div>
                    <span className="text-gray-400">Reached +200%:</span>
                    <span className="ml-2 text-green-400" suppressHydrationWarning>
                      {dateFmt(token.when_reach_200pct)}
                    </span>
                  </div>
                )}

                <div>
                  <span className="text-gray-400">Last Updated:</span>
                  <span className="ml-2 text-white" suppressHydrationWarning>
                    {dateFmt(token.last_updated_at)}
                  </span>
                  <span className="ml-2 text-xs text-gray-500" suppressHydrationWarning>
                    ({formatDistanceToNow(new Date(token.last_updated_at), { addSuffix: true })})
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-gray-700">
              <button
                onClick={() => toggleAnalytics(token.token_address)}
                className="flex items-center justify-between w-full text-left hover:text-blue-400 transition-colors"
              >
                <div className="flex items-center space-x-2">
                  <span className="text-sm font-medium text-gray-300">
                    Analytics & Risk Assessment
                  </span>
                  {analyticsLoading && (
                    <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                  )}
                </div>
                <svg
                  className={`w-4 h-4 transition-transform ${expandedAnalytics[token.token_address] ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {expandedAnalytics[token.token_address] && (
                <div className="mt-4 space-y-3 bg-gray-750 rounded-lg p-4">
                  {analytics ? (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Z-Score
                          </div>
                          <div
                            className={`text-lg font-semibold ${
                              insights.zScoreAvailable && insights.zScore != null
                                ? Math.abs(insights.zScore) > 2.5
                                  ? "text-red-400"
                                  : Math.abs(insights.zScore) > 1.5
                                    ? "text-yellow-400"
                                    : "text-green-400"
                                : "text-gray-400"
                            }`}
                          >
                            {insights.zScoreAvailable && insights.zScore != null
                              ? insights.zScore.toFixed(2)
                              : "—"}
                          </div>
                        </div>

                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Anomaly Type
                          </div>
                          <div
                            className={`text-sm font-medium capitalize ${getAnomalyColor(analytics.anomaly_type)}`}
                          >
                            {analytics.anomaly_type || "neutral"}
                          </div>
                        </div>

                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Momentum
                          </div>
                          <div
                            className={`text-sm font-medium capitalize ${getMomentumCategoryColor(analytics.momentum_category)}`}
                          >
                            {analytics.momentum_category || insights.momentumLabel}
                          </div>
                        </div>

                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Risk Score
                          </div>
                          <div
                            className={`text-lg font-semibold ${getRiskColor(insights.riskScore)}`}
                          >
                            {formatScore0To100(insights.riskScore)} ·{" "}
                            {insights.riskLabel}
                          </div>
                        </div>
                      </div>

                      {analytics.momentum_signal && (
                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Signal
                          </div>
                          <div className="text-sm">
                            <span
                              className={`capitalize ${getMomentumSignalColor(analytics.momentum_signal.type)}`}
                            >
                              {analytics.momentum_signal.type?.replace("_", " ")}
                            </span>
                            <div className="text-xs text-gray-400 mt-1">
                              Strength:{" "}
                              {(
                                (analytics.momentum_signal.strength ?? 0) * 100
                              ).toFixed(0)}
                              %
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {analytics.current_price_usd != null && (
                          <div className="bg-gray-800 rounded-lg p-3">
                            <div className="text-xs text-gray-400 mb-1">
                              Current Price
                            </div>
                            <div className="text-sm text-white">
                              ${analytics.current_price_usd.toFixed(6)}
                            </div>
                          </div>
                        )}

                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Liquidity
                          </div>
                          <div className="text-sm text-white">
                            {insights.volToMcapPct != null
                              ? `Vol/MCap ${insights.volToMcapPct.toFixed(1)}% (${insights.liquidityLabel})`
                              : insights.liquidityLabel}
                          </div>
                        </div>

                        {analytics.volume_24h != null && (
                          <div className="bg-gray-800 rounded-lg p-3">
                            <div className="text-xs text-gray-400 mb-1">
                              24h Volume
                            </div>
                            <div className="text-sm text-white">
                              ${analytics.volume_24h.toLocaleString()}
                            </div>
                          </div>
                        )}
                      </div>

                      <div
                        className="text-xs text-gray-500 mt-2"
                        suppressHydrationWarning
                      >
                        Analytics updated:{" "}
                        {formatDistanceToNow(
                          new Date(analytics.last_updated_at),
                          { addSuffix: true },
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="text-center py-4">
                      <div className="text-gray-400">
                        Analytics data not available
                      </div>
                      <button
                        onClick={() => void analyticsQuery.refetch()}
                        className="mt-2 px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm transition-colors"
                      >
                        Retry Analytics
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          );
        })}

        {tokens.length === 0 && !loading && (
          <div className="text-center py-12">
            <div className="text-gray-400 text-lg">
              No tokens found matching your criteria
            </div>
            <p className="text-gray-500 mt-2">
              Try adjusting your filters or search terms
            </p>
          </div>
        )}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between bg-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">
            Showing {(pagination.page - 1) * pagination.limit + 1} to{" "}
            {Math.min(pagination.page * pagination.limit, pagination.total)} of{" "}
            {pagination.total} tokens
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => setPage(pagination.page - 1)}
              disabled={pagination.page <= 1 || loading}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded text-sm transition-colors"
            >
              Previous
            </button>

            <span className="px-3 py-1 bg-blue-600 rounded text-sm">
              {pagination.page} of {pagination.totalPages}
            </span>

            <button
              onClick={() => setPage(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages || loading}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded text-sm transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
