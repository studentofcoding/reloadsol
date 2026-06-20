"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { boardTabUrl } from "@/components/signals/shared/parseAddresses";
import UnifiedTokenModal from "@/components/UnifiedTokenModal";
import ChartBuyModal from "@/components/ChartBuyModal";
import DlmmChartActions from "@/components/dlmm/DlmmChartActions";
import TokenDetailsModal from "@/components/TokenDetailsModal";
import { useTrendingStats } from "@/hooks/useTrendingStats";
import { useTokenHistory } from "@/hooks/useTokenHistory";
import { formatAppDateTime, formatAppNow } from "@/utils/datetime";

// Use alternate tables in local development to avoid prod collisions
const TRACKER_TABLE =
  process.env.NODE_ENV === "development"
    ? "trending_token_tracker_dev"
    : "trending_token_tracker";

interface TopWinner {
  token_address: string;
  token_symbol: string | null;
  token_name: string | null;
  logo_url: string | null;
  initial_price_usd: number;
  peak_price_usd: number;
  peak_gain_percentage: number;
  tracking_duration_hours: number;
  status_changed_at: string;
  status?: "tracking" | "won" | "lost" | "manual_sell";
  current_gain_percentage?: number;
}

interface TrackedToken {
  id: string;
  token_address: string;
  token_symbol: string | null;
  token_name: string | null;
  logo_url: string | null;
  initial_price_usd: number;
  last_price_usd: number;
  peak_price_usd: number;
  current_gain_percentage: number;
  peak_gain_percentage: number;
  status: "tracking" | "won" | "lost" | "manual_sell";
  organic_score: number | null;
  market_cap: number | null;
  volume_1h: number | null;
  tracking_started_at: string;
  status_changed_at: string | null;
  created_at: string;
  updated_at: string;
  trade_comparison_data?: any | null;
  trading_simulation?: any | null;
  price_history?: any[] | null;
}

interface Summary {
  id: string;
  period_start: string;
  period_end: string;
  total_tokens_tracked: number;
  won_tokens: number;
  lost_tokens: number;
  still_tracking: number;
  win_rate: number;
  top_winners: TopWinner[];
  avg_peak_gain: number;
  max_peak_gain: number;
  avg_loss: number;
  created_at: string;
}

interface TrendingStats {
  success: boolean;
  timestamp: string;
  latest_summary: Summary | null;
  current_tracking: {
    tokens: TrackedToken[];
    statistics: {
      total_tracking: number;
      positive_performers: number;
      negative_performers: number;
      at_risk: number;
      top_performer: {
        token_symbol: string;
        token_name: string;
        current_gain_percentage: number;
        peak_gain_percentage: number;
      } | null;
    };
    averages: {
      current_gain: number;
      peak_gain: number;
    };
  };
  recent_completed: {
    winners: TrackedToken[];
    losers: TrackedToken[];
  };
  trends: {
    win_rate_change: number;
    historical_summaries: Summary[];
  };
  data_freshness: {
    tracking_tokens_count: number;
    latest_summary_age_hours: number | null;
    last_updated: string;
  };
  cached: boolean;
  cache_age: number;
  expires_in: number;
}

// Add new interfaces for trading configuration
interface TradingConfig {
  isSimulated: boolean;
  keypairPath: string;
  discordWebhook: string;
  notifyOnTrigger: boolean;
}

export default function AlgoDashboardTab() {
  const router = useRouter();
  const {
    data: stats,
    isLoading: loading,
    error: queryError,
    refetch,
  } = useTrendingStats();
  const error = queryError ? queryError.message : "";

  const [activeTab, setActiveTab] = useState<
    "overview" | "tracking" | "winners" | "losers"
  >("overview");

  // History state
  const [historyDate, setHistoryDate] = useState<string>(
    new Date().toISOString().split("T")[0],
  );
  const [historyPage, setHistoryPage] = useState<number>(1);
  const { data: historyData, isLoading: historyLoading } = useTokenHistory({
    page: historyPage,
    limit: 12,
    date: historyDate,
  });

  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [debugMode, setDebugMode] = useState(false);
  const [isRefreshingPrices, setIsRefreshingPrices] = useState(false);

  // Pagination and search state
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [itemsPerPage, setItemsPerPage] = useState<number>(12);

  // Selection state
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set());

  // New: tracking mode filter ('all' | 'real' | 'sim')
  const [trackingModeFilter, setTrackingModeFilter] = useState<
    "all" | "real" | "sim"
  >("all");

  // Advanced filter state
  const [sinceFilter, setSinceFilter] = useState<string>("all"); // 'all', '1', '4', '12', '24', '48' (hours)
  const [priceMin, setPriceMin] = useState<string>("");
  const [priceMax, setPriceMax] = useState<string>("");
  const [pctMin, setPctMin] = useState<string>("");
  const [pctMax, setPctMax] = useState<string>("");

  // Modal state
  const [unifiedModalState, setUnifiedModalState] = useState<{
    isOpen: boolean;
    modalType: "transaction" | "trading";
    tokenData?: {
      mint: string;
      symbol?: string | null;
      name?: string | null;
      logoUrl?: string | null;
    };
    transactionData?: {
      result: any;
      operation: "buy" | "sell" | "close";
    };
    allTokens?: any[]; // For navigation
  }>({ isOpen: false, modalType: "trading" });

  // Latest 24h Summary state
  const [showAllSummaryTokens, setShowAllSummaryTokens] = useState(false);

  // Trading config state
  const [tradingConfig, setTradingConfig] = useState<TradingConfig>({
    isSimulated: true,
    keypairPath: "",
    discordWebhook: "",
    notifyOnTrigger: true,
  });
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [chartModalTokenAddress, setChartModalTokenAddress] = useState<
    string | null
  >(null);
  const [selectedTokenForDetails, setSelectedTokenForDetails] = useState<
    any | null
  >(null);
  const [detailsSourceList, setDetailsSourceList] = useState<any[]>([]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      console.log("AlgoDashboardTab state", {
        loading,
        error,
        hasStats: Boolean(stats),
      });
    }
  }, [loading, error, stats]);

  // Handler for selecting/deselecting tokens
  const handleToggleSelection = (
    tokenAddress: string,
    event?: React.MouseEvent,
  ) => {
    if (event) {
      event.stopPropagation();
    }
    const newSelected = new Set(selectedTokens);
    if (newSelected.has(tokenAddress)) {
      newSelected.delete(tokenAddress);
    } else {
      newSelected.add(tokenAddress);
    }
    setSelectedTokens(newSelected);
  };

  // Handler to open charts for selected tokens
  const handleOpenSelectedCharts = () => {
    if (selectedTokens.size === 0) return;
    const addresses = Array.from(selectedTokens).join(",");
    router.push(boardTabUrl(addresses.split(",").filter(Boolean)));
  };

  // Helper functions for search and pagination
  const filterTokens = (
    tokens: TrackedToken[],
    query: string,
  ): TrackedToken[] => {
    if (!query.trim()) return tokens;

    const lowercaseQuery = query.toLowerCase();
    return tokens.filter(
      (token) =>
        token.token_symbol?.toLowerCase().includes(lowercaseQuery) ||
        token.token_name?.toLowerCase().includes(lowercaseQuery) ||
        token.token_address.toLowerCase().includes(lowercaseQuery),
    );
  };

  // Apply advanced filters
  const applyFilters = (tokens: TrackedToken[]): TrackedToken[] => {
    let result = filterTokens(tokens, searchQuery);

    // Since filter (hours)
    if (sinceFilter !== "all") {
      const hours = parseInt(sinceFilter);
      if (!isNaN(hours)) {
        const now = Date.now();
        result = result.filter((token) => {
          const ageHours =
            (now - new Date(token.tracking_started_at).getTime()) / 3600000;
          return ageHours <= hours;
        });
      }
    }

    // Price filters
    const minPrice = parseFloat(priceMin);
    const maxPrice = parseFloat(priceMax);
    if (!isNaN(minPrice)) {
      result = result.filter((token) => token.last_price_usd >= minPrice);
    }
    if (!isNaN(maxPrice)) {
      result = result.filter((token) => token.last_price_usd <= maxPrice);
    }

    // Percentage filters (current gain percentage)
    const minPct = parseFloat(pctMin);
    const maxPct = parseFloat(pctMax);
    if (!isNaN(minPct)) {
      result = result.filter(
        (token) => token.current_gain_percentage >= minPct,
      );
    }
    if (!isNaN(maxPct)) {
      result = result.filter(
        (token) => token.current_gain_percentage <= maxPct,
      );
    }

    return result;
  };

  const paginateTokens = (
    tokens: TrackedToken[],
    page: number,
    perPage: number,
  ): TrackedToken[] => {
    const startIndex = (page - 1) * perPage;
    const endIndex = startIndex + perPage;
    return tokens.slice(startIndex, endIndex);
  };

  const getTotalPages = (totalItems: number, perPage: number): number => {
    return Math.ceil(totalItems / perPage);
  };

  // Reset pagination when search changes
  const handleSearchChange = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(1);
  };

  // Clear search and reset pagination
  const clearSearch = () => {
    setSearchQuery("");
    setCurrentPage(1);
  };

  // Enhanced refresh function for manual button clicks
  const handleRefreshStats = async () => {
    // React Query refetch
    await refetch();
    setLastRefresh(new Date());
  };

  // Debug function to manually test tracking API (development mode only)
  const testTrackingAPI = async () => {
    console.log("🧪 Testing tracking API manually...");
    try {
      const response = await fetch("/api/trending/track", {
        method: "POST",
      });
      console.log("🔍 Tracking API response status:", response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error("❌ Tracking API Error:", errorText);
        return;
      }

      const data = await response.json();
      console.log("✅ Tracking API response:", data);

      // Refresh stats after manual tracking test
      setTimeout(() => {
        refetch(); // Force refresh after manual tracking
      }, 2000);
    } catch (err) {
      console.error("❌ Error testing tracking API:", err);
    }
  };

  // Debug function to manually test summary API (development mode only)
  const testSummaryAPI = async () => {
    try {
      console.log("🧪 Testing summary API...");
      const response = await fetch("/api/trending/summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const result = await response.json();
      console.log("📊 Summary API result:", result);

      if (response.ok) {
        alert(
          `✅ Summary API test successful!\n\nPeriod: ${result.period_start} to ${result.period_end}\nTokens tracked: ${result.total_tokens_tracked}\nWon: ${result.won_tokens}\nLost: ${result.lost_tokens}\nWin rate: ${result.win_rate.toFixed(1)}%`,
        );
      } else {
        alert(`❌ Summary API test failed: ${result.error || "Unknown error"}`);
      }
    } catch (error) {
      console.error("❌ Summary API test error:", error);
      alert(
        `❌ Summary API test error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

  // Handler to open trading modal
  const handleOpenTradingModal = (token: any) => {
    // Determine context: current tracking or recent completed
    let allTokens: any[] = [];
    if (stats?.current_tracking?.tokens) {
      allTokens = [...allTokens, ...stats.current_tracking.tokens];
    }
    if (stats?.recent_completed?.winners) {
      allTokens = [...allTokens, ...stats.recent_completed.winners];
    }
    if (stats?.recent_completed?.losers) {
      allTokens = [...allTokens, ...stats.recent_completed.losers];
    }

    setUnifiedModalState({
      isOpen: true,
      modalType: "trading",
      tokenData: {
        mint: token.token_address,
        symbol: token.token_symbol,
        name: token.token_name,
        logoUrl: token.logo_url,
      },
      // Pass list for navigation
      allTokens,
    });
  };

  // Handler to open transaction modal
  const handleOpenTransactionModal = (
    result: any,
    operation: "buy" | "sell" | "close",
  ) => {
    setUnifiedModalState({
      isOpen: true,
      modalType: "transaction",
      transactionData: { result, operation },
    });
  };

  // Handler to close modals
  const handleCloseModal = () => {
    setUnifiedModalState({ isOpen: false, modalType: "trading" });
  };

  // Handler for token clicks
  const handleTokenClick = (token: TrackedToken, sourceList?: any[]) => {
    setSelectedTokenForDetails(token);
    if (sourceList) setDetailsSourceList(sourceList);
  };

  // Handler for summary token clicks
  const handleSummaryTokenClick = (
    summaryToken: TopWinner,
    sourceList?: any[],
  ) => {
    setSelectedTokenForDetails(summaryToken);
    if (sourceList) setDetailsSourceList(sourceList);
  };

  // Auto-refresh handled by React Query
  // Price updates are separate

  // Function to save trading config to localStorage
  const saveTradingConfig = (config: TradingConfig) => {
    localStorage.setItem("tradingConfig", JSON.stringify(config));
    setTradingConfig(config);
  };

  // Load trading config from localStorage on mount
  useEffect(() => {
    const savedConfig = localStorage.getItem("tradingConfig");
    if (savedConfig) {
      try {
        const config = JSON.parse(savedConfig);
        setTradingConfig(config);
      } catch (error) {
        console.error("Failed to parse saved trading config:", error);
      }
    }
  }, []);

  // Function to send Discord notification
  const sendDiscordNotification = async (message: string) => {
    if (!tradingConfig.discordWebhook) return;

    try {
      await fetch(tradingConfig.discordWebhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: message,
          username: "Trading Bot",
          avatar_url: "https://i.imgur.com/4M34hi2.png",
        }),
      });
    } catch (error) {
      console.error("Failed to send Discord notification:", error);
    }
  };

  // Handler for trade triggers
  const handleTradeTriggered = async (type: string, details: any) => {
    if (tradingConfig.notifyOnTrigger && tradingConfig.discordWebhook) {
      const tokenSymbol = unifiedModalState.tokenData?.symbol || "Unknown";
      const message =
        `🔔 Trade Alert (${tradingConfig.isSimulated ? "Simulation" : "LIVE"})\n` +
        `${type} triggered for ${tokenSymbol}\n` +
        `Current Gain: ${details.currentGain}%\n` +
        `Peak Gain: ${details.peakGain}%\n` +
        `Price: ${details.price}\n` +
        `Provider: ${details.provider || "Unknown"}\n` +
        `RPC: ${details.rpc || "Default"}\n` +
        `Response Time: ${details.responseTime ? `${details.responseTime}ms` : "N/A"}\n` +
        `Time: ${formatAppNow()}`;
      await sendDiscordNotification(message);
    }
  };

  // Configuration Modal Component
  const ConfigModal = () => {
    const [tempConfig, setTempConfig] = useState(tradingConfig);

    return (
      <div
        className={`fixed inset-0 bg-black/50 flex items-center justify-center z-50 ${showConfigModal ? "" : "hidden"}`}
      >
        <div className="bg-gray-800 rounded-xl p-6 max-w-md w-full mx-4">
          <h3 className="text-xl font-semibold mb-4">Trading Configuration</h3>

          {/* Trading Mode Toggle */}
          <div className="mb-4">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm font-medium text-gray-300">
                Trading Mode
              </span>
              <div className="relative">
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={!tempConfig.isSimulated}
                  onChange={() =>
                    setTempConfig({
                      ...tempConfig,
                      isSimulated: !tempConfig.isSimulated,
                    })
                  }
                />
                <div
                  className={`block w-14 h-8 rounded-full transition-colors ${tempConfig.isSimulated ? "bg-gray-600" : "bg-green-600"}`}
                ></div>
                <div
                  className={`absolute left-1 top-1 bg-white w-6 h-6 rounded-full transition-transform transform ${tempConfig.isSimulated ? "" : "translate-x-6"}`}
                ></div>
              </div>
            </label>
            <p className="text-sm text-gray-400 mt-1">
              {tempConfig.isSimulated
                ? "🤖 Simulation Mode"
                : "🚀 Real Trading Mode"}
            </p>
          </div>

          {/* Keypair Path Input */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Keypair Path{" "}
              {!tempConfig.isSimulated && (
                <span className="text-red-400">*</span>
              )}
            </label>
            <input
              type="text"
              value={tempConfig.keypairPath}
              onChange={(e) =>
                setTempConfig({ ...tempConfig, keypairPath: e.target.value })
              }
              placeholder="/path/to/keypair.json"
              className="w-full px-3 py-2 bg-gray-700 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              required={!tempConfig.isSimulated}
            />
            <p className="text-xs text-gray-400 mt-1">
              Required for real trading mode
            </p>
          </div>

          {/* Discord Webhook Input */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-300 mb-1">
              Discord Webhook URL
            </label>
            <input
              type="text"
              value={tempConfig.discordWebhook}
              onChange={(e) =>
                setTempConfig({ ...tempConfig, discordWebhook: e.target.value })
              }
              placeholder="https://discord.com/api/webhooks/..."
              className="w-full px-3 py-2 bg-gray-700 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Notification Toggle */}
          <div className="mb-6">
            <label className="flex items-center space-x-3 cursor-pointer">
              <input
                type="checkbox"
                checked={tempConfig.notifyOnTrigger}
                onChange={() =>
                  setTempConfig({
                    ...tempConfig,
                    notifyOnTrigger: !tempConfig.notifyOnTrigger,
                  })
                }
                className="form-checkbox h-5 w-5 text-blue-600 rounded bg-gray-700 border-gray-500"
              />
              <span className="text-sm font-medium text-gray-300">
                Send Discord notifications on trade triggers
              </span>
            </label>
          </div>

          {/* Action Buttons */}
          <div className="flex space-x-3">
            <button
              onClick={() => {
                if (!tempConfig.isSimulated && !tempConfig.keypairPath) {
                  alert("Keypair path is required for real trading mode");
                  return;
                }
                saveTradingConfig(tempConfig);
                setShowConfigModal(false);
              }}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors"
            >
              Save Changes
            </button>
            <button
              onClick={() => setShowConfigModal(false)}
              className="flex-1 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Calculate total and average PnL percentage from all tokens in summary
  const calculatePnL = (
    summary: Summary | null,
  ): { totalPnL: number; averagePnL: number } => {
    if (!summary) {
      return { totalPnL: 0, averagePnL: 0 };
    }

    let totalPnL = 0;
    let totalTokens = 0;

    // Process all tokens in top_winners array
    if (summary.top_winners && summary.top_winners.length > 0) {
      summary.top_winners.forEach((winner) => {
        // Use current_gain_percentage if available, otherwise use peak_gain_percentage
        const gainPercentage =
          typeof winner.current_gain_percentage !== "undefined"
            ? winner.current_gain_percentage
            : winner.peak_gain_percentage;

        totalPnL += gainPercentage;
        totalTokens++;
      });
    }

    // Add remaining lost tokens that aren't in top_winners
    // Only count lost tokens that aren't already counted in top_winners
    const lostTokensNotInTopWinners =
      summary.lost_tokens -
      (summary.top_winners?.filter(
        (w) =>
          w.current_gain_percentage !== undefined &&
          w.current_gain_percentage < -50,
      ).length || 0);

    if (lostTokensNotInTopWinners > 0 && summary.avg_loss) {
      totalPnL += summary.avg_loss * lostTokensNotInTopWinners;
      totalTokens += lostTokensNotInTopWinners;
    }

    return {
      totalPnL,
      averagePnL: totalTokens > 0 ? totalPnL / totalTokens : 0,
    };
  };

  const formatTime = (dateString: string) => formatAppDateTime(dateString);

  const formatRelativeTime = (dateString: string) => {
    const now = Date.now();
    const then = new Date(dateString).getTime();
    const diff = now - then;
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor(diff / (1000 * 60));

    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return "Just now";
  };

  const formatPercentage = (percentage: number, showSign: boolean = true) => {
    const color =
      percentage > 0
        ? "text-green-400"
        : percentage < 0
          ? "text-red-400"
          : "text-gray-400";
    const sign = showSign && percentage > 0 ? "+" : "";
    return (
      <span className={color}>
        {sign}
        {percentage.toFixed(2)}%
      </span>
    );
  };

  const formatPrice = (price: number) => {
    if (price >= 1) return `$${price.toFixed(4)}`;
    if (price >= 0.001) return `$${price.toFixed(6)}`;
    return `$${price.toExponential(2)}`;
  };

  const TokenIcon = ({ token }: { token: TrackedToken | TopWinner }) => (
    <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center overflow-hidden">
      {token.logo_url ? (
        <img
          src={token.logo_url}
          alt={token.token_symbol || "Token"}
          className="w-full h-full object-cover"
          onError={(e) => {
            e.currentTarget.onerror = null;
            e.currentTarget.src = "";
            const parent = e.currentTarget.parentElement as HTMLElement | null;
            if (parent) {
              parent.textContent = (token.token_symbol || "?")
                .charAt(0)
                .toUpperCase();
            }
          }}
        />
      ) : (
        <span className="text-white text-sm font-bold">
          {(token.token_symbol || "?").charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );

  const getTokenMode = (token: TrackedToken): "real" | "sim" => {
    if (token.trading_simulation && !token.trading_simulation.is_simulated)
      return "real";
    return "sim";
  };

  if (loading) {
    return (
      <div className="text-white p-4">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold mb-8">reloadSOL Algo tester</h1>
          <div className="flex items-center justify-center h-64">
            <div className="w-8 h-8 border-2 border-blue-400 border-t-blue-200 rounded-full animate-spin"></div>
            <span className="ml-3 text-gray-400">Loading tracking data...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-white p-4">
        <div className="max-w-7xl mx-auto">
          <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-6 text-center">
            <p className="text-red-400 text-lg mb-4">Error loading data</p>
            <p className="text-red-300 text-sm mb-4">{error}</p>
            <button
              onClick={() => refetch()}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="text-white p-4">
        <div className="max-w-7xl mx-auto">
          <p className="text-gray-400">No data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="text-white p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">reloadSOL Algo tester</h1>
          <button
            onClick={() => setShowConfigModal(true)}
            className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg font-medium flex items-center space-x-2"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            <span>Trading Config</span>
            {!tradingConfig.isSimulated && (
              <span className="ml-2 px-2 py-0.5 bg-green-600 rounded-full text-xs font-bold">
                LIVE
              </span>
            )}
          </button>
        </div>

        {/* Trading Mode Banner */}
        <div
          className={`mb-6 p-4 rounded-xl ${tradingConfig.isSimulated ? "bg-blue-900/20 border border-blue-600/30" : "bg-green-900/20 border border-green-600/30"}`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className="text-2xl">
                {tradingConfig.isSimulated ? "🤖" : "🚀"}
              </span>
              <div>
                <h3 className="font-semibold">
                  {tradingConfig.isSimulated
                    ? "Simulation Mode"
                    : "Real Trading Mode"}
                </h3>
                <p className="text-sm text-gray-400">
                  {tradingConfig.isSimulated
                    ? "Testing trading strategies without real transactions"
                    : "Live trading with real transactions"}
                </p>
              </div>
            </div>
            {tradingConfig.notifyOnTrigger && tradingConfig.discordWebhook && (
              <div className="flex items-center space-x-2 text-sm text-gray-400">
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 71 55"
                  fill="currentColor"
                >
                  <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1066 30.1693C30.1066 34.1136 27.28 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.9 23.0133 53.7545 26.2532 53.6986 30.1693C53.6986 34.1136 50.9 37.3253 47.3178 37.3253Z" />
                </svg>
                <span>Discord notifications enabled</span>
              </div>
            )}
          </div>
        </div>

        {/* Header */}
        <div className="flex flex-col space-y-4 md:flex-row md:items-center md:justify-between md:space-y-0 mb-8">
          <div>
            <p className="text-gray-400 mt-2">
              Live tracking of trending tokens with real-time price updates from
              Jupiter API
            </p>
          </div>
          <div className="flex items-center space-x-3">
            <span className="text-gray-400 text-sm" suppressHydrationWarning>
              Last updated: {formatRelativeTime(lastRefresh.toISOString())}
            </span>
            {isRefreshingPrices && (
              <span className="text-blue-400 text-sm">
                💰 Updating prices...
              </span>
            )}
            <button
              onClick={handleRefreshStats}
              disabled={loading || isRefreshingPrices}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed rounded-lg font-medium"
            >
              {loading || isRefreshingPrices ? "Refreshing..." : "Refresh Data"}
            </button>
          </div>
        </div>

        {/* Debug Controls (Development Only) */}
        {debugMode && (
          <div className="bg-gray-800 rounded-xl p-4 mb-6">
            <h3 className="text-lg font-semibold mb-3">🧪 Debug Controls</h3>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={testTrackingAPI}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm"
              >
                Test Tracking API
              </button>
              <button
                onClick={testSummaryAPI}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm"
              >
                Test Summary API
              </button>
              <button
                onClick={() => setDebugMode(!debugMode)}
                className="px-4 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg text-sm"
              >
                Hide Debug
              </button>
            </div>
          </div>
        )}

        {!debugMode && (
          <div className="mb-6">
            <button
              onClick={() => setDebugMode(true)}
              className="px-3 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm"
            >
              🐛 Show Debug
            </button>
          </div>
        )}

        {/* Stats Overview */}
        <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-6 mb-8">
          {/* Win Rate */}
          <div className="bg-gray-800 rounded-xl p-3 md:p-6">
            <h3 className="text-sm md:text-lg font-semibold mb-2">Win Rate</h3>
            <p className="text-xl md:text-3xl font-bold text-green-400">
              {stats.latest_summary?.win_rate?.toFixed(1) || "0.0"}%
            </p>
            {stats.trends.win_rate_change !== 0 && (
              <p className="text-xs md:text-sm mt-1">
                {formatPercentage(stats.trends.win_rate_change)} vs yesterday
              </p>
            )}
          </div>

          {/* Currently Tracking */}
          <div className="bg-gray-800 rounded-xl p-3 md:p-6">
            <h3 className="text-sm md:text-lg font-semibold mb-2">Tracking</h3>
            <p className="text-xl md:text-3xl font-bold text-blue-400">
              {stats.current_tracking.statistics.total_tracking}
            </p>
            <p className="text-xs md:text-sm text-gray-400 mt-1">
              {stats.current_tracking.statistics.positive_performers} gaining
              <span className="hidden md:inline">
                {" "}
                • {stats.current_tracking.statistics.at_risk} at risk
              </span>
            </p>
          </div>

          {/* Best Performer */}
          <div className="bg-gray-800 rounded-xl p-3 md:p-6">
            <h3 className="text-sm md:text-lg font-semibold mb-2">
              Top Performer
            </h3>
            {stats.current_tracking.statistics.top_performer ? (
              <>
                <p className="text-sm md:text-lg font-bold text-white truncate">
                  {stats.current_tracking.statistics.top_performer.token_symbol}
                </p>
                <p className="text-xs md:text-sm">
                  {formatPercentage(
                    stats.current_tracking.statistics.top_performer
                      .peak_gain_percentage,
                  )}
                </p>
              </>
            ) : (
              <p className="text-xs md:text-sm text-gray-400">
                No active tokens
              </p>
            )}
          </div>

          {/* Latest Summary Age */}
          <div className="bg-gray-800 rounded-xl p-3 md:p-6">
            <h3 className="text-sm md:text-lg font-semibold mb-2">
              Last Summary
            </h3>
            <p className="text-sm md:text-lg font-bold text-white">
              {stats.data_freshness.latest_summary_age_hours !== null
                ? `${stats.data_freshness.latest_summary_age_hours.toFixed(1)}h ago`
                : "Never"}
            </p>
            {stats.latest_summary && (
              <p className="text-xs md:text-sm text-gray-400 mt-1">
                {stats.latest_summary.won_tokens} wins
                <span className="hidden md:inline">
                  {" "}
                  • {stats.latest_summary.lost_tokens} losses
                </span>
              </p>
            )}
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex space-x-1 mb-6 bg-gray-800 rounded-lg p-1 overflow-x-auto">
          {[
            {
              key: "overview",
              label: "Overview",
              icon: (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                  />
                </svg>
              ),
            },
            {
              key: "tracking",
              label: `Tracking (${stats.current_tracking.statistics.total_tracking})`,
              icon: (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                  />
                </svg>
              ),
            },
            {
              key: "winners",
              label: `Winners (${stats.recent_completed.winners.length})`,
              icon: (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"
                  />
                </svg>
              ),
            },
            {
              key: "losers",
              label: `Losers (${stats.recent_completed.losers.length})`,
              icon: (
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17.294 15m-3.294-5a2 2 0 012-2h5.5a2 2 0 012 2v6a2 2 0 01-2 2h-5.5a2 2 0 01-2-2v-6z"
                  />
                </svg>
              ),
            },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as any)}
              className={`flex items-center justify-center space-x-2 px-4 py-2 text-sm font-medium rounded-md transition-all min-w-max ${
                activeTab === tab.key
                  ? "bg-gray-700 text-white"
                  : "text-gray-400 hover:text-white hover:bg-gray-700/50"
              }`}
              title={tab.label}
            >
              {tab.icon}
              <span className="hidden md:inline">{tab.label}</span>
              {/* Show count badge on mobile */}
              <span className="md:hidden">
                {tab.key === "tracking" &&
                  stats.current_tracking.statistics.total_tracking > 0 && (
                    <span className="ml-1 bg-blue-600 text-xs px-1.5 py-0.5 rounded-full">
                      {stats.current_tracking.statistics.total_tracking}
                    </span>
                  )}
                {tab.key === "winners" &&
                  stats.recent_completed.winners.length > 0 && (
                    <span className="ml-1 bg-green-600 text-xs px-1.5 py-0.5 rounded-full">
                      {stats.recent_completed.winners.length}
                    </span>
                  )}
                {tab.key === "losers" &&
                  stats.recent_completed.losers.length > 0 && (
                    <span className="ml-1 bg-red-600 text-xs px-1.5 py-0.5 rounded-full">
                      {stats.recent_completed.losers.length}
                    </span>
                  )}
              </span>
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* Daily History */}
            <div className="bg-gray-800 rounded-xl p-6">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-semibold">Daily Token History</h3>
                <div className="flex items-center space-x-4">
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => {
                        const date = new Date(historyDate);
                        date.setDate(date.getDate() - 1);
                        setHistoryDate(date.toISOString().split("T")[0]);
                        setHistoryPage(1);
                      }}
                      className="p-1 hover:bg-gray-700 rounded transition-colors"
                      title="Previous Day"
                    >
                      <svg
                        className="w-5 h-5 text-gray-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M15 19l-7-7 7-7"
                        />
                      </svg>
                    </button>
                    <input
                      type="date"
                      value={historyDate}
                      onChange={(e) => {
                        setHistoryDate(e.target.value);
                        setHistoryPage(1);
                      }}
                      className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                      onClick={() => {
                        const date = new Date(historyDate);
                        date.setDate(date.getDate() + 1);
                        const today = new Date().toISOString().split("T")[0];
                        const newDate = date.toISOString().split("T")[0];
                        if (newDate <= today) {
                          setHistoryDate(newDate);
                          setHistoryPage(1);
                        }
                      }}
                      disabled={
                        historyDate >= new Date().toISOString().split("T")[0]
                      }
                      className="p-1 hover:bg-gray-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Next Day"
                    >
                      <svg
                        className="w-5 h-5 text-gray-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M9 5l7 7-7 7"
                        />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              {historyLoading ? (
                <div className="flex justify-center py-8">
                  <div className="w-8 h-8 border-2 border-blue-400 border-t-blue-200 rounded-full animate-spin"></div>
                </div>
              ) : !historyData?.tokens || historyData.tokens.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  No tokens found for {historyDate}
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                    {historyData.tokens.map((token: any) => {
                      const isWinner = token.peak_gain_percentage > 0;
                      const currentGain =
                        token.current_gain_percentage ??
                        token.peak_gain_percentage;
                      const isLoser =
                        currentGain < -50 ||
                        (token.status && token.status === "lost");

                      return (
                        <div
                          key={token.id}
                          className="bg-gray-700 rounded-lg p-4 hover:bg-gray-600 transition-colors cursor-pointer"
                          onClick={() =>
                            handleTokenClick(token, historyData.tokens)
                          }
                        >
                          <div className="flex items-start justify-between mb-3">
                            <div className="flex items-center space-x-3">
                              <TokenIcon token={token} />
                              <div>
                                <h4 className="font-semibold">
                                  {token.token_symbol}
                                </h4>
                                <p className="text-xs text-gray-400">
                                  {token.token_name}
                                </p>
                              </div>
                            </div>
                            <div className="text-right">
                              <p
                                className={`font-bold ${
                                  currentGain > 0
                                    ? "text-green-400"
                                    : currentGain < 0
                                      ? "text-red-400"
                                      : "text-gray-400"
                                }`}
                              >
                                {currentGain > 0 ? "+" : ""}
                                {currentGain.toFixed(2)}%
                              </p>
                              <p className="text-xs text-gray-400">
                                {formatTime(token.created_at).split(",")[1]}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center justify-between text-xs text-gray-400 border-t border-gray-600 pt-3">
                            <div>
                              <span className="block mb-0.5">Peak Gain</span>
                              <span className="text-white font-medium">
                                {token.peak_gain_percentage.toFixed(2)}%
                              </span>
                            </div>
                            <div className="text-right">
                              <span className="block mb-0.5">Status</span>
                              <span
                                className={`font-medium ${
                                  token.status === "won"
                                    ? "text-green-400"
                                    : token.status === "lost"
                                      ? "text-red-400"
                                      : token.status === "manual_sell"
                                        ? "text-orange-400"
                                        : "text-blue-400"
                                }`}
                              >
                                {token.status.charAt(0).toUpperCase() +
                                  token.status.slice(1)}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* History Pagination */}
                  {historyData.pagination.totalPages > 1 && (
                    <div className="flex justify-center items-center space-x-2">
                      <button
                        onClick={() =>
                          setHistoryPage(Math.max(1, historyPage - 1))
                        }
                        disabled={historyPage === 1}
                        className="p-2 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 19l-7-7 7-7"
                          />
                        </svg>
                      </button>
                      <span className="text-sm text-gray-400">
                        Page {historyPage} of{" "}
                        {historyData.pagination.totalPages}
                      </span>
                      <button
                        onClick={() =>
                          setHistoryPage(
                            Math.min(
                              historyData.pagination.totalPages,
                              historyPage + 1,
                            ),
                          )
                        }
                        disabled={
                          historyPage === historyData.pagination.totalPages
                        }
                        className="p-2 rounded hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M9 5l7 7-7 7"
                          />
                        </svg>
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Latest Summary */}
            {stats.latest_summary && (
              <div className="bg-gray-800 rounded-xl p-6">
                <h3 className="text-xl font-semibold mb-4">
                  Latest 24h Summary
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                  <div>
                    <p className="text-sm text-gray-400">Period</p>
                    <p className="text-white">
                      {formatTime(stats.latest_summary.period_start)} -{" "}
                      {formatTime(stats.latest_summary.period_end)}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-400">Total Tracked</p>
                    <p className="text-white font-semibold">
                      {stats.latest_summary.total_tokens_tracked}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-gray-400">Win Rate</p>
                    <p className="text-green-400 font-semibold">
                      {stats.latest_summary.win_rate}%
                    </p>
                  </div>
                  <div>
                    <div className="space-y-2">
                      <div>
                        <p className="text-sm text-gray-400">Total PnL</p>
                        <p
                          className={`font-semibold ${calculatePnL(stats.latest_summary).totalPnL >= 0 ? "text-green-400" : "text-red-400"}`}
                        >
                          {formatPercentage(
                            calculatePnL(stats.latest_summary).totalPnL,
                          )}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-gray-400">Average PnL</p>
                        <p
                          className={`font-semibold ${calculatePnL(stats.latest_summary).averagePnL >= 0 ? "text-green-400" : "text-red-400"}`}
                        >
                          {formatPercentage(
                            calculatePnL(stats.latest_summary).averagePnL,
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* All Tracked Tokens from Summary */}
                {stats.latest_summary.top_winners &&
                  stats.latest_summary.top_winners.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-lg font-semibold">
                          📊 Tracked Tokens
                        </h4>
                        <button
                          onClick={() =>
                            setShowAllSummaryTokens(!showAllSummaryTokens)
                          }
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors"
                        >
                          {showAllSummaryTokens
                            ? "Show Top 5"
                            : `Show All (${stats?.latest_summary?.top_winners?.length || 0})`}
                        </button>
                      </div>
                      <div className="space-y-2">
                        {(showAllSummaryTokens
                          ? stats?.latest_summary?.top_winners || []
                          : (stats?.latest_summary?.top_winners || [])
                              .filter((w: any) => w.peak_gain_percentage > 0)
                              .slice(0, 5)
                        ).map((token: any, index: number, arr: any[]) => {
                          const isWinner = token.peak_gain_percentage > 0;
                          const currentGain =
                            token.current_gain_percentage ??
                            token.peak_gain_percentage;
                          const isLoser =
                            currentGain < -50 ||
                            (token.status && token.status === "lost");
                          const isManualSell = token.status === "manual_sell";
                          const displayGain = isLoser
                            ? currentGain
                            : token.peak_gain_percentage;

                          return (
                            <div
                              key={token.token_address}
                              className={`flex items-center justify-between p-3 rounded-lg hover:bg-gray-600 transition-all duration-200 cursor-pointer ${
                                isWinner
                                  ? "bg-gray-700 border border-green-600/20"
                                  : isLoser
                                    ? "bg-gray-700 border border-red-600/20"
                                    : isManualSell
                                      ? "bg-gray-700 border border-orange-600/20"
                                      : "bg-gray-700"
                              }`}
                              onClick={() =>
                                handleSummaryTokenClick(token, arr)
                              }
                            >
                              <div className="flex items-center space-x-3">
                                <span className="text-yellow-400 font-bold">
                                  #{index + 1}
                                </span>
                                <div className="relative">
                                  <TokenIcon token={token} />
                                  {isWinner && (
                                    <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-600 rounded-full flex items-center justify-center">
                                      <svg
                                        className="w-2 h-2 text-white"
                                        fill="currentColor"
                                        viewBox="0 0 20 20"
                                      >
                                        <path
                                          fillRule="evenodd"
                                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                          clipRule="evenodd"
                                        />
                                      </svg>
                                    </div>
                                  )}
                                  {isLoser && (
                                    <div className="absolute -top-1 -right-1 w-4 h-4 bg-red-600 rounded-full flex items-center justify-center">
                                      <svg
                                        className="w-2 h-2 text-white"
                                        fill="currentColor"
                                        viewBox="0 0 20 20"
                                      >
                                        <path
                                          fillRule="evenodd"
                                          d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                                          clipRule="evenodd"
                                        />
                                      </svg>
                                    </div>
                                  )}
                                  {isManualSell && (
                                    <div
                                      className="absolute -top-1 -right-1 w-4 h-4 bg-orange-600 rounded-full flex items-center justify-center"
                                      title="Manual sell detected - bot stopped"
                                    >
                                      <span className="text-white text-xs">
                                        👤
                                      </span>
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <p className="font-semibold">
                                    {token.token_symbol || "Unknown"}
                                  </p>
                                  <p className="text-sm text-gray-400">
                                    {token.token_name}
                                  </p>
                                </div>
                              </div>
                              <div className="text-right">
                                <p
                                  className={`font-semibold ${
                                    displayGain > 0
                                      ? "text-green-400"
                                      : displayGain < 0
                                        ? "text-red-400"
                                        : "text-gray-400"
                                  }`}
                                >
                                  {displayGain > 0 ? "+" : ""}
                                  {displayGain.toFixed(2)}%
                                </p>
                                <p className="text-sm text-gray-400">
                                  {token.tracking_duration_hours.toFixed(1)}h
                                  tracked
                                </p>
                                <p className="text-xs text-blue-400">
                                  Click to view trades
                                </p>
                                <div className="text-[10px] text-gray-500 mt-1">
                                  <div>
                                    Bought:{" "}
                                    {formatRelativeTime(
                                      token.tracking_started_at,
                                    )}
                                  </div>
                                  {token.status !== "tracking" &&
                                    token.status_changed_at && (
                                      <div>
                                        Sold:{" "}
                                        {formatRelativeTime(
                                          token.status_changed_at,
                                        )}
                                      </div>
                                    )}
                                </div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenTradingModal(token);
                                  }}
                                  className="mt-2 px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors flex items-center justify-center gap-1 ml-auto"
                                  title="Open Chart & Buy"
                                >
                                  <span>🛒</span> Buy
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
              </div>
            )}

            {/* Current Averages */}
            <div className="bg-gray-800 rounded-xl p-6">
              <h3 className="text-xl font-semibold mb-4">
                Current Performance
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="text-sm text-gray-400 mb-1">
                    Average Current Gain
                  </p>
                  <p className="text-2xl font-bold">
                    {formatPercentage(
                      stats.current_tracking.averages.current_gain,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-400 mb-1">
                    Average Peak Gain
                  </p>
                  <p className="text-2xl font-bold">
                    {formatPercentage(
                      stats.current_tracking.averages.peak_gain,
                    )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "tracking" && (
          <div className="bg-gray-800 rounded-xl p-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-6">
              <h3 className="text-xl font-semibold mb-4 md:mb-0">
                Currently Tracking ({stats.current_tracking.tokens.length})
              </h3>

              {/* Search and Controls */}
              <div className="flex flex-col sm:flex-row items-start sm:items-center space-y-3 sm:space-y-0 sm:space-x-4">
                {/* Search Input */}
                <div className="relative w-full sm:w-auto">
                  <input
                    type="text"
                    placeholder="Search by symbol, name, or address..."
                    value={searchQuery}
                    onChange={(e) => handleSearchChange(e.target.value)}
                    className="w-full sm:w-64 px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  {searchQuery && (
                    <button
                      onClick={clearSearch}
                      className="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white"
                    >
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Items per page selector */}
                <select
                  value={itemsPerPage}
                  onChange={(e) => {
                    setItemsPerPage(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value={6}>6 per page</option>
                  <option value={12}>12 per page</option>
                  <option value={24}>24 per page</option>
                  <option value={48}>48 per page</option>
                </select>

                {/* Since filter */}
                <select
                  value={sinceFilter}
                  onChange={(e) => {
                    setSinceFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All time</option>
                  <option value="1">&lt; 1h</option>
                  <option value="4">&lt; 4h</option>
                  <option value="12">&lt; 12h</option>
                  <option value="24">&lt; 24h</option>
                  <option value="48">&lt; 48h</option>
                </select>

                {/* Price filter */}
                <div className="flex items-center space-x-1">
                  <input
                    type="number"
                    step="0.0001"
                    placeholder="Price min"
                    value={priceMin}
                    onChange={(e) => {
                      setPriceMin(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="w-24 px-2 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-gray-400">-</span>
                  <input
                    type="number"
                    step="0.0001"
                    placeholder="max"
                    value={priceMax}
                    onChange={(e) => {
                      setPriceMax(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="w-24 px-2 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                {/* Percentage filter */}
                <div className="flex items-center space-x-1">
                  <input
                    type="number"
                    step="0.01"
                    placeholder="% min"
                    value={pctMin}
                    onChange={(e) => {
                      setPctMin(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="w-24 px-2 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <span className="text-gray-400">-</span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="max"
                    value={pctMax}
                    onChange={(e) => {
                      setPctMax(e.target.value);
                      setCurrentPage(1);
                    }}
                    className="w-24 px-2 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
            </div>

            {(() => {
              const filteredTokens = applyFilters(
                stats.current_tracking.tokens,
              );

              // Apply tracking mode filter (real vs simulation)
              const modeFilteredTokens = filteredTokens.filter((token) => {
                if (trackingModeFilter === "all") return true;
                const mode = getTokenMode(token);
                return trackingModeFilter === mode;
              });

              // Counts for tab labels
              const realCount = stats.current_tracking.tokens.filter(
                (t) => getTokenMode(t) === "real",
              ).length;
              const simCount = stats.current_tracking.tokens.filter(
                (t) => getTokenMode(t) === "sim",
              ).length;

              const totalPages = getTotalPages(
                filteredTokens.length,
                itemsPerPage,
              );
              const paginatedTokens = paginateTokens(
                modeFilteredTokens,
                currentPage,
                itemsPerPage,
              );

              if (stats.current_tracking.tokens.length === 0) {
                return (
                  <p className="text-gray-400 text-center py-8">
                    No tokens currently being tracked
                  </p>
                );
              }

              if (modeFilteredTokens.length === 0) {
                return (
                  <div className="text-center py-8">
                    <p className="text-gray-400 mb-2">
                      No tokens found matching "{searchQuery}"
                    </p>
                    <button
                      onClick={clearSearch}
                      className="text-blue-400 hover:text-blue-300 text-sm"
                    >
                      Clear search
                    </button>
                  </div>
                );
              }

              return (
                <>
                  {/* Mode Filter Tabs and Actions */}
                  <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-4">
                    <div className="flex space-x-1">
                      {[
                        {
                          key: "all",
                          label: `All (${stats.current_tracking.statistics.total_tracking})`,
                        },
                        { key: "real", label: `Real (${realCount})` },
                        { key: "sim", label: `Simulation (${simCount})` },
                      ].map((tab) => (
                        <button
                          key={tab.key}
                          onClick={() => {
                            setTrackingModeFilter(tab.key as any);
                            setCurrentPage(1);
                          }}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all min-w-max ${
                            trackingModeFilter === tab.key
                              ? "bg-blue-600 text-white"
                              : "text-gray-400 hover:text-white hover:bg-gray-700/50"
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    {selectedTokens.size > 0 && (
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => setSelectedTokens(new Set())}
                          className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-300 font-medium transition-colors text-sm"
                        >
                          Clear ({selectedTokens.size})
                        </button>
                        <button
                          onClick={handleOpenSelectedCharts}
                          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-white font-medium flex items-center space-x-2 transition-colors shadow-lg animate-pulse"
                        >
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                            />
                          </svg>
                          <span>Open Charts</span>
                        </button>
                      </div>
                    )}
                  </div>
                  {/* Results summary */}
                  <div className="flex justify-between items-center mb-4 text-sm text-gray-400">
                    <span>
                      Showing {paginatedTokens.length} of{" "}
                      {modeFilteredTokens.length} tokens
                      {searchQuery && ` matching "${searchQuery}"`}
                    </span>
                    {totalPages > 1 && (
                      <span>
                        Page {currentPage} of {totalPages}
                      </span>
                    )}
                  </div>

                  {/* Token Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                    {paginatedTokens.map((token) => (
                      <div
                        key={token.id}
                        className={`p-4 bg-gray-800 rounded-xl border transition-all duration-200 cursor-pointer ${
                          selectedTokens.has(token.token_address)
                            ? "border-purple-500 ring-1 ring-purple-500"
                            : "border-gray-700 hover:border-gray-500"
                        }`}
                        onClick={() => handleTokenClick(token)}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center space-x-3">
                            {/* Selection Checkbox */}
                            <div
                              onClick={(e) =>
                                handleToggleSelection(token.token_address, e)
                              }
                              className={`w-5 h-5 rounded border flex items-center justify-center transition-colors flex-shrink-0 ${
                                selectedTokens.has(token.token_address)
                                  ? "bg-purple-600 border-purple-600"
                                  : "border-gray-500 hover:border-gray-300"
                              }`}
                            >
                              {selectedTokens.has(token.token_address) && (
                                <svg
                                  className="w-3.5 h-3.5 text-white"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={3}
                                    d="M5 13l4 4L19 7"
                                  />
                                </svg>
                              )}
                            </div>

                            <TokenIcon token={token} />
                            <div>
                              <div className="font-semibold text-white">
                                {token.token_symbol || "Unknown"}
                              </div>
                              <div className="text-xs text-gray-400 truncate max-w-32">
                                {token.token_name}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-white font-medium">
                              {formatPrice(token.last_price_usd)}
                            </div>
                            <div
                              className={`text-xs ${token.current_gain_percentage >= 0 ? "text-green-400" : "text-red-400"}`}
                            >
                              {formatPercentage(
                                token.current_gain_percentage,
                                true,
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex justify-between text-xs mt-2">
                          <div>
                            <span className="text-gray-400">Peak: </span>
                            <span
                              className={
                                token.peak_gain_percentage >= 0
                                  ? "text-green-400"
                                  : "text-red-400"
                              }
                            >
                              {formatPercentage(
                                token.peak_gain_percentage,
                                true,
                              )}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">Since: </span>
                            <span className="text-white">
                              {formatRelativeTime(token.tracking_started_at)}
                            </span>
                          </div>
                        </div>
                        {/* Trade comparison indicator */}
                        {token.trade_comparison_data &&
                          !token.trading_simulation && (
                            <div className="mt-2 text-xs text-blue-400">
                              📊 Trade data available
                            </div>
                          )}
                        {/* Trading simulation indicator */}
                        {token.trading_simulation && (
                          <div className="mt-2 text-xs text-green-400">
                            🤖 Simulation data available
                          </div>
                        )}

                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenTradingModal(token);
                          }}
                          className="mt-3 w-full py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors flex items-center justify-center gap-1"
                        >
                          <span>📈</span> Chart & Buy
                        </button>
                        <div
                          className="mt-2 flex justify-end"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <DlmmChartActions
                            tokenAddress={token.token_address}
                            tokenSymbol={token.token_symbol}
                            source="algo-dashboard"
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Pagination Controls */}
                  {totalPages > 1 && (
                    <div className="flex flex-col sm:flex-row items-center justify-between space-y-4 sm:space-y-0">
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => setCurrentPage(1)}
                          disabled={currentPage === 1}
                          className="px-3 py-2 text-sm bg-gray-700 border border-gray-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600"
                        >
                          First
                        </button>
                        <button
                          onClick={() =>
                            setCurrentPage(Math.max(1, currentPage - 1))
                          }
                          disabled={currentPage === 1}
                          className="px-3 py-2 text-sm bg-gray-700 border border-gray-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600"
                        >
                          Previous
                        </button>
                      </div>

                      <div className="flex items-center space-x-1">
                        {(() => {
                          const pageNumbers = [];
                          const showPages = 5;
                          let startPage = Math.max(
                            1,
                            currentPage - Math.floor(showPages / 2),
                          );
                          let endPage = Math.min(
                            totalPages,
                            startPage + showPages - 1,
                          );

                          if (endPage - startPage + 1 < showPages) {
                            startPage = Math.max(1, endPage - showPages + 1);
                          }

                          for (let i = startPage; i <= endPage; i++) {
                            pageNumbers.push(i);
                          }

                          return pageNumbers.map((pageNum) => (
                            <button
                              key={pageNum}
                              onClick={() => setCurrentPage(pageNum)}
                              className={`px-3 py-2 text-sm border rounded-lg ${
                                currentPage === pageNum
                                  ? "bg-blue-600 border-blue-600 text-white"
                                  : "bg-gray-700 border-gray-600 text-gray-300 hover:bg-gray-600"
                              }`}
                            >
                              {pageNum}
                            </button>
                          ));
                        })()}
                      </div>

                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() =>
                            setCurrentPage(
                              Math.min(totalPages, currentPage + 1),
                            )
                          }
                          disabled={currentPage === totalPages}
                          className="px-3 py-2 text-sm bg-gray-700 border border-gray-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600"
                        >
                          Next
                        </button>
                        <button
                          onClick={() => setCurrentPage(totalPages)}
                          disabled={currentPage === totalPages}
                          className="px-3 py-2 text-sm bg-gray-700 border border-gray-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600"
                        >
                          Last
                        </button>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {activeTab === "winners" && (
          <div className="bg-gray-800 rounded-xl p-6">
            <h3 className="text-xl font-semibold mb-4">
              Recent Winners ({stats.recent_completed.winners.length})
            </h3>
            {stats.recent_completed.winners.length === 0 ? (
              <p className="text-gray-400 text-center py-8">
                No recent winners
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.recent_completed.winners.map((token) => (
                  <div
                    key={token.id}
                    className="p-4 bg-gray-800 rounded-xl border border-green-600/30 hover:border-green-500/50 transition-all duration-200 cursor-pointer"
                    onClick={() =>
                      handleTokenClick(token, stats.recent_completed.winners)
                    }
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center space-x-3">
                        <div className="relative">
                          <TokenIcon token={token} />
                          <div className="absolute -top-1 -right-1 w-4 h-4 bg-green-600 rounded-full flex items-center justify-center">
                            <svg
                              className="w-2 h-2 text-white"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path
                                fillRule="evenodd"
                                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </div>
                        </div>
                        <div>
                          <div className="font-semibold text-white">
                            {token.token_symbol || "Unknown"}
                          </div>
                          <div className="text-xs text-gray-400 truncate max-w-32">
                            {token.token_name}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-white font-medium">
                          {formatPrice(token.last_price_usd)}
                        </div>
                        <div className="text-xs text-green-400">
                          +{token.peak_gain_percentage.toFixed(2)}%
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-between text-xs mt-2">
                      <div>
                        <span className="text-gray-400">Final: </span>
                        <span className="text-green-400">
                          +{token.current_gain_percentage.toFixed(2)}%
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">Won: </span>
                        <span className="text-white">
                          {formatRelativeTime(
                            token.status_changed_at || token.updated_at,
                          )}
                        </span>
                      </div>
                    </div>
                    {/* Trade comparison indicator */}
                    {token.trade_comparison_data &&
                      !token.trading_simulation && (
                        <div className="mt-2 text-xs text-blue-400">
                          📊 Trade data available
                        </div>
                      )}
                    {/* Trading simulation indicator */}
                    {token.trading_simulation && (
                      <div className="mt-2 text-xs text-green-400">
                        🤖 Simulation data available
                      </div>
                    )}

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleOpenTradingModal(token);
                      }}
                      className="mt-3 w-full py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded transition-colors flex items-center justify-center gap-1"
                    >
                      <span>📈</span> Chart & Buy
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === "losers" && (
          <div className="bg-gray-800 rounded-xl p-6">
            <h3 className="text-xl font-semibold mb-4">
              Recent Losers ({stats.recent_completed.losers.length})
            </h3>
            {stats.recent_completed.losers.length === 0 ? (
              <p className="text-gray-400 text-center py-8">No recent losers</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {stats.recent_completed.losers.map((token) => (
                  <div
                    key={token.id}
                    className="p-4 bg-gray-800 rounded-xl border border-red-600/30 hover:border-red-500/50 transition-all duration-200 cursor-pointer"
                    onClick={() =>
                      handleTokenClick(token, stats.recent_completed.losers)
                    }
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center space-x-3">
                        <div className="relative">
                          <TokenIcon token={token} />
                          <div className="absolute -top-1 -right-1 w-4 h-4 bg-red-600 rounded-full flex items-center justify-center">
                            <svg
                              className="w-2 h-2 text-white"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path
                                fillRule="evenodd"
                                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </div>
                        </div>
                        <div>
                          <div className="font-semibold text-white">
                            {token.token_symbol || "Unknown"}
                          </div>
                          <div className="text-xs text-gray-400 truncate max-w-32">
                            {token.token_name}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-white font-medium">
                          {formatPrice(token.last_price_usd)}
                        </div>
                        <div className="text-xs text-red-400">
                          {token.current_gain_percentage.toFixed(2)}%
                        </div>
                      </div>
                    </div>
                    <div className="flex justify-between text-xs mt-2">
                      <div>
                        <span className="text-gray-400">Peak: </span>
                        <span
                          className={
                            token.peak_gain_percentage >= 0
                              ? "text-green-400"
                              : "text-red-400"
                          }
                        >
                          {formatPercentage(token.peak_gain_percentage, true)}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-400">Lost: </span>
                        <span className="text-white">
                          {formatRelativeTime(
                            token.status_changed_at || token.updated_at,
                          )}
                        </span>
                      </div>
                    </div>
                    {/* Trade comparison indicator */}
                    {token.trade_comparison_data &&
                      !token.trading_simulation && (
                        <div className="mt-2 text-xs text-blue-400">
                          📊 Trade data available
                        </div>
                      )}
                    {/* Trading simulation indicator */}
                    {token.trading_simulation && (
                      <div className="mt-2 text-xs text-green-400">
                        🤖 Simulation data available
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Configuration Modal */}
      <ConfigModal />

      {/* Unified Token Modal */}
      {unifiedModalState.isOpen &&
        unifiedModalState.modalType !== "trading" && (
          <UnifiedTokenModal
            isOpen={unifiedModalState.isOpen}
            onClose={handleCloseModal}
            modalType={unifiedModalState.modalType}
            // Trading simulation props
            tokenAddress={unifiedModalState.tokenData?.mint}
            tokenSymbol={unifiedModalState.tokenData?.symbol}
            tokenName={unifiedModalState.tokenData?.name}
            logoUrl={unifiedModalState.tokenData?.logoUrl}
            isSimulated={tradingConfig.isSimulated}
            keypairPath={tradingConfig.keypairPath}
            onTradeTriggered={handleTradeTriggered}
            // Transaction result props
            operation={unifiedModalState.transactionData?.operation}
            result={unifiedModalState.transactionData?.result}
            solToUsd={(sol) => sol * 145}
          />
        )}

      {/* Chart Buy Modal with Navigation */}
      {unifiedModalState.isOpen &&
        unifiedModalState.modalType === "trading" && (
          <ChartBuyModal
            tokenAddress={unifiedModalState.tokenData?.mint || null}
            onClose={handleCloseModal}
            initialBuyAmount="0.01"
            // Navigation logic
            onNavigate={(direction) => {
              const allTokens = unifiedModalState.allTokens || [];
              if (!allTokens.length) return;

              const currentMint = unifiedModalState.tokenData?.mint;
              const currentIndex = allTokens.findIndex(
                (t: any) => t.token_address === currentMint,
              );

              if (currentIndex === -1) return;

              let nextIndex = currentIndex;
              if (direction === "next") {
                nextIndex = currentIndex + 1;
              } else {
                nextIndex = currentIndex - 1;
              }

              if (nextIndex >= 0 && nextIndex < allTokens.length) {
                const nextToken = allTokens[nextIndex];
                setUnifiedModalState({
                  ...unifiedModalState,
                  tokenData: {
                    mint: nextToken.token_address,
                    symbol: nextToken.token_symbol,
                    name: nextToken.token_name,
                    logoUrl: nextToken.logo_url,
                  },
                });
              }
            }}
            hasPrev={
              (unifiedModalState.allTokens?.findIndex(
                (t: any) =>
                  t.token_address === unifiedModalState.tokenData?.mint,
              ) ?? -1) > 0
            }
            hasNext={
              (unifiedModalState.allTokens?.findIndex(
                (t: any) =>
                  t.token_address === unifiedModalState.tokenData?.mint,
              ) ?? -1) <
              (unifiedModalState.allTokens?.length ?? 0) - 1
            }
          />
        )}

      {/* Unified Tracker Module removed to avoid duplication */}

      {selectedTokenForDetails && (
        <TokenDetailsModal
          token={selectedTokenForDetails}
          onClose={() => setSelectedTokenForDetails(null)}
          onBuy={() => {
            handleOpenTradingModal(selectedTokenForDetails);
            setSelectedTokenForDetails(null);
          }}
          onNavigate={(direction) => {
            if (!detailsSourceList || detailsSourceList.length === 0) return;
            const currentIndex = detailsSourceList.findIndex(
              (t: any) =>
                (t.id && t.id === selectedTokenForDetails.id) ||
                (t.token_address &&
                  t.token_address === selectedTokenForDetails.token_address),
            );
            if (currentIndex === -1) return;

            let nextIndex = currentIndex;
            if (direction === "up") {
              nextIndex = currentIndex - 1;
            } else {
              nextIndex = currentIndex + 1;
            }

            if (nextIndex >= 0 && nextIndex < detailsSourceList.length) {
              setSelectedTokenForDetails(detailsSourceList[nextIndex]);
            }
          }}
          hasUp={(() => {
            if (!detailsSourceList || detailsSourceList.length === 0)
              return false;
            const currentIndex = detailsSourceList.findIndex(
              (t: any) =>
                (t.id && t.id === selectedTokenForDetails.id) ||
                (t.token_address &&
                  t.token_address === selectedTokenForDetails.token_address),
            );
            return currentIndex > 0;
          })()}
          hasDown={(() => {
            if (!detailsSourceList || detailsSourceList.length === 0)
              return false;
            const currentIndex = detailsSourceList.findIndex(
              (t: any) =>
                (t.id && t.id === selectedTokenForDetails.id) ||
                (t.token_address &&
                  t.token_address === selectedTokenForDetails.token_address),
            );
            return (
              currentIndex !== -1 && currentIndex < detailsSourceList.length - 1
            );
          })()}
        />
      )}
    </div>
  );
}
