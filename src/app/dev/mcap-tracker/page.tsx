"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  getTokenWithAnalytics,
  EnrichedTokenData,
} from "@/utils/data-aggregation";
import ChartBuyModal from "@/components/ChartBuyModal";
import UnifiedTrackerModule from "@/components/UnifiedTrackerModule";
import NavigationTabs from "@/components/NavigationTabs";

interface McapTrackingData {
  token_address: string;
  token_symbol: string;
  first_mcap: number;
  current_mcap: number;
  first_seen_at: string;
  last_updated_at: string;
  mcap_growth_percent: number;
  when_reach_80mc: string | null;
  when_reach_120mc: string | null;
  when_reach_200mc: string | null;
  solPerToken: {
    first: number;
    current: number;
    growth: number;
  };
  // Finished status fields (from API enhancedData)
  is_finished?: boolean;
  finished_at?: string | null;
}

interface FilterOptions {
  search: string;
  sortBy: string;
  sortOrder: "asc" | "desc";
  minGrowth: string;
  maxGrowth: string;
  minMcap: string;
  maxMcap: string;
  excludeZeroPnl: boolean;
  timeFilter: "1h" | "4h" | "24h" | "3d" | "7d" | "1m" | "all";
  performanceFilter: "all" | "gainers" | "losers" | "top_performers";
}

interface ApiResponse {
  success: boolean;
  data: McapTrackingData[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  stats: {
    total: number;
    gainers: number;
    losers: number;
    zeroPercent: number;
    zeroPercentage: number;
    avgGrowth: number;
    avgGrowthAll: number;
    avgGrowthExcludingZero: number;
    totalMcap: number;
    solPriceUSD: number;
    pnlTimeWindows: Record<
      string,
      {
        count: number;
        timeDistribution: Record<string, number>;
        peakHours: string[];
        avgTimeToReach: number;
      }
    >;
    pnlBuyTimeWindows?: Record<
      string,
      {
        count: number;
        timeDistribution: Record<string, number>; // keys "00".."23" (UTC-based before conversion)
        peakHours: string[];
        avgTimeToReach: number;
      }
    >;
    timeWindowMeta?: {
      sellPeakHourBasis: string;
      sellPeakHourTimezone: string;
      buyPeakHourBasis: string;
      buyPeakHourTimezone: string;
    };
    mcapRangeAnalysis: {
      under50k: {
        count: number;
        avgMultiplier: number;
        maxDrawdown: number;
        avgGrowth: number;
        medianMultiplier: number;
        medianGrowth: number;
        p75Growth: number;
        p90Growth: number;
        p25Growth: number;
        worstGrowth: number;
        stopLossRate: number;
        stuckRate: number;
        hitRate120: number;
        bucketVolatility: number;
        p75Multiplier: number;
        growthHistogram: number[];
      };
      from51to100k: {
        count: number;
        avgMultiplier: number;
        maxDrawdown: number;
        avgGrowth: number;
        medianMultiplier: number;
        medianGrowth: number;
        p75Growth: number;
        p90Growth: number;
        p25Growth: number;
        worstGrowth: number;
        stopLossRate: number;
        stuckRate: number;
        hitRate120: number;
        bucketVolatility: number;
        p75Multiplier: number;
        growthHistogram: number[];
      };
      from101to200k: {
        count: number;
        avgMultiplier: number;
        maxDrawdown: number;
        avgGrowth: number;
        medianMultiplier: number;
        medianGrowth: number;
        p75Growth: number;
        p90Growth: number;
        p25Growth: number;
        worstGrowth: number;
        stopLossRate: number;
        stuckRate: number;
        hitRate120: number;
        bucketVolatility: number;
        p75Multiplier: number;
        growthHistogram: number[];
      };
      from201to500k: {
        count: number;
        avgMultiplier: number;
        maxDrawdown: number;
        avgGrowth: number;
        medianMultiplier: number;
        medianGrowth: number;
        p75Growth: number;
        p90Growth: number;
        p25Growth: number;
        worstGrowth: number;
        stopLossRate: number;
        stuckRate: number;
        hitRate120: number;
        bucketVolatility: number;
        p75Multiplier: number;
        growthHistogram: number[];
      };
      from501kto1M: {
        count: number;
        avgMultiplier: number;
        maxDrawdown: number;
        avgGrowth: number;
        medianMultiplier: number;
        medianGrowth: number;
        p75Growth: number;
        p90Growth: number;
        p25Growth: number;
        worstGrowth: number;
        stopLossRate: number;
        stuckRate: number;
        hitRate120: number;
        bucketVolatility: number;
        p75Multiplier: number;
        growthHistogram: number[];
      };
      over1M: {
        count: number;
        avgMultiplier: number;
        maxDrawdown: number;
        avgGrowth: number;
        medianMultiplier: number;
        medianGrowth: number;
        p75Growth: number;
        p90Growth: number;
        p25Growth: number;
        worstGrowth: number;
        stopLossRate: number;
        stuckRate: number;
        hitRate120: number;
        bucketVolatility: number;
        p75Multiplier: number;
        growthHistogram: number[];
      };
    };
    thirtyDaysSummary: {
      totalTokensAdded: number;
      avgDailyGrowth: number;
      dailyBreakdown: Array<{
        date: string;
        tokensAdded: number;
        avgGrowth: number;
        totalMcap: number;
        gainers: number;
        losers: number;
      }>;
    };
  };
  toasts?: Array<{
    type: string;
    title: string;
    message: string;
    items?: Array<{ symbol: string; address: string; growthPercent: number }>;
  }>;
  error: string;
}

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

// Daily Ranking Visualization Component
function DailyRankingVisualization({
  tokens,
  stats,
}: {
  tokens: McapTrackingData[];
  stats: any;
}) {
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [expandedRankings, setExpandedRankings] = useState<
    Record<string, boolean>
  >({});

  const toggleRanking = (category: string) => {
    setExpandedRankings((prev) => ({
      ...prev,
      [category]: !prev[category],
    }));
  };

  // Get daily breakdown data from stats
  const dailyData = stats?.thirtyDaysSummary?.dailyBreakdown || [];
  const sortedDailyData = [...dailyData].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  // Initialize selected date to today (most recent date)
  React.useEffect(() => {
    if (sortedDailyData.length > 0 && !selectedDate) {
      setSelectedDate(sortedDailyData[0].date);
    }
  }, [sortedDailyData, selectedDate]);

  // Get current day's data based on selected date
  const currentDayData = sortedDailyData.find(
    (day) => day.date === selectedDate,
  ) || {
    date: selectedDate || new Date().toISOString().split("T")[0],
    tokensAdded: 0,
    gainers: 0,
    losers: 0,
    avgGrowth: 0,
    totalMcap: 0,
  };

  // Filter tokens based on selected date
  const filteredTokens = React.useMemo(() => {
    if (!selectedDate) return tokens;

    const selectedDateObj = new Date(selectedDate);
    const nextDay = new Date(selectedDateObj);
    nextDay.setDate(nextDay.getDate() + 1);

    return tokens.filter((token) => {
      const tokenDate = new Date(token.first_seen_at);
      const tokenDateOnly = new Date(
        tokenDate.getFullYear(),
        tokenDate.getMonth(),
        tokenDate.getDate(),
      );
      const selectedDateOnly = new Date(
        selectedDateObj.getFullYear(),
        selectedDateObj.getMonth(),
        selectedDateObj.getDate(),
      );

      return tokenDateOnly.getTime() === selectedDateOnly.getTime();
    });
  }, [tokens, selectedDate]);

  // Separate tokens by performance
  const gainersTokens = filteredTokens.filter(
    (token) => token.mcap_growth_percent > 0,
  );
  const losersTokens = filteredTokens.filter(
    (token) => token.mcap_growth_percent < 0,
  );
  const neutralTokens = filteredTokens.filter(
    (token) => Math.abs(token.mcap_growth_percent) < 0.01,
  );

  // Calculate actual average growth from filtered tokens
  const actualAvgGrowth =
    filteredTokens.length > 0
      ? filteredTokens.reduce(
          (sum, token) => sum + token.mcap_growth_percent,
          0,
        ) / filteredTokens.length
      : 0;

  // Get top performers for different categories based on filtered tokens
  const sortedGainers = [...gainersTokens].sort(
    (a, b) => b.mcap_growth_percent - a.mcap_growth_percent,
  );
  const topGainers = expandedRankings["gainers"]
    ? sortedGainers
    : sortedGainers.slice(0, 5);

  const sortedVolume = [...filteredTokens]
    .filter((token) => token.current_mcap > 0)
    .sort((a, b) => b.current_mcap - a.current_mcap);
  const topVolume = expandedRankings["volume"]
    ? sortedVolume
    : sortedVolume.slice(0, 5);

  const sortedMultipliers = [...filteredTokens]
    .filter((token) => token.mcap_growth_percent > 100)
    .sort((a, b) => b.mcap_growth_percent - a.mcap_growth_percent);
  const topMultipliers = expandedRankings["multipliers"]
    ? sortedMultipliers
    : sortedMultipliers.slice(0, 5);

  const formatNumber = (num: number): string => {
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(0)}K`;
    return `$${num.toFixed(0)}`;
  };

  const formatPercentage = (percent: number): string => {
    return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
  };

  const getGrowthColor = (percent: number): string => {
    if (Math.abs(percent) < 0.01) return "text-gray-400";
    return percent >= 0 ? "text-green-400" : "text-red-400";
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayName = days[date.getDay()];
    const day = date.getDate().toString().padStart(2, "0");
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const year = date.getFullYear().toString().slice(-2);
    return `${dayName}, ${day}/${month}/${year}`;
  };

  const getChartUrl = (tokenAddress: string): string => {
    return `https://v2.reloadsol.xyz/chart/${tokenAddress}`;
  };

  const TokenItem = ({
    token,
    index,
    category,
  }: {
    token: McapTrackingData;
    index: number;
    category: string;
  }) => (
    <div
      key={token.token_address}
      className="flex items-center justify-between"
    >
      <div className="flex items-center space-x-2">
        <span className="text-yellow-400 font-bold">#{index + 1}</span>
        <div>
          <a
            href={getChartUrl(token.token_address)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white font-medium hover:text-blue-400 transition-colors cursor-pointer"
          >
            {token.token_symbol}
          </a>
          <div className="text-xs text-gray-400">
            {category === "volume"
              ? `Started: ${formatNumber(token.first_mcap)}`
              : formatNumber(token.current_mcap)}
          </div>
        </div>
      </div>
      <div className="text-right">
        {category === "volume" ? (
          <>
            <div className="text-blue-400 font-bold">
              {formatNumber(token.current_mcap)}
            </div>
            <div
              className={`text-xs ${getGrowthColor(token.mcap_growth_percent)}`}
            >
              {formatPercentage(token.mcap_growth_percent)}
            </div>
          </>
        ) : category === "multipliers" ? (
          <>
            <div className="text-purple-400 font-bold">
              {(token.mcap_growth_percent / 100 + 1).toFixed(2)}x
            </div>
            <div
              className={`text-xs ${getGrowthColor(token.mcap_growth_percent)}`}
            >
              {formatPercentage(token.mcap_growth_percent)}
            </div>
          </>
        ) : (
          <>
            <div
              className={`font-bold ${getGrowthColor(token.mcap_growth_percent)}`}
            >
              {formatPercentage(token.mcap_growth_percent)}
            </div>
            <div className="text-xs text-gray-400">
              {(token.mcap_growth_percent / 100 + 1).toFixed(2)}x
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div className="bg-gray-800 rounded-lg p-6 mb-8">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-bold text-white">
          🏆 Daily Performance Rankings
        </h3>
        <div className="text-sm text-gray-400">
          {formatDate(currentDayData.date)}
        </div>
      </div>

      {/* Date Slider */}
      {sortedDailyData.length > 1 && (
        <div className="mb-6">
          <div className="flex items-center space-x-4">
            <span className="text-sm text-gray-400">Select Date:</span>
            <div className="flex-1">
              <select
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="w-full bg-gray-700 text-white rounded-lg px-3 py-2 text-sm border border-gray-600 focus:border-blue-500 focus:outline-none"
              >
                {sortedDailyData.map((day, index) => (
                  <option key={day.date} value={day.date}>
                    {index === 0
                      ? "Today"
                      : index === 1
                        ? "Yesterday"
                        : `${index} days ago`}{" "}
                    - {formatDate(day.date)}
                  </option>
                ))}
              </select>
            </div>
            <div className="text-sm text-white min-w-[120px]">
              {filteredTokens.length} tokens
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Top Gainers */}
        <div className="bg-gray-700 rounded-lg p-4">
          <h4 className="text-lg font-semibold text-green-400 mb-4 flex items-center">
            📈 Top Gainers
          </h4>
          <div className="space-y-3">
            {topGainers.map((token, index) => (
              <TokenItem
                key={token.token_address}
                token={token}
                index={index}
                category="gainers"
              />
            ))}
            {sortedGainers.length === 0 && (
              <div className="text-gray-400 text-center py-4">
                No gainers today
              </div>
            )}
            {sortedGainers.length > 5 && (
              <button
                onClick={() => toggleRanking("gainers")}
                className="w-full mt-2 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-600 rounded transition-colors"
              >
                {expandedRankings["gainers"]
                  ? "Show Less"
                  : `Show All (${sortedGainers.length})`}
              </button>
            )}
          </div>
        </div>

        {/* Top Volume */}
        <div className="bg-gray-700 rounded-lg p-4">
          <h4 className="text-lg font-semibold text-blue-400 mb-4 flex items-center">
            💰 Highest Market Cap
          </h4>
          <div className="space-y-3">
            {topVolume.map((token, index) => (
              <TokenItem
                key={token.token_address}
                token={token}
                index={index}
                category="volume"
              />
            ))}
            {sortedVolume.length === 0 && (
              <div className="text-gray-400 text-center py-4">
                No volume data
              </div>
            )}
            {sortedVolume.length > 5 && (
              <button
                onClick={() => toggleRanking("volume")}
                className="w-full mt-2 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-600 rounded transition-colors"
              >
                {expandedRankings["volume"]
                  ? "Show Less"
                  : `Show All (${sortedVolume.length})`}
              </button>
            )}
          </div>
        </div>

        {/* Top Multipliers */}
        <div className="bg-gray-700 rounded-lg p-4">
          <h4 className="text-lg font-semibold text-purple-400 mb-4 flex items-center">
            🚀 Top Multipliers ({">"}100%)
          </h4>
          <div className="space-y-3">
            {topMultipliers.map((token, index) => (
              <TokenItem
                key={token.token_address}
                token={token}
                index={index}
                category="multipliers"
              />
            ))}
            {sortedMultipliers.length === 0 && (
              <div className="text-gray-400 text-center py-4">
                No 100%+ performers today
              </div>
            )}
            {sortedMultipliers.length > 5 && (
              <button
                onClick={() => toggleRanking("multipliers")}
                className="w-full mt-2 py-2 text-sm text-gray-400 hover:text-white hover:bg-gray-600 rounded transition-colors"
              >
                {expandedRankings["multipliers"]
                  ? "Show Less"
                  : `Show All (${sortedMultipliers.length})`}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Daily Summary Stats */}
      <div className="mt-6 pt-6 border-t border-gray-600">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
          <div>
            <button
              onClick={() =>
                setExpandedSection(expandedSection === "total" ? null : "total")
              }
              className="w-full hover:bg-gray-700 rounded-lg p-2 transition-colors"
            >
              <div className="text-2xl font-bold text-white">
                {filteredTokens.length}
              </div>
              <div className="text-sm text-gray-400">Total Tokens</div>
              <div className="text-xs text-blue-400 mt-1">Click to view</div>
            </button>
            {expandedSection === "total" && (
              <div className="mt-2 bg-gray-800 rounded-lg p-3 max-h-48 overflow-y-auto">
                <div className="text-left space-y-1">
                  {filteredTokens.map((token, index) => (
                    <TokenItem
                      key={token.token_address}
                      token={token}
                      index={index}
                      category="total"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <button
              onClick={() =>
                setExpandedSection(
                  expandedSection === "gainers" ? null : "gainers",
                )
              }
              className="w-full hover:bg-gray-700 rounded-lg p-2 transition-colors"
            >
              <div className="text-2xl font-bold text-green-400">
                {gainersTokens.length}
              </div>
              <div className="text-sm text-gray-400">Gainers</div>
              <div className="text-xs text-blue-400 mt-1">Click to view</div>
            </button>
            {expandedSection === "gainers" && (
              <div className="mt-2 bg-gray-800 rounded-lg p-3 max-h-48 overflow-y-auto">
                <div className="text-left space-y-1">
                  {gainersTokens.map((token, index) => (
                    <TokenItem
                      key={token.token_address}
                      token={token}
                      index={index}
                      category="gainers"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <button
              onClick={() =>
                setExpandedSection(
                  expandedSection === "losers" ? null : "losers",
                )
              }
              className="w-full hover:bg-gray-700 rounded-lg p-2 transition-colors"
            >
              <div className="text-2xl font-bold text-red-400">
                {losersTokens.length}
              </div>
              <div className="text-sm text-gray-400">Losers</div>
              <div className="text-xs text-blue-400 mt-1">Click to view</div>
            </button>
            {expandedSection === "losers" && (
              <div className="mt-2 bg-gray-800 rounded-lg p-3 max-h-48 overflow-y-auto">
                <div className="text-left space-y-1">
                  {losersTokens.map((token, index) => (
                    <TokenItem
                      key={token.token_address}
                      token={token}
                      index={index}
                      category="losers"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <button
              onClick={() =>
                setExpandedSection(
                  expandedSection === "neutral" ? null : "neutral",
                )
              }
              className="w-full hover:bg-gray-700 rounded-lg p-2 transition-colors"
            >
              <div className="text-2xl font-bold text-gray-400">
                {neutralTokens.length}
              </div>
              <div className="text-sm text-gray-400">Neutral (0%)</div>
              <div className="text-xs text-blue-400 mt-1">Click to view</div>
            </button>
            {expandedSection === "neutral" && (
              <div className="mt-2 bg-gray-800 rounded-lg p-3 max-h-48 overflow-y-auto">
                <div className="text-left space-y-1">
                  {neutralTokens.map((token, index) => (
                    <TokenItem
                      key={token.token_address}
                      token={token}
                      index={index}
                      category="neutral"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <div>
            <div
              className={`text-2xl font-bold ${getGrowthColor(actualAvgGrowth)}`}
            >
              {formatPercentage(actualAvgGrowth)}
            </div>
            <div className="text-sm text-gray-400">Avg Growth</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function McapTrackerPage() {
  const [tokens, setTokens] = useState<McapTrackingData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [stats, setStats] = useState<ApiResponse["stats"] | null>(null);
  const [expandedChart, setExpandedChart] = useState<string | null>(null);
  const [isChartLoading, setIsChartLoading] = useState(false);
  const [refetchingTokens, setRefetchingTokens] = useState<Set<string>>(
    new Set(),
  );
  // const [isPnlTimeWindowsExpanded, setIsPnlTimeWindowsExpanded] = useState(true)
  const [activeMcapFilter, setActiveMcapFilter] = useState<string | null>(null);
  // Desired display GMT offset (GMT+X), integer hours from -12 to +14
  const [displayGmtOffset, setDisplayGmtOffset] = useState<number>(0);
  // Base offset for Sell section (server local timezone; unknown => default 0)
  const [sellServerBaseOffset, setSellServerBaseOffset] = useState<number>(0);

  const [analyticsData, setAnalyticsData] = useState<
    Record<string, EnrichedTokenData>
  >({});
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
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

  const [pagination, setPagination] = useState({
    page: 1,
    limit: 100,
    total: 0,
    totalPages: 0,
  });

  const [filters, setFilters] = useState<FilterOptions>({
    search: "",
    sortBy: "last_updated_at",
    sortOrder: "desc",
    minGrowth: "",
    maxGrowth: "",
    minMcap: "",
    maxMcap: "",
    excludeZeroPnl: false,
    timeFilter: "all",
    performanceFilter: "all",
  });

  // Toast handling
  type ToastMessage = {
    type: string;
    title: string;
    message: string;
    items?: Array<{
      symbol: string;
      address: string;
      growthPercent: number;
      deltaPercent?: number;
      currentMcap?: number;
    }>;
  };
  type ToastWithId = ToastMessage & { id: number };
  const DEFAULT_PNL_TOAST_THRESHOLD = Number(
    process.env.NEXT_PUBLIC_MCAP_PNL_TOAST_THRESHOLD || 20,
  );
  const [activeToasts, setActiveToasts] = useState<ToastWithId[]>([]);
  const toastTimers = useRef<Record<number, number>>({});
  // Track last toast growthPercent per token to compute n-1 delta
  const prevToastGrowth = useRef<Record<string, number>>({});
  // Dedup toast pushes within a rolling window
  const recentToastKeys = useRef<Record<string, number>>({});
  const TOAST_DEDUP_WINDOW_MS = 30000;

  const computeToastKey = (
    t: ToastMessage,
    enrichedItems?: Array<{
      symbol: string;
      address: string;
      growthPercent: number;
      deltaPercent?: number;
      currentMcap?: number;
    }>,
  ) => {
    const items = enrichedItems ?? t.items ?? [];
    const itemKey = items
      .map(
        (i) => `${i.address}:${(i.deltaPercent ?? i.growthPercent).toFixed(2)}`,
      )
      .sort()
      .join("|");
    return `${t.title}|${t.type}|${t.message}|${itemKey}`;
  };

  const pushToasts = useCallback(
    (toasts?: ToastMessage[]) => {
      if (!toasts || toasts.length === 0) return;
      // Prune old dedup keys
      const now = Date.now();
      Object.entries(recentToastKeys.current).forEach(([k, ts]) => {
        if (now - ts > TOAST_DEDUP_WINDOW_MS) delete recentToastKeys.current[k];
      });

      toasts.forEach((t) => {
        const id = Date.now() + Math.floor(Math.random() * 100000);
        // Enrich items with deltaPercent (current - previous) and currentMcap
        const enrichedItems =
          t.items?.map((item) => {
            const prev = prevToastGrowth.current[item.address];
            const token = tokens.find(
              (tok) => tok.token_address === item.address,
            );
            const baselinePrev =
              typeof prev === "number"
                ? prev
                : typeof token?.mcap_growth_percent === "number"
                  ? token!.mcap_growth_percent
                  : undefined;
            const delta =
              typeof baselinePrev === "number"
                ? item.growthPercent - baselinePrev
                : item.growthPercent;
            // Update prev map to this latest growth for next comparison
            prevToastGrowth.current[item.address] = item.growthPercent;
            return {
              ...item,
              deltaPercent: delta,
              currentMcap: token?.current_mcap,
            };
          }) ?? t.items;

        // Dedup: skip pushing identical toast within the window
        const key = computeToastKey(t, enrichedItems);
        const last = recentToastKeys.current[key];
        if (last && now - last < TOAST_DEDUP_WINDOW_MS) {
          return;
        }
        recentToastKeys.current[key] = now;

        const normalizedType =
          t.type && t.type.trim()
            ? t.type
            : t.title === "New Token Tracked"
              ? "success"
              : "info";

        setActiveToasts((prev) => [
          ...prev,
          { ...t, items: enrichedItems, type: normalizedType, id },
        ]);

        const timeoutId = window.setTimeout(() => {
          setActiveToasts((prev) => prev.filter((x) => x.id !== id));
          delete toastTimers.current[id];
        }, 6000);
        toastTimers.current[id] = timeoutId;
      });
    },
    [tokens],
  );

  // Map toast type to Tailwind styles
  const getToastStyles = (type: string) => {
    switch (type) {
      case "success":
        return "bg-green-600 border-green-400";
      case "info":
        return "bg-blue-600 border-blue-400";
      case "warning":
        return "bg-yellow-600 border-yellow-400 text-black";
      case "error":
        return "bg-red-600 border-red-400";
      default:
        return "bg-gray-700 border-gray-500";
    }
  };

  // Compact currency formatter for MCap in toasts
  const formatMcapCompact = (num?: number): string => {
    if (typeof num !== "number" || !isFinite(num)) return "N/A";
    if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(0)}K`;
    return `$${num.toFixed(0)}`;
  };

  // PnL toast threshold (user-configurable, clamped to 30%)
  const clampThreshold = useCallback(
    (n: number) => Math.max(0, Math.min(30, Math.round(n))),
    [],
  );
  const LOCAL_STORAGE_KEY_PNL_TOAST = "mcap_pnl_toast_threshold";
  const [pnlToastThreshold, setPnlToastThreshold] = useState<number>(() => {
    try {
      const raw =
        typeof window !== "undefined"
          ? localStorage.getItem(LOCAL_STORAGE_KEY_PNL_TOAST)
          : null;
      const saved = raw != null ? Number(raw) : NaN;
      return clampThreshold(
        Number.isFinite(saved) ? saved : DEFAULT_PNL_TOAST_THRESHOLD,
      );
    } catch (e) {
      return clampThreshold(DEFAULT_PNL_TOAST_THRESHOLD);
    }
  });

  const handleSavePnlToastThreshold = useCallback(() => {
    try {
      localStorage.setItem(
        LOCAL_STORAGE_KEY_PNL_TOAST,
        String(pnlToastThreshold),
      );
      pushToasts([
        {
          type: "success",
          title: "Threshold Saved",
          message: `Toasts will use ${pnlToastThreshold}% until changed.`,
        },
      ]);
    } catch (e) {
      pushToasts([
        {
          type: "error",
          title: "Save Failed",
          message: "Could not save threshold to local storage",
        },
      ]);
    }
  }, [pnlToastThreshold]);

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

  // Prevent overlapping fetches that can emit duplicate toasts
  const isFetchingRef = useRef<boolean>(false);

  const fetchTokens = useCallback(
    async (page = 1) => {
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;
      setLoading(true);
      setError("");

      try {
        const params = new URLSearchParams({
          action: "list",
          page: page.toString(),
          limit: pagination.limit.toString(),
          sortBy: filters.sortBy,
          sortOrder: filters.sortOrder,
          excludeZeroPnl: filters.excludeZeroPnl.toString(),
          timeFilter: filters.timeFilter,
          performanceFilter: filters.performanceFilter,
          pnlThreshold: pnlToastThreshold.toString(),
        });

        if (filters.search) params.append("search", filters.search);
        if (filters.minGrowth) params.append("minGrowth", filters.minGrowth);
        if (filters.maxGrowth) params.append("maxGrowth", filters.maxGrowth);

        // MCap range filtering takes precedence over manual MCap filters
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
            params.append("minMcap", range.min.toString());
            if (range.max !== Number.MAX_SAFE_INTEGER) {
              params.append("maxMcap", range.max.toString());
            }
          }
        } else {
          // Only use manual MCap filters if no range filter is active
          if (filters.minMcap) params.append("minMcap", filters.minMcap);
          if (filters.maxMcap) params.append("maxMcap", filters.maxMcap);
        }

        const response = await fetch(`/api/mcap-tracking?${params}`);
        const data: ApiResponse = await response.json();

        if (data.success) {
          setTokens(data.data);
          setPagination(data.pagination);
          setStats(data.stats);
          // Show any server-suggested toasts
          pushToasts(data.toasts);
        } else {
          setError(data.error || "Failed to fetch data");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
        isFetchingRef.current = false;
      }
    },
    [filters, pagination.limit, activeMcapFilter, pnlToastThreshold],
  );

  // Single effect to fetch on dependency changes
  useEffect(() => {
    fetchTokens(1);
  }, [filters, activeMcapFilter, pnlToastThreshold]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchTokens(pagination.page);
    }, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, [fetchTokens, pagination.page]);

  // Move analytics hooks BEFORE any early returns
  const fetchAnalyticsForTokens = useCallback(
    async (tokenAddresses: string[]) => {
      if (tokenAddresses.length === 0) return;

      // tokenAddresses is already the correct format

      try {
        const response = await fetch("/api/analytics/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            tokenAddresses,
            maxAge: 60, // Only recent data
          }),
        });

        if (!response.ok) {
          throw new Error(`API request failed: ${response.status}`);
        }

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Analytics request failed");
        }

        // Update analytics data state
        const newAnalyticsData: Record<string, EnrichedTokenData> = {};
        result.data.forEach((token: EnrichedTokenData) => {
          newAnalyticsData[token.token_address] = token;
        });

        setAnalyticsData((prev) => ({ ...prev, ...newAnalyticsData }));
      } catch (error) {
        console.error("Failed to fetch analytics for tokens:", error);
        // Don't throw here to prevent breaking the UI
      }
    },
    [],
  );

  const toggleAnalytics = (tokenAddress: string) => {
    setExpandedAnalytics((prev) => ({
      ...prev,
      [tokenAddress]: !prev[tokenAddress],
    }));
  };

  const getAnomalyColor = (anomalyType?: string) => {
    if (!anomalyType) return "text-gray-400";
    if (anomalyType === "high") return "text-red-400";
    if (anomalyType === "low") return "text-blue-400";
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
    if (riskScore === undefined || riskScore === null) return "text-gray-400";
    if (riskScore > 0.7) return "text-red-400";
    if (riskScore > 0.4) return "text-yellow-400";
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
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  useEffect(() => {
    const interval = setInterval(() => {
      fetchTokens(pagination.page);
    }, 30000);

    return () => clearInterval(interval);
  }, [fetchTokens, pagination.page]);

  // Analytics useEffect - also moved before early return
  useEffect(() => {
    if (tokens.length > 0) {
      const tokenAddresses = tokens.map((t) => t.token_address);
      fetchAnalyticsForTokens(tokenAddresses);
    }
  }, [tokens, fetchAnalyticsForTokens]);

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
    if (solAmount >= 1000) return `${(solAmount / 1000).toFixed(2)}K SOL`;
    if (solAmount >= 1) return `${solAmount.toFixed(2)} SOL`;
    return `${solAmount.toFixed(4)} SOL`;
  };

  const formatPercentage = (percent: number): string => {
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

  const handleChartToggle = async (tokenAddress: string) => {
    const tok = tokens.find((t) => t.token_address === tokenAddress);
    if (tok?.is_finished) {
      // Toggle chart without refetch if finished
      if (expandedChart === tokenAddress) {
        setExpandedChart(null);
      } else {
        setExpandedChart(tokenAddress);
      }
      setIsChartLoading(false);
      return;
    }

    if (expandedChart === tokenAddress) {
      setExpandedChart(null);
      setIsChartLoading(false);
    } else {
      setExpandedChart(tokenAddress);
      setIsChartLoading(true);

      // Refetch current MCap data when opening chart (only if not finished)
      await refetchTokenMcap(tokenAddress);
    }
  };

  const refetchTokenMcap = async (tokenAddress: string) => {
    const tok = tokens.find((t) => t.token_address === tokenAddress);
    if (tok?.is_finished) return;
    if (refetchingTokens.has(tokenAddress)) return;

    setRefetchingTokens((prev) => new Set(prev).add(tokenAddress));

    try {
      const response = await fetch(
        `/api/mcap-tracking?action=refetch&token=${tokenAddress}&pnlThreshold=${pnlToastThreshold}`,
      );
      const data = await response.json();

      if (data.success) {
        // Show server-suggested toasts
        pushToasts(data.toasts);
        // Update the token in the current list with new data
        setTokens((prevTokens) =>
          prevTokens.map((token) => {
            if (token.token_address === tokenAddress) {
              const solPriceUSD = stats?.solPriceUSD || 1;
              return {
                ...token,
                first_mcap: data.firstMcap ?? token.first_mcap,
                current_mcap: data.currentMcap ?? token.current_mcap,
                mcap_growth_percent:
                  data.tracking?.growthPercent ?? token.mcap_growth_percent,
                last_updated_at: new Date().toISOString(),
                solPerToken: {
                  first: token.first_mcap / solPriceUSD,
                  current:
                    (data.currentMcap ?? token.current_mcap) / solPriceUSD,
                  growth:
                    (((data.currentMcap ?? token.current_mcap) / solPriceUSD -
                      token.first_mcap / solPriceUSD) /
                      (token.first_mcap / solPriceUSD)) *
                    100,
                },
              };
            }
            return token;
          }),
        );

        // Refresh the full data to update stats (including finished status)
        await fetchTokens(pagination.page);

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
      token.first_seen_at,
      token.last_updated_at,
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
      <div className="min-h-screen bg-gray-900 text-white p-6">
        {/* Toasts (fixed, viewport-level) */}
        {activeToasts.length > 0 && (
          <div className="fixed top-4 right-4 z-50 space-y-2">
            {activeToasts.map((t) => (
              <div
                key={t.id}
                className={`w-80 rounded-md border shadow-lg p-3 text-white ${getToastStyles(t.type)}`}
                onMouseEnter={() => {
                  const tid = toastTimers.current[t.id];
                  if (tid) {
                    clearTimeout(tid);
                    delete toastTimers.current[t.id];
                  }
                }}
                onMouseLeave={() => {
                  if (!toastTimers.current[t.id]) {
                    const timeoutId = window.setTimeout(() => {
                      setActiveToasts((prev) =>
                        prev.filter((x) => x.id !== t.id),
                      );
                      delete toastTimers.current[t.id];
                    }, 6000);
                    toastTimers.current[t.id] = timeoutId;
                  }
                }}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-semibold">{t.title}</div>
                    <div className="text-sm opacity-90">{t.message}</div>
                    {t.items && t.items.length > 0 && (
                      <div className="mt-2 max-h-64 overflow-auto pr-1 space-y-2">
                        {t.items.map((item) => {
                          const token = tokens.find(
                            (tok) => tok.token_address === item.address,
                          );
                          const mcap = item.currentMcap ?? token?.current_mcap;
                          const delta =
                            typeof item.deltaPercent === "number"
                              ? item.deltaPercent
                              : typeof item.growthPercent === "number"
                                ? item.growthPercent
                                : 0;
                          const up = delta >= 0;
                          return (
                            <div
                              key={item.address}
                              className="flex justify-between items-center text-sm"
                            >
                              <div className="flex flex-col">
                                <a
                                  href={`/chart/${item.address}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="underline hover:text-white"
                                >
                                  {item.symbol}
                                </a>
                                <div className="text-xs text-gray-300">
                                  MCap: {formatMcapCompact(mcap)}
                                </div>
                              </div>
                              <div
                                className={`ml-2 font-medium ${up ? "text-green-300" : "text-red-300"}`}
                              >
                                {up ? "↑" : "↓"} {Math.abs(delta).toFixed(1)}%
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {t.items && t.items.length > 0 && (
                      <div className="mt-3">
                        {(() => {
                          const uniq = Array.from(
                            new Set(t.items!.map((i) => i.address)),
                          );
                          const url = `/charts?addresses=${encodeURIComponent(uniq.join(","))}`;
                          return (
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center px-2.5 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 text-white"
                            >
                              Open Charts ({uniq.length})
                            </a>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() =>
                      setActiveToasts((prev) =>
                        prev.filter((x) => x.id !== t.id),
                      )
                    }
                    className="ml-3 text-white/80 hover:text-white"
                    aria-label="Dismiss toast"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <h1 className="text-3xl font-bold mb-2">MCap Tracker</h1>
            <p className="text-gray-400">Loading market cap tracking data...</p>
          </div>
          <LoadingSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      {/* Toasts (fixed, viewport-level) */}
      {activeToasts.length > 0 && (
        <div className="fixed top-4 right-4 z-50 space-y-2">
          {activeToasts.map((t) => (
            <div
              key={t.id}
              className={`w-80 rounded-md border shadow-lg p-3 text-white ${getToastStyles(t.type)}`}
              onMouseEnter={() => {
                const tid = toastTimers.current[t.id];
                if (tid) {
                  clearTimeout(tid);
                  delete toastTimers.current[t.id];
                }
              }}
              onMouseLeave={() => {
                if (!toastTimers.current[t.id]) {
                  const timeoutId = window.setTimeout(() => {
                    setActiveToasts((prev) =>
                      prev.filter((x) => x.id !== t.id),
                    );
                    delete toastTimers.current[t.id];
                  }, 6000);
                  toastTimers.current[t.id] = timeoutId;
                }
              }}
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-semibold">{t.title}</div>
                  <div className="text-sm opacity-90">{t.message}</div>
                  {t.items && t.items.length > 0 && (
                    <div className="mt-2 max-h-64 overflow-auto pr-1 space-y-2">
                      {t.items.map((item) => {
                        const token = tokens.find(
                          (tok) => tok.token_address === item.address,
                        );
                        const mcap = item.currentMcap ?? token?.current_mcap;
                        const delta =
                          typeof item.deltaPercent === "number"
                            ? item.deltaPercent
                            : typeof item.growthPercent === "number"
                              ? item.growthPercent
                              : 0;
                        const up = delta >= 0;
                        return (
                          <div
                            key={item.address}
                            className="flex justify-between items-center text-sm"
                          >
                            <div className="flex flex-col">
                              <button
                                onClick={() =>
                                  setModalTokenAddress(item.address)
                                }
                                className="underline hover:text-white text-left"
                              >
                                {item.symbol}
                              </button>
                              <div className="text-xs text-gray-300">
                                MCap: {formatMcapCompact(mcap)}
                              </div>
                            </div>
                            <div
                              className={`ml-2 font-medium ${up ? "text-green-300" : "text-red-300"}`}
                            >
                              {up ? "↑" : "↓"} {Math.abs(delta).toFixed(1)}%
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {t.items && t.items.length > 0 && (
                    <div className="mt-3">
                      {(() => {
                        const uniq = Array.from(
                          new Set(t.items!.map((i) => i.address)),
                        );
                        const url = `/charts?addresses=${encodeURIComponent(uniq.join(","))}`;
                        return (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center px-2.5 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 text-white"
                          >
                            Open Charts ({uniq.length})
                          </a>
                        );
                      })()}
                    </div>
                  )}
                </div>
                <button
                  onClick={() =>
                    setActiveToasts((prev) => prev.filter((x) => x.id !== t.id))
                  }
                  className="ml-3 text-white/80 hover:text-white"
                  aria-label="Dismiss toast"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Chart Buy Modal */}
      {modalTokenAddress && (
        <ChartBuyModal
          tokenAddress={modalTokenAddress}
          onClose={() => setModalTokenAddress(null)}
        />
      )}

      {/* Unified Tracker Module */}
      <NavigationTabs />
      <div className="mt-8">
        <UnifiedTrackerModule />
      </div>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">MCap Tracker</h1>
        <p className="text-gray-400">
          Monitor token market cap changes and growth patterns over time
        </p>
        {stats && (
          <p className="text-sm text-blue-400 mt-2">
            SOL Price: ${stats.solPriceUSD.toFixed(2)}
          </p>
        )}

        {/* PnL Toast Threshold Control (max 30%) */}
        <div className="mt-4 flex items-center gap-3">
          <span className="text-sm text-gray-300">PnL Toast Threshold (%)</span>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={pnlToastThreshold}
            onChange={(e) =>
              setPnlToastThreshold(clampThreshold(Number(e.target.value)))
            }
            className="w-40"
          />
          <input
            type="number"
            min={0}
            max={30}
            step={1}
            value={pnlToastThreshold}
            onChange={(e) =>
              setPnlToastThreshold(clampThreshold(Number(e.target.value)))
            }
            className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1"
          />
          <span className="text-xs text-gray-500">(max 30%)</span>
          <button
            onClick={handleSavePnlToastThreshold}
            className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-md"
            title="Save threshold as default for next reloads"
          >
            Save
          </button>
        </div>
      </div>

      {/* Enhanced Statistics Overview */}
      {stats && (
        <>
          {/* Main Stats */}
          <div className="grid grid-cols-1 md:grid-cols-6 gap-4 mb-8">
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
              <div className="text-2xl font-bold text-purple-400">
                {formatNumber(stats.totalMcap)}
              </div>
              <div className="text-sm text-gray-400">Total MCap</div>
            </div>
          </div>

          {/* 30-Day Summary */}
          <div className="bg-gray-800 rounded-lg p-6 mb-8">
            <h3 className="text-xl font-bold mb-4">30-Day PnL Summary</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">
                      Tokens Added (30 days):
                    </span>
                    <span className="text-white">
                      {stats.thirtyDaysSummary.totalTokensAdded}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Avg Daily Growth:</span>
                    <span
                      className={getGrowthColor(
                        stats.thirtyDaysSummary.avgDailyGrowth,
                      )}
                    >
                      {formatPercentage(stats.thirtyDaysSummary.avgDailyGrowth)}
                    </span>
                  </div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-gray-300 mb-2">
                  Recent Daily Breakdown (Last 7 days)
                </h4>
                <div className="space-y-1 text-xs">
                  {stats.thirtyDaysSummary.dailyBreakdown
                    .slice(-7)
                    .map((day, index) => (
                      <div
                        key={index}
                        className="flex justify-between items-center"
                      >
                        <span className="text-gray-400">{day.date}:</span>
                        <div className="flex items-center space-x-2">
                          <span className="text-white">
                            {day.tokensAdded} tokens
                          </span>
                          <span className={getGrowthColor(day.avgGrowth)}>
                            {formatPercentage(day.avgGrowth)}
                          </span>
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>

          {/* Daily Ranking Visualization */}
          <DailyRankingVisualization tokens={tokens} stats={stats} />

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
                  <label className="text-sm text-gray-300 flex items-center gap-2">
                    Server base offset (Sell):
                    <select
                      className="bg-gray-700 rounded px-2 py-1 text-sm"
                      value={sellServerBaseOffset}
                      onChange={(e) =>
                        setSellServerBaseOffset(parseInt(e.target.value, 10))
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
                Source TZ: {stats.timeWindowMeta?.buyPeakHourTimezone ?? "UTC"}{" "}
                | Display TZ:{" "}
                {displayGmtOffset >= 0
                  ? `GMT+${displayGmtOffset}`
                  : `GMT${displayGmtOffset}`}{" "}
                <br />
                Sell basis:{" "}
                {stats.timeWindowMeta?.sellPeakHourBasis ?? "last_updated_at"} |
                Source TZ:{" "}
                {stats.timeWindowMeta?.sellPeakHourTimezone ?? "server_local"} |
                Display TZ:{" "}
                {displayGmtOffset >= 0
                  ? `GMT+${displayGmtOffset}`
                  : `GMT${displayGmtOffset}`}
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
                      parseFloat(a.replace("%", "")) -
                      parseFloat(b.replace("%", "")),
                  )
                  .map((threshold) => {
                    const sell = stats.pnlTimeWindows[threshold];
                    const buy = stats.pnlBuyTimeWindows
                      ? stats.pnlBuyTimeWindows[threshold]
                      : undefined;

                    // Shift distributions to display TZ
                    const sellShift = displayGmtOffset - sellServerBaseOffset;
                    const adjustedSellDist = sell
                      ? shiftDistribution(sell.timeDistribution, sellShift)
                      : {};
                    const adjustedBuyDist = buy
                      ? shiftDistribution(
                          buy.timeDistribution,
                          displayGmtOffset,
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
                    const thresholdNum = parseFloat(threshold.replace("%", ""));
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
                        <PnlDistributionChart
                          counts={
                            stats.mcapRangeAnalysis.under50k.growthHistogram ||
                            []
                          }
                          // Optionally pass labels if/when you have them:
                          // labels={DEFAULT_PNL_LABELS}
                          // Optionally control the red/green split if labels aren't provided:
                          // negativeSplitIndex={4}
                        />
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
                        <PnlDistributionChart
                          counts={
                            stats.mcapRangeAnalysis.from51to100k
                              .growthHistogram || []
                          }
                        />
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
                        <PnlDistributionChart
                          counts={
                            stats.mcapRangeAnalysis.from101to200k
                              .growthHistogram || []
                          }
                        />
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
                        <PnlDistributionChart
                          counts={
                            stats.mcapRangeAnalysis.from201to500k
                              .growthHistogram || []
                          }
                        />
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
                        <PnlDistributionChart
                          counts={
                            stats.mcapRangeAnalysis.from501kto1M
                              .growthHistogram || []
                          }
                        />
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
                        <PnlDistributionChart
                          counts={
                            stats.mcapRangeAnalysis.over1M.growthHistogram || []
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              </button>
            </div>
          </div>
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
              value={filters.search}
              onChange={(e) =>
                setFilters((prev) => ({ ...prev, search: e.target.value }))
              }
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

        {tokens.map((token) => (
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
                    <span
                      className={`text-2xl ${getGrowthColor(token.mcap_growth_percent)}`}
                    >
                      {getGrowthIcon(token.mcap_growth_percent)}
                    </span>
                    <button
                      onClick={() => handleChartToggle(token.token_address)}
                      disabled={
                        refetchingTokens.has(token.token_address) ||
                        token.is_finished
                      }
                      className={`px-2 py-1 text-white text-xs rounded transition-colors ${
                        token.is_finished
                          ? "bg-gray-600 cursor-not-allowed"
                          : refetchingTokens.has(token.token_address)
                            ? "bg-yellow-600 hover:bg-yellow-700"
                            : "bg-green-600 hover:bg-green-700"
                      }`}
                      title={
                        token.is_finished
                          ? "Tracking finished (4 days). Refetch disabled."
                          : refetchingTokens.has(token.token_address)
                            ? "Refetching MCap..."
                            : "Toggle Chart & Refetch MCap"
                      }
                    >
                      {token.is_finished
                        ? "✅"
                        : refetchingTokens.has(token.token_address)
                          ? "🔄"
                          : "📈"}
                    </button>
                    <button
                      onClick={() => setModalTokenAddress(token.token_address)}
                      className="px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition-colors"
                      title="Open Chart & Buy"
                    >
                      Buy
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

            {/* Inline Chart */}
            {expandedChart === token.token_address && (
              <div className="mt-4 pt-4 border-t border-gray-700">
                <div className="relative" style={{ height: "400px" }}>
                  {isChartLoading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-gray-800 rounded-lg">
                      <div className="flex items-center space-x-2">
                        <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                        <span className="text-gray-400">Loading chart...</span>
                      </div>
                    </div>
                  )}
                  <iframe
                    src={`https://www.gmgn.cc/kline/sol/${token.token_address}?interval=1D&theme=dark`}
                    className="w-full h-full rounded-lg"
                    style={{
                      border: "none",
                      display: isChartLoading ? "none" : "block",
                    }}
                    title={`GMGN Chart - ${token.token_symbol}`}
                    onLoad={() => setIsChartLoading(false)}
                    onError={() => {
                      console.error(
                        "Chart failed to load for token:",
                        token.token_address,
                      );
                      setIsChartLoading(false);
                    }}
                    allowFullScreen
                    frameBorder="0"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  />
                </div>
              </div>
            )}

            {/* Additional Information */}
            <div className="mt-4 pt-4 border-t border-gray-700">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                <div>
                  <span className="text-gray-400">First Seen:</span>
                  <span className="ml-2 text-white">
                    {formatDistanceToNow(new Date(token.first_seen_at), {
                      addSuffix: true,
                    })}
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
                    <span className="ml-2 text-gray-300">
                      {formatDistanceToNow(new Date(token.finished_at), {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                )}

                {token.when_reach_80mc && (
                  <div>
                    <span className="text-gray-400">Reached 80M:</span>
                    <span className="ml-2 text-green-400">
                      {formatDistanceToNow(new Date(token.when_reach_80mc), {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                )}

                {token.when_reach_120mc && (
                  <div>
                    <span className="text-gray-400">Reached 120M:</span>
                    <span className="ml-2 text-green-400">
                      {formatDistanceToNow(new Date(token.when_reach_120mc), {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                )}

                {token.when_reach_200mc && (
                  <div>
                    <span className="text-gray-400">Reached 200M:</span>
                    <span className="ml-2 text-green-400">
                      {formatDistanceToNow(new Date(token.when_reach_200mc), {
                        addSuffix: true,
                      })}
                    </span>
                  </div>
                )}

                <div className="flex justify-end">
                  <span className="text-gray-400">Last Updated:</span>
                  <span className="ml-2 text-white">
                    {formatDistanceToNow(new Date(token.last_updated_at), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
              </div>
            </div>

            {/* Analytics Section - Add this after the existing token information */}
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
                <div className="mt-4 space-y-4 bg-gray-750 rounded-lg p-4">
                  {analyticsData[token.token_address] ? (
                    <>
                      {/* Z-Score Anomaly Detection */}
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Z-Score
                          </div>
                          <div
                            className={`text-lg font-semibold ${
                              analyticsData[token.token_address]?.z_score !==
                              undefined
                                ? Math.abs(
                                    analyticsData[token.token_address].z_score!,
                                  ) > 2
                                  ? "text-red-400"
                                  : Math.abs(
                                        analyticsData[token.token_address]
                                          .z_score!,
                                      ) > 1
                                    ? "text-yellow-400"
                                    : "text-green-400"
                                : "text-gray-400"
                            }`}
                          >
                            {analyticsData[
                              token.token_address
                            ]?.z_score?.toFixed(2) ?? "N/A"}
                          </div>
                        </div>

                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Anomaly Type
                          </div>
                          <div
                            className={`text-sm font-medium capitalize ${getAnomalyColor(analyticsData[token.token_address]?.anomaly_type)}`}
                          >
                            {analyticsData[token.token_address]?.anomaly_type ||
                              "neutral"}
                          </div>
                        </div>

                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Momentum
                          </div>
                          <div
                            className={`text-sm font-medium capitalize ${getMomentumCategoryColor(analyticsData[token.token_address]?.momentum_category)}`}
                          >
                            {analyticsData[token.token_address]
                              ?.momentum_category || "N/A"}
                          </div>
                        </div>

                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Risk Score
                          </div>
                          <div
                            className={`text-lg font-semibold ${getRiskColor(analyticsData[token.token_address]?.risk_score)}`}
                          >
                            {analyticsData[token.token_address]?.risk_score
                              ? `${(analyticsData[token.token_address].risk_score! * 100).toFixed(0)}%`
                              : "N/A"}
                          </div>
                        </div>
                      </div>

                      {/* Momentum Signal Details */}
                      {analyticsData[token.token_address]?.momentum_signal && (
                        <div className="bg-gray-800 rounded-lg p-3">
                          <div className="text-xs text-gray-400 mb-1">
                            Signal
                          </div>
                          <div className="text-sm">
                            <span
                              className={`capitalize ${getMomentumSignalColor(analyticsData[token.token_address]?.momentum_signal?.type)}`}
                            >
                              {analyticsData[
                                token.token_address
                              ]?.momentum_signal?.type?.replace("_", " ")}
                            </span>
                            <div className="text-xs text-gray-400 mt-1">
                              Strength:{" "}
                              {(
                                analyticsData[token.token_address]
                                  ?.momentum_signal?.strength ?? 0 * 100
                              ).toFixed(0)}
                              %
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Additional Metrics */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {analyticsData[token.token_address]
                          ?.current_price_usd && (
                          <div className="bg-gray-800 rounded-lg p-3">
                            <div className="text-xs text-gray-400 mb-1">
                              Current Price
                            </div>
                            <div className="text-sm text-white">
                              $
                              {analyticsData[
                                token.token_address
                              ].current_price_usd!.toFixed(6)}
                            </div>
                          </div>
                        )}

                        {analyticsData[token.token_address]?.liquidity_score !==
                          undefined && (
                          <div className="bg-gray-800 rounded-lg p-3">
                            <div className="text-xs text-gray-400 mb-1">
                              Liquidity Score
                            </div>
                            <div className="text-sm text-white">
                              {(
                                analyticsData[token.token_address]!
                                  .liquidity_score! * 100
                              ).toFixed(0)}
                              %
                            </div>
                          </div>
                        )}

                        {analyticsData[token.token_address]?.volume_24h !==
                          undefined && (
                          <div className="bg-gray-800 rounded-lg p-3">
                            <div className="text-xs text-gray-400 mb-1">
                              24h Volume
                            </div>
                            <div className="text-sm text-white">
                              $
                              {analyticsData[
                                token.token_address
                              ]!.volume_24h!.toLocaleString()}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="text-xs text-gray-500 mt-2">
                        Analytics updated:{" "}
                        {formatDistanceToNow(
                          new Date(
                            analyticsData[token.token_address].last_updated_at,
                          ),
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
                        onClick={() =>
                          fetchAnalyticsForTokens([token.token_address])
                        }
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
        ))}

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
              onClick={() => fetchTokens(pagination.page - 1)}
              disabled={pagination.page <= 1 || loading}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed rounded text-sm transition-colors"
            >
              Previous
            </button>

            <span className="px-3 py-1 bg-blue-600 rounded text-sm">
              {pagination.page} of {pagination.totalPages}
            </span>

            <button
              onClick={() => fetchTokens(pagination.page + 1)}
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
