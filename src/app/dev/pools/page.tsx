"use client";

import React, { useState, useEffect, useCallback } from "react";
import NavigationTabs from "@/components/NavigationTabs";
import {
  useTrendingPools,
  type TrendingToken,
  type TrendingResponse,
} from "@/hooks/useTrendingPools";

interface MarketCapCategory {
  name: string;
  min: number;
  max: number;
  color: string;
  bgColor: string;
}

const MARKET_CAP_CATEGORIES: MarketCapCategory[] = [
  {
    name: "0-50K",
    min: 0,
    max: 50000,
    color: "text-red-400",
    bgColor: "bg-red-900/20 border-red-600",
  },
  {
    name: "51K-200K",
    min: 50001,
    max: 200000,
    color: "text-yellow-400",
    bgColor: "bg-yellow-900/20 border-yellow-600",
  },
  {
    name: "200K-500K",
    min: 200001,
    max: 500000,
    color: "text-blue-400",
    bgColor: "bg-blue-900/20 border-blue-600",
  },
  {
    name: ">500K",
    min: 500001,
    max: 3000000,
    color: "text-green-400",
    bgColor: "bg-green-900/20 border-green-600",
  },
];

const LoadingSkeleton = () => (
  <div className="space-y-6 animate-pulse">
    {[...Array(3)].map((_, i) => (
      <div key={i} className="bg-gray-800 rounded-lg p-6">
        <div className="h-6 bg-gray-700 rounded w-1/3 mb-4"></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[...Array(3)].map((_, j) => (
            <div key={j} className="h-32 bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    ))}
  </div>
);

export default function TrendingPoolsPage() {
  const {
    data: trendingData,
    isLoading: loading,
    error: queryError,
    refetch,
  } = useTrendingPools();
  const error = queryError instanceof Error ? queryError.message : null;

  const [volumeFilter, setVolumeFilter] = useState<number>(0);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"mcap" | "volume" | "score" | "change">(
    "score",
  );
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  // Chart tooltip state
  const [selectedToken, setSelectedToken] = useState<TrendingToken | null>(
    null,
  );
  const [tooltipPosition, setTooltipPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  // Handle chart tooltip toggle
  const handleChartClick = useCallback(
    (token: TrendingToken, event: React.MouseEvent) => {
      if (selectedToken?.token_address === token.token_address) {
        // If same token is clicked, close tooltip
        setSelectedToken(null);
        setTooltipPosition(null);
      } else {
        // Show tooltip for the selected token
        const rect = event.currentTarget.getBoundingClientRect();
        setSelectedToken(token);
        setTooltipPosition({
          x: rect.left + rect.width / 2,
          y: rect.top,
        });
      }
    },
    [selectedToken],
  );

  // Close tooltip when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (
        !target.closest(".chart-tooltip") &&
        !target.closest(".chart-button")
      ) {
        setSelectedToken(null);
        setTooltipPosition(null);
      }
    };

    if (selectedToken) {
      document.addEventListener("click", handleClickOutside);
      return () => document.removeEventListener("click", handleClickOutside);
    }
  }, [selectedToken]);

  // Helper functions
  const formatNumber = (num: number): string => {
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(2)}M`;
    } else if (num >= 1_000) {
      return `${(num / 1_000).toFixed(2)}K`;
    }
    return num.toLocaleString();
  };

  const formatPrice = (price: number): string => {
    if (price < 0.001) {
      return price.toExponential(3);
    }
    return price.toFixed(6);
  };

  const formatPercentage = (value: number): string => {
    return `${(value * 100).toFixed(2)}%`;
  };

  const getMarketCapCategory = (mcap: number): MarketCapCategory | null => {
    return (
      MARKET_CAP_CATEGORIES.find((cat) => mcap >= cat.min && mcap <= cat.max) ||
      null
    );
  };

  const calculateNetVolume = (token: TrendingToken): number => {
    const buyVolume = token.buy_volume_1h ?? 0;
    const sellVolume = token.sell_volume_1h ?? 0;
    const buyVolume5m = token.buy_volume_5m ?? 0;
    const sellVolume5m = token.sell_volume_5m ?? 0;
    return buyVolume - sellVolume + (buyVolume5m - sellVolume5m);
  };

  // Filter and sort tokens
  const filteredAndSortedTokens = React.useMemo(() => {
    if (!trendingData?.tokens) return [];

    let filtered = trendingData.tokens.filter((token) => {
      // First, filter out tokens with market cap above 3M (billions like Bonk)
      if (token.mcap > 3000000) {
        console.log(
          `Filtering out ${token.token_symbol} with mcap: ${token.mcap}`,
        );
        return false;
      }

      const netVolume = calculateNetVolume(token);
      const volumeMatch = netVolume >= volumeFilter;

      if (selectedCategory === "all") return volumeMatch;

      const category = getMarketCapCategory(token.mcap);
      // Only include tokens that have a valid category AND match the selected category
      return volumeMatch && category && category.name === selectedCategory;
    });

    filtered.sort((a, b) => {
      let aValue: number, bValue: number;

      switch (sortBy) {
        case "mcap":
          aValue = a.mcap;
          bValue = b.mcap;
          break;
        case "volume":
          aValue = calculateNetVolume(a);
          bValue = calculateNetVolume(b);
          break;
        case "score":
          aValue = a.organic_score;
          bValue = b.organic_score;
          break;
        case "change":
          aValue = a.change_1h;
          bValue = b.change_1h;
          break;
        default:
          aValue = a.organic_score;
          bValue = b.organic_score;
      }

      return sortOrder === "desc" ? bValue - aValue : aValue - bValue;
    });

    return filtered;
  }, [trendingData, volumeFilter, selectedCategory, sortBy, sortOrder]);

  // Group tokens by market cap category
  const tokensByCategory = React.useMemo(() => {
    const grouped: Record<string, TrendingToken[]> = {};

    MARKET_CAP_CATEGORIES.forEach((category) => {
      grouped[category.name] = [];
    });

    filteredAndSortedTokens.forEach((token) => {
      const category = getMarketCapCategory(token.mcap);
      // Only group tokens that have a valid category
      if (category) {
        grouped[category.name].push(token);
      }
    });

    return grouped;
  }, [filteredAndSortedTokens]);

  return (
    <main className="min-h-screen bg-black py-8 relative">
      <NavigationTabs />
      <div className="container mx-auto px-4">
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Header */}
          <div className="text-center mb-8">
            <h1 className="text-5xl font-bold text-white mb-4">
              📊 Trending Pools Dashboard
            </h1>
            <h2 className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
              Real-time trending pool data with market cap categories and volume
              filtering
            </h2>
            <div className="mt-6 flex justify-center gap-4">
              <button
                onClick={handleRefresh}
                disabled={loading}
                className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:bg-gray-600 transition-colors font-semibold"
              >
                {loading ? "🔄 Loading..." : "🔄 Refresh Data"}
              </button>
            </div>
          </div>

          {/* ... existing code ... */}

          {/* Token Cards - Modified to include chart button */}
          {loading && <LoadingSkeleton />}

          {error && (
            <div className="bg-red-900/20 border border-red-600 text-red-400 p-6 rounded-lg">
              <h3 className="font-bold mb-2">❌ Error Loading Data</h3>
              <p>{error}</p>
              <button
                onClick={handleRefresh}
                className="mt-4 bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 transition-colors"
              >
                🔄 Retry
              </button>
            </div>
          )}

          {trendingData && (
            <div className="space-y-6">
              {MARKET_CAP_CATEGORIES.map((category) => {
                const categoryTokens = tokensByCategory[category.name];
                if (categoryTokens.length === 0) return null;

                return (
                  <div
                    key={category.name}
                    className={`border rounded-lg p-6 ${category.bgColor}`}
                  >
                    <h2 className={`text-2xl font-bold mb-4 ${category.color}`}>
                      💰 {category.name} Market Cap ({categoryTokens.length}{" "}
                      tokens)
                    </h2>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {categoryTokens.map((token, index) => {
                        const netVolume = calculateNetVolume(token);
                        const createdDate = token.created_at
                          ? new Date(token.created_at * 1000)
                          : null;
                        const isSelected =
                          selectedToken?.token_address === token.token_address;

                        return (
                          <div
                            key={`${token.token_address}-${index}`}
                            className="bg-gray-800 border border-gray-600 rounded-lg p-4 hover:border-gray-500 transition-colors relative"
                          >
                            {/* Token Header */}
                            <div className="flex items-center gap-3 mb-4">
                              {token.logo_url && (
                                <img
                                  src={token.logo_url}
                                  alt={token.token_symbol}
                                  className="w-10 h-10 rounded-full"
                                  onError={(e) => {
                                    e.currentTarget.style.display = "none";
                                  }}
                                />
                              )}
                              <div className="flex-1">
                                <h3 className="text-lg font-bold text-white">
                                  {token.token_symbol}
                                </h3>
                                <p className="text-sm text-gray-400 font-mono">
                                  {token.token_address.slice(0, 8)}...
                                  {token.token_address.slice(-8)}
                                </p>
                              </div>
                            </div>

                            {/* Token Stats */}
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="text-gray-400">Price:</span>
                                <span className="text-white font-bold">
                                  ${formatPrice(token.price)}
                                </span>
                              </div>

                              <div className="flex justify-between">
                                <span className="text-gray-400">
                                  Market Cap:
                                </span>
                                <span className="text-green-400 font-bold">
                                  ${formatNumber(token.mcap)}
                                </span>
                              </div>

                              <div className="flex justify-between">
                                <span className="text-gray-400">
                                  1H Change:
                                </span>
                                <span
                                  className={`font-bold ${
                                    token.change_1h > 0
                                      ? "text-green-400"
                                      : token.change_1h < 0
                                        ? "text-red-400"
                                        : "text-gray-400"
                                  }`}
                                >
                                  {formatPercentage(token.change_1h)}
                                </span>
                              </div>

                              <div className="flex justify-between">
                                <span className="text-gray-400">
                                  5M Change:
                                </span>
                                <span
                                  className={`font-bold ${
                                    token.change_5m > 0
                                      ? "text-green-400"
                                      : token.change_5m < 0
                                        ? "text-red-400"
                                        : "text-gray-400"
                                  }`}
                                >
                                  {formatPercentage(token.change_5m)}
                                </span>
                              </div>

                              <div className="flex justify-between">
                                <span className="text-gray-400">
                                  1H Volume:
                                </span>
                                <span className="text-blue-400 font-bold">
                                  ${formatNumber(token.volume_1h)}
                                </span>
                              </div>

                              <div className="flex justify-between">
                                <span className="text-gray-400">
                                  Net Volume:
                                </span>
                                <span
                                  className={`font-bold ${
                                    netVolume > 0
                                      ? "text-green-400"
                                      : netVolume < 0
                                        ? "text-red-400"
                                        : "text-gray-400"
                                  }`}
                                >
                                  ${formatNumber(Math.abs(netVolume))}{" "}
                                  {netVolume >= 0 ? "(Buy)" : "(Sell)"}
                                </span>
                              </div>

                              <div className="flex justify-between">
                                <span className="text-gray-400">
                                  Organic Score:
                                </span>
                                <span className="text-yellow-400 font-bold">
                                  {token.organic_score.toFixed(1)}
                                </span>
                              </div>

                              {createdDate && (
                                <div className="flex justify-between">
                                  <span className="text-gray-400">
                                    Created:
                                  </span>
                                  <span className="text-purple-400 text-xs">
                                    {createdDate.toLocaleDateString()}
                                  </span>
                                </div>
                              )}

                              {token.last_updated && (
                                <div className="flex justify-between">
                                  <span className="text-gray-400">
                                    Updated:
                                  </span>
                                  <span
                                    className="text-gray-500 text-xs"
                                    suppressHydrationWarning
                                  >
                                    {Math.round(
                                      (Date.now() - token.last_updated) / 1000,
                                    )}
                                    s ago
                                  </span>
                                </div>
                              )}
                            </div>

                            {/* Action Buttons */}
                            <div className="mt-4 flex gap-2">
                              <button
                                onClick={() =>
                                  window.open(
                                    `https://solscan.io/token/${token.token_address}`,
                                    "_blank",
                                  )
                                }
                                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs py-2 px-3 rounded transition-colors"
                              >
                                📊 Solscan
                              </button>
                              <button
                                onClick={(e) => handleChartClick(token, e)}
                                className={`chart-button flex-1 text-white text-xs py-2 px-3 rounded transition-colors ${
                                  isSelected
                                    ? "bg-red-600 hover:bg-red-700"
                                    : "bg-green-600 hover:bg-green-700"
                                }`}
                              >
                                {isSelected ? "✕ Close Chart" : "📈 Chart"}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Raw Data */}
          {trendingData && (
            <div className="bg-gray-900 border border-gray-700 rounded-lg p-6">
              <details className="cursor-pointer">
                <summary className="font-medium text-gray-300 hover:text-white">
                  🔍 Raw API Response (JSON)
                </summary>
                <pre className="mt-4 text-xs bg-gray-800 text-gray-300 p-4 rounded border border-gray-600 overflow-auto max-h-96">
                  {JSON.stringify(trendingData, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>

      {/* Chart Tooltip Overlay */}
      {selectedToken && tooltipPosition && (
        <div
          className="chart-tooltip fixed z-50 bg-gray-900 border border-gray-600 rounded-lg shadow-2xl"
          style={{
            left: `${Math.max(20, Math.min(tooltipPosition.x - 200, window.innerWidth - 420))}px`,
            top: `${Math.max(20, tooltipPosition.y - 320)}px`,
            width: "400px",
            maxHeight: "600px",
          }}
        >
          <div className="p-4">
            {/* Tooltip Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                {selectedToken.logo_url && (
                  <img
                    src={selectedToken.logo_url}
                    alt={selectedToken.token_symbol}
                    className="w-8 h-8 rounded-full"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                )}
                <div>
                  <h3 className="text-lg font-bold text-white">
                    {selectedToken.token_symbol}
                  </h3>
                  <p className="text-xs text-gray-400">
                    ${formatPrice(selectedToken.price)}
                  </p>
                  <p className="text-xs text-gray-500 font-mono">
                    {selectedToken.token_address.slice(0, 8)}...
                    {selectedToken.token_address.slice(-8)}
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setSelectedToken(null);
                  setTooltipPosition(null);
                }}
                className="text-gray-400 hover:text-white transition-colors text-xl"
              >
                ✕
              </button>
            </div>

            {/* Chart */}
            <div className="bg-gray-800 rounded-lg overflow-hidden mb-4">
              <iframe
                src={`https://www.gmgn.cc/kline/sol/${selectedToken.token_address}?interval=1D`}
                width="100%"
                height="300"
                frameBorder="0"
                className="w-full"
                title={`${selectedToken.token_symbol} Chart`}
                sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                loading="lazy"
              />
            </div>

            {/* Quick Actions */}
            <div className="flex gap-2">
              <button
                onClick={() =>
                  window.open(
                    `https://www.gmgn.cc/kline/sol/${selectedToken.token_address}?interval=1D`,
                    "_blank",
                  )
                }
                className="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-xs py-2 px-3 rounded transition-colors"
              >
                🚀 GMGN
              </button>
              <button
                onClick={() =>
                  window.open(
                    `https://www.gmgn.cc/kline/sol/${selectedToken.token_address}?interval=1D`,
                    "_blank",
                  )
                }
                className="flex-1 bg-green-600 hover:bg-green-700 text-white text-xs py-2 px-3 rounded transition-colors"
              >
                📈 DexScreener
              </button>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(selectedToken.token_address);
                }}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-white text-xs py-2 px-3 rounded transition-colors"
              >
                📋 Copy
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
