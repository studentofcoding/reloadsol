"use client";

import React, { useState, useEffect, useCallback } from "react";
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
} from "chart.js";
import { Line } from "react-chartjs-2";
import "chartjs-adapter-date-fns";
import ChartBuyModal from "@/components/ChartBuyModal";
import DlmmChartActions from "@/components/dlmm/DlmmChartActions";
import {
  useTrackingHistory,
  type FilterOptions,
  type TrackedTokenHistory,
} from "@/hooks/useTrackingHistory";

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  TimeScale,
);

const LoadingSkeleton = () => (
  <div className="space-y-4 animate-pulse">
    {[...Array(5)].map((_, i) => (
      <div key={i} className="bg-gray-800 rounded-lg p-6">
        <div className="flex justify-between items-start mb-4">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-gray-700 rounded-full"></div>
            <div>
              <div className="h-5 bg-gray-700 rounded w-24 mb-2"></div>
              <div className="h-4 bg-gray-700 rounded w-32"></div>
            </div>
          </div>
          <div className="h-6 bg-gray-700 rounded w-16"></div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, j) => (
            <div key={j} className="h-16 bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    ))}
  </div>
);

export default function HistoryTab() {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  const [selectedToken, setSelectedToken] =
    useState<TrackedTokenHistory | null>(null);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [chartModalTokenAddress, setChartModalTokenAddress] = useState<
    string | null
  >(null);

  const [filters, setFilters] = useState<FilterOptions>({
    status: "all",
    dateRange: "all",
    minGain: "",
    maxGain: "",
    minDuration: "",
    maxDuration: "",
    sortBy: "created_at",
    sortOrder: "desc",
  });

  const {
    data: apiResponse,
    isLoading: loading,
    error: queryError,
    refetch: fetchTokenHistory,
  } = useTrackingHistory({
    filters,
    page: currentPage,
    limit: itemsPerPage,
    searchQuery,
  });

  const error = queryError ? (queryError as Error).message : "";
  const tokens = apiResponse?.data || [];
  const pagination = apiResponse?.pagination || null;
  const stats = apiResponse?.stats || null;

  // Handlers
  const handlePageChange = (newPage: number) => {
    setCurrentPage(newPage);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleFilterChange = (
    key: keyof FilterOptions,
    value: string | number,
  ) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setCurrentPage(1); // Reset to first page when filters change
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setCurrentPage(1);
  };

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
    return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
  };

  const formatDuration = (
    startTime: string,
    endTime?: string | null,
  ): string => {
    const start = new Date(startTime).getTime();
    const end = endTime ? new Date(endTime).getTime() : new Date().getTime();
    const hours = (end - start) / (1000 * 60 * 60);

    if (hours < 1) {
      return `${Math.round(hours * 60)}m`;
    } else if (hours < 24) {
      return `${hours.toFixed(1)}h`;
    } else {
      return `${(hours / 24).toFixed(1)}d`;
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case "won":
        return "bg-green-600 text-green-100";
      case "lost":
        return "bg-red-600 text-red-100";
      case "tracking":
        return "bg-blue-600 text-blue-100";
      case "waiting":
        return "bg-yellow-600 text-yellow-100";
      case "skipped":
        return "bg-gray-600 text-gray-100";
      default:
        return "bg-gray-600 text-gray-100";
    }
  };

  const getStatusIcon = (status: string): string => {
    switch (status) {
      case "won":
        return "🏆";
      case "lost":
        return "💔";
      case "tracking":
        return "👀";
      case "waiting":
        return "⏳";
      case "skipped":
        return "⏭️";
      default:
        return "❓";
    }
  };

  const exportToCSV = () => {
    const headers = [
      "Token Symbol",
      "Token Name",
      "Token Address",
      "Status",
      "Initial Price USD",
      "Last Price USD",
      "Peak Price USD",
      "Current Gain %",
      "Peak Gain %",
      "Market Cap",
      "Organic Score",
      "Tracking Started",
      "Status Changed",
      "Duration",
    ];

    const csvData = tokens.map((token) => [
      token.token_symbol || "",
      token.token_name || "",
      token.token_address,
      token.status,
      token.initial_price_usd,
      token.last_price_usd,
      token.peak_price_usd,
      token.current_gain_percentage,
      token.peak_gain_percentage,
      token.market_cap || "",
      token.organic_score || "",
      token.tracking_started_at,
      token.status_changed_at || "",
      formatDuration(token.tracking_started_at, token.status_changed_at),
    ]);

    const csvContent = [headers, ...csvData]
      .map((row) => row.map((cell) => `"${cell}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `token-tracking-history-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="py-4">
        <div className="container mx-auto px-4">
          <div className="max-w-7xl mx-auto space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-xl font-semibold text-white mb-4">
                Loading history…
              </h2>
            </div>
            <LoadingSkeleton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="py-4">
      <div className="container mx-auto px-4">
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Statistics Overview - Use stats from API */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-6">
              <div className="bg-gray-800 p-4 rounded-lg text-center">
                <div className="text-2xl font-bold text-white">
                  {stats.total}
                </div>
                <div className="text-sm text-gray-400">Total Tracked</div>
              </div>
              <div className="bg-green-900/20 border border-green-600 p-4 rounded-lg text-center">
                <div className="text-2xl font-bold text-green-400">
                  {stats.won}
                </div>
                <div className="text-sm text-gray-400">Won</div>
              </div>
              <div className="bg-red-900/20 border border-red-600 p-4 rounded-lg text-center">
                <div className="text-2xl font-bold text-red-400">
                  {stats.lost}
                </div>
                <div className="text-sm text-gray-400">Lost</div>
              </div>
              <div className="bg-blue-900/20 border border-blue-600 p-4 rounded-lg text-center">
                <div className="text-2xl font-bold text-blue-400">
                  {stats.tracking}
                </div>
                <div className="text-sm text-gray-400">Tracking</div>
              </div>
              <div className="bg-yellow-900/20 border border-yellow-600 p-4 rounded-lg text-center">
                <div className="text-2xl font-bold text-yellow-400">
                  {stats.waiting}
                </div>
                <div className="text-sm text-gray-400">Waiting</div>
              </div>
              <div className="bg-gray-900/20 border border-gray-600 p-4 rounded-lg text-center">
                <div className="text-2xl font-bold text-gray-400">
                  {stats.skipped}
                </div>
                <div className="text-sm text-gray-400">Skipped</div>
              </div>
              <div className="bg-purple-900/20 border border-purple-600 p-4 rounded-lg text-center">
                <div className="text-2xl font-bold text-purple-400">
                  {stats.winRate.toFixed(1)}%
                </div>
                <div className="text-sm text-gray-400">Win Rate</div>
              </div>
            </div>
          )}

          {/* Filters and Search */}
          <div className="bg-gray-800 rounded-lg p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h3 className="text-xl font-bold text-white">Filters & Search</h3>
              <div className="flex gap-2">
                <button
                  onClick={exportToCSV}
                  className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors"
                >
                  📊 Export CSV
                </button>
                <button
                  onClick={() => fetchTokenHistory()}
                  className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                >
                  🔄 Refresh
                </button>
              </div>
            </div>

            {/* Search */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Search
                </label>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Symbol, name, or address..."
                  className="w-full p-3 bg-gray-700 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Status
                </label>
                <select
                  value={filters.status}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      status: e.target.value as any,
                    }))
                  }
                  className="w-full p-3 bg-gray-700 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All Statuses</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                  <option value="tracking">Tracking</option>
                  <option value="waiting">Waiting</option>
                  <option value="skipped">Skipped</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Date Range
                </label>
                <select
                  value={filters.dateRange}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      dateRange: e.target.value as any,
                    }))
                  }
                  className="w-full p-3 bg-gray-700 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All Time</option>
                  <option value="24h">Last 24 Hours</option>
                  <option value="7d">Last 7 Days</option>
                  <option value="30d">Last 30 Days</option>
                  <option value="90d">Last 90 Days</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Sort By
                </label>
                <select
                  value={filters.sortBy}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      sortBy: e.target.value as any,
                    }))
                  }
                  className="w-full p-3 bg-gray-700 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                >
                  <option value="created_at">Date Created</option>
                  <option value="peak_gain_percentage">Peak Gain %</option>
                  <option value="current_gain_percentage">
                    Current Gain %
                  </option>
                  <option value="tracking_duration">Duration</option>
                  <option value="status_changed_at">Status Changed</option>
                </select>
              </div>
            </div>

            {/* Advanced Filters */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Min Gain %
                </label>
                <input
                  type="number"
                  value={filters.minGain}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, minGain: e.target.value }))
                  }
                  placeholder="e.g. -50"
                  className="w-full p-3 bg-gray-700 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max Gain %
                </label>
                <input
                  type="number"
                  value={filters.maxGain}
                  onChange={(e) =>
                    setFilters((prev) => ({ ...prev, maxGain: e.target.value }))
                  }
                  placeholder="e.g. 1000"
                  className="w-full p-3 bg-gray-700 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Min Duration (hours)
                </label>
                <input
                  type="number"
                  value={filters.minDuration}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      minDuration: e.target.value,
                    }))
                  }
                  placeholder="e.g. 1"
                  className="w-full p-3 bg-gray-700 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Max Duration (hours)
                </label>
                <input
                  type="number"
                  value={filters.maxDuration}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      maxDuration: e.target.value,
                    }))
                  }
                  placeholder="e.g. 24"
                  className="w-full p-3 bg-gray-700 border border-gray-600 text-white rounded-md focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-300">Sort Order:</label>
                <button
                  onClick={() =>
                    setFilters((prev) => ({
                      ...prev,
                      sortOrder: prev.sortOrder === "desc" ? "asc" : "desc",
                    }))
                  }
                  className={`px-3 py-1 rounded text-sm font-medium ${
                    filters.sortOrder === "desc"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-700 text-gray-300"
                  }`}
                >
                  {filters.sortOrder === "desc"
                    ? "↓ Descending"
                    : "↑ Ascending"}
                </button>
              </div>

              {pagination && (
                <div className="text-sm text-gray-400">
                  Showing {tokens.length} of {pagination.total} tokens
                </div>
              )}
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <div className="bg-red-900/20 border border-red-600 rounded-lg p-4">
              <div className="text-red-400 font-medium">❌ Error</div>
              <div className="text-red-300 mt-2">{error}</div>
            </div>
          )}

          {/* Token List */}
          <div className="space-y-4">
            {tokens.map((token) => (
              <div
                key={token.id}
                className="bg-gray-800 rounded-lg p-6 hover:bg-gray-750 transition-colors"
              >
                {/* Token Header */}
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center space-x-3">
                    {token.logo_url ? (
                      <img
                        src={token.logo_url}
                        alt={token.token_symbol || "Token"}
                        className="w-10 h-10 rounded-full"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="w-10 h-10 bg-gray-600 rounded-full flex items-center justify-center text-white font-bold">
                        {(token.token_symbol || "?")[0]}
                      </div>
                    )}
                    <div>
                      <h3 className="text-lg font-bold text-white">
                        {token.token_symbol || "Unknown"}
                      </h3>
                      <p className="text-sm text-gray-400">
                        {token.token_name || "Unknown Token"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3">
                    <span
                      className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(token.status)}`}
                    >
                      {getStatusIcon(token.status)} {token.status.toUpperCase()}
                    </span>
                  </div>
                </div>

                {/* Performance Metrics */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div className="bg-gray-700 p-3 rounded-lg">
                    <div className="text-sm text-gray-400">Duration</div>
                    <div className="text-lg font-bold text-white">
                      {formatDuration(
                        token.tracking_started_at,
                        token.status_changed_at,
                      )}
                    </div>
                  </div>

                  <div className="bg-gray-700 p-3 rounded-lg">
                    <div className="text-sm text-gray-400">Price Range</div>
                    <div className="text-lg font-bold text-white">
                      ${formatPrice(token.initial_price_usd)} → $
                      {formatPrice(token.last_price_usd)}
                    </div>
                  </div>

                  <div className="bg-gray-700 p-3 rounded-lg">
                    <div className="text-sm text-gray-400">Current Gain</div>
                    <div
                      className={`text-lg font-bold ${
                        token.current_gain_percentage >= 0
                          ? "text-green-400"
                          : "text-red-400"
                      }`}
                    >
                      {formatPercentage(token.current_gain_percentage)}
                    </div>
                  </div>

                  <div className="bg-gray-700 p-3 rounded-lg">
                    <div className="text-sm text-gray-400">Peak Gain</div>
                    <div
                      className={`text-lg font-bold ${
                        token.peak_gain_percentage >= 0
                          ? "text-green-400"
                          : "text-red-400"
                      }`}
                    >
                      {formatPercentage(token.peak_gain_percentage)}
                    </div>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex justify-end space-x-2 flex-wrap items-center gap-y-2">
                  <button
                    onClick={() =>
                      setChartModalTokenAddress(token.token_address)
                    }
                    className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2"
                  >
                    <span>📈</span> Buy
                  </button>
                  <DlmmChartActions
                    tokenAddress={token.token_address}
                    tokenSymbol={token.token_symbol}
                    source="algo-history"
                  />
                  <button
                    onClick={() => {
                      setSelectedToken(token);
                      setShowDetailsModal(true);
                    }}
                    className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    📊 Details
                  </button>
                </div>

                {/* Additional Info Row */}
                <div className="mt-4 pt-4 border-t border-gray-700">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-gray-400">Market Cap:</span>
                      <span className="text-white ml-2">
                        {token.market_cap
                          ? `$${formatNumber(token.market_cap)}`
                          : "N/A"}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400">Organic Score:</span>
                      <span className="text-white ml-2">
                        {token.organic_score?.toFixed(1) || "N/A"}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400">Started:</span>
                      <span className="text-white ml-2">
                        {new Date(
                          token.tracking_started_at,
                        ).toLocaleDateString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400">Status Changed:</span>
                      <span className="text-white ml-2">
                        {token.status_changed_at
                          ? new Date(
                              token.status_changed_at,
                            ).toLocaleDateString()
                          : "Still active"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination - Use API pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-between bg-gray-800 rounded-lg p-4">
              <div className="flex items-center gap-2">
                <span className="text-gray-400">Items per page:</span>
                <select
                  value={itemsPerPage}
                  onChange={(e) => {
                    setItemsPerPage(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="bg-gray-700 border border-gray-600 text-white rounded px-2 py-1"
                >
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span className="text-gray-400 ml-4">
                  Showing {(pagination.page - 1) * pagination.limit + 1} to{" "}
                  {Math.min(
                    pagination.page * pagination.limit,
                    pagination.total,
                  )}{" "}
                  of {pagination.total} tokens
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage(1)}
                  disabled={!pagination.hasPrev}
                  className="bg-gray-700 text-white px-3 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  ⏮️ First
                </button>
                <button
                  onClick={() =>
                    setCurrentPage((prev) => Math.max(1, prev - 1))
                  }
                  disabled={!pagination.hasPrev}
                  className="bg-gray-700 text-white px-3 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  ← Previous
                </button>

                <span className="text-gray-400 px-4">
                  Page {pagination.page} of {pagination.totalPages}
                </span>

                <button
                  onClick={() =>
                    setCurrentPage((prev) =>
                      Math.min(pagination.totalPages, prev + 1),
                    )
                  }
                  disabled={!pagination.hasNext}
                  className="bg-gray-700 text-white px-3 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next →
                </button>
                <button
                  onClick={() => setCurrentPage(pagination.totalPages)}
                  disabled={!pagination.hasNext}
                  className="bg-gray-700 text-white px-3 py-1 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Last ⏭️
                </button>
              </div>
            </div>
          )}

          {/* Details Modal */}
          {showDetailsModal && selectedToken && (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
              <div className="bg-gray-800 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto">
                <div className="p-6">
                  <div className="flex items-center justify-between mb-6">
                    <h2 className="text-2xl font-bold text-white">
                      📊 {selectedToken.token_symbol} Details
                    </h2>
                    <button
                      onClick={() => setShowDetailsModal(false)}
                      className="text-gray-400 hover:text-white text-2xl"
                    >
                      ×
                    </button>
                  </div>

                  <div className="space-y-6">
                    {/* Basic Info */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="bg-gray-700 p-4 rounded-lg">
                        <h3 className="text-lg font-bold text-white mb-3">
                          Token Information
                        </h3>
                        <div className="space-y-2 text-sm">
                          <div>
                            <span className="text-gray-400">Symbol:</span>{" "}
                            <span className="text-white">
                              {selectedToken.token_symbol}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">Name:</span>{" "}
                            <span className="text-white">
                              {selectedToken.token_name}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">Address:</span>{" "}
                            <span className="text-white font-mono text-xs">
                              {selectedToken.token_address}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">Status:</span>{" "}
                            <span
                              className={`font-medium ${getStatusColor(selectedToken.status)}`}
                            >
                              {selectedToken.status.toUpperCase()}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="bg-gray-700 p-4 rounded-lg">
                        <h3 className="text-lg font-bold text-white mb-3">
                          Performance Metrics
                        </h3>
                        <div className="space-y-2 text-sm">
                          <div>
                            <span className="text-gray-400">
                              Initial Price:
                            </span>{" "}
                            <span className="text-white">
                              ${formatPrice(selectedToken.initial_price_usd)}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">Last Price:</span>{" "}
                            <span className="text-white">
                              ${formatPrice(selectedToken.last_price_usd)}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">Peak Price:</span>{" "}
                            <span className="text-white">
                              ${formatPrice(selectedToken.peak_price_usd)}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">Current Gain:</span>{" "}
                            <span
                              className={
                                selectedToken.current_gain_percentage >= 0
                                  ? "text-green-400"
                                  : "text-red-400"
                              }
                            >
                              {formatPercentage(
                                selectedToken.current_gain_percentage,
                              )}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">Peak Gain:</span>{" "}
                            <span
                              className={
                                selectedToken.peak_gain_percentage >= 0
                                  ? "text-green-400"
                                  : "text-red-400"
                              }
                            >
                              {formatPercentage(
                                selectedToken.peak_gain_percentage,
                              )}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Market Data */}
                    <div className="bg-gray-700 p-4 rounded-lg">
                      <h3 className="text-lg font-bold text-white mb-3">
                        Market Data
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                        <div>
                          <span className="text-gray-400">Market Cap:</span>{" "}
                          <span className="text-white">
                            {selectedToken.market_cap
                              ? `$${formatNumber(selectedToken.market_cap)}`
                              : "N/A"}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-400">Organic Score:</span>{" "}
                          <span className="text-white">
                            {selectedToken.organic_score?.toFixed(2) || "N/A"}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-400">Volume 1h:</span>{" "}
                          <span className="text-white">
                            {selectedToken.volume_1h
                              ? `$${formatNumber(selectedToken.volume_1h)}`
                              : "N/A"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Timing Information */}
                    <div className="bg-gray-700 p-4 rounded-lg">
                      <h3 className="text-lg font-bold text-white mb-3">
                        Timing Information
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="text-gray-400">Created:</span>{" "}
                          <span className="text-white">
                            {new Date(
                              selectedToken.created_at,
                            ).toLocaleString()}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-400">
                            Tracking Started:
                          </span>{" "}
                          <span className="text-white">
                            {new Date(
                              selectedToken.tracking_started_at,
                            ).toLocaleString()}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-400">Status Changed:</span>{" "}
                          <span className="text-white">
                            {selectedToken.status_changed_at
                              ? new Date(
                                  selectedToken.status_changed_at,
                                ).toLocaleString()
                              : "Still active"}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-400">Duration:</span>{" "}
                          <span className="text-white">
                            {formatDuration(
                              selectedToken.tracking_started_at,
                              selectedToken.status_changed_at,
                            )}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Trade Comparison Data */}
                    {selectedToken.trade_comparison_data && (
                      <div className="bg-gray-700 p-4 rounded-lg">
                        <h3 className="text-lg font-bold text-white mb-3">
                          Trade Comparison
                        </h3>
                        <div className="text-sm text-gray-300">
                          <pre className="whitespace-pre-wrap overflow-x-auto">
                            {JSON.stringify(
                              selectedToken.trade_comparison_data,
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                      </div>
                    )}

                    {/* Trading Simulation */}
                    {selectedToken.trading_simulation && (
                      <div className="bg-gray-700 p-4 rounded-lg">
                        <h3 className="text-lg font-bold text-white mb-3">
                          Trading Simulation
                        </h3>
                        <div className="text-sm text-gray-300">
                          <pre className="whitespace-pre-wrap overflow-x-auto">
                            {JSON.stringify(
                              selectedToken.trading_simulation,
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                      </div>
                    )}

                    {/* Price History Chart */}
                    {selectedToken.price_history &&
                      selectedToken.price_history.length > 0 && (
                        <div className="bg-gray-700 p-4 rounded-lg">
                          <h3 className="text-lg font-bold text-white mb-3">
                            Price History
                          </h3>
                          <div className="h-64">
                            <Line
                              data={{
                                labels: selectedToken.price_history.map(
                                  (record: any) => new Date(record.timestamp),
                                ),
                                datasets: [
                                  {
                                    label: "Price (USD)",
                                    data: selectedToken.price_history.map(
                                      (record: any) => record.price_usd,
                                    ),
                                    borderColor: "#10b981",
                                    backgroundColor: "rgba(16, 185, 129, 0.1)",
                                    borderWidth: 2,
                                    fill: true,
                                    tension: 0.4,
                                    pointBackgroundColor: "#10b981",
                                    pointBorderColor: "#ffffff",
                                    pointBorderWidth: 2,
                                    pointRadius: 4,
                                    pointHoverRadius: 6,
                                  },
                                ],
                              }}
                              options={{
                                responsive: true,
                                maintainAspectRatio: false,
                                plugins: {
                                  legend: {
                                    display: false,
                                  },
                                  tooltip: {
                                    backgroundColor: "rgba(0, 0, 0, 0.8)",
                                    titleColor: "#ffffff",
                                    bodyColor: "#ffffff",
                                    borderColor: "#374151",
                                    borderWidth: 1,
                                    callbacks: {
                                      label: function (context) {
                                        return `Price: $${formatPrice(context.parsed.y ?? 0)}`;
                                      },
                                    },
                                  },
                                },
                                scales: {
                                  x: {
                                    type: "time",
                                    time: {
                                      displayFormats: {
                                        minute: "HH:mm",
                                        hour: "MMM dd HH:mm",
                                        day: "MMM dd",
                                      },
                                    },
                                    grid: {
                                      color: "rgba(75, 85, 99, 0.3)",
                                    },
                                    ticks: {
                                      color: "#9ca3af",
                                      maxTicksLimit: 6,
                                    },
                                  },
                                  y: {
                                    grid: {
                                      color: "rgba(75, 85, 99, 0.3)",
                                    },
                                    ticks: {
                                      color: "#9ca3af",
                                      callback: function (value) {
                                        return "$" + formatPrice(Number(value));
                                      },
                                    },
                                  },
                                },
                                interaction: {
                                  intersect: false,
                                  mode: "index",
                                },
                              }}
                            />
                          </div>
                        </div>
                      )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Chart Buy Modal */}
          {chartModalTokenAddress && (
            <ChartBuyModal
              tokenAddress={chartModalTokenAddress}
              onClose={() => setChartModalTokenAddress(null)}
              onNavigate={(direction) => {
                if (!tokens.length) return;
                const currentIndex = tokens.findIndex(
                  (t) => t.token_address === chartModalTokenAddress,
                );
                if (currentIndex === -1) return;

                const nextIndex =
                  direction === "next" ? currentIndex + 1 : currentIndex - 1;
                if (nextIndex >= 0 && nextIndex < tokens.length) {
                  setChartModalTokenAddress(tokens[nextIndex].token_address);
                }
              }}
              hasPrev={
                tokens.findIndex(
                  (t) => t.token_address === chartModalTokenAddress,
                ) > 0
              }
              hasNext={
                tokens.findIndex(
                  (t) => t.token_address === chartModalTokenAddress,
                ) <
                tokens.length - 1
              }
            />
          )}

          {/* Unified Tracker Module removed to avoid duplication */}
        </div>
      </div>
    </div>
  );
}
