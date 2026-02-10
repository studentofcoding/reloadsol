"use client";

import React, { useState, useEffect } from "react";
import { TrackingRecord, TrackingStats } from "@/utils/trading-tracker";
import { useWallet } from "./WalletProvider";
import { useTradingData } from "./TradingDataProvider";
import TokenSkeleton from "./TokenSkeleton";
import { getSolPriceUSD } from "@/utils/solana";

export default function TradingHistory() {
  const { publicKey, connected } = useWallet();
  const {
    records: rawRecords,
    isLoadingRecords,
    deleteRecord,
  } = useTradingData();
  const [processedRecords, setProcessedRecords] = useState<TrackingRecord[]>(
    [],
  );
  const [stats, setStats] = useState<TrackingStats | null>(null);
  const [timeFilter, setTimeFilter] = useState<"all" | "24h" | "7d" | "30d">(
    "7d",
  );
  const [error, setError] = useState<string>("");
  const [isLocalStorageAvailable, setIsLocalStorageAvailable] =
    useState<boolean>(true);
  const [solPriceUsd, setSolPriceUsd] = useState<number>(145); // Default fallback

  // Check if localStorage is available
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        const testKey = "__localStorage_test__";
        localStorage.setItem(testKey, "test");
        localStorage.removeItem(testKey);
        setIsLocalStorageAvailable(true);
      } else {
        setIsLocalStorageAvailable(false);
      }
    } catch (e) {
      console.warn("localStorage is not available:", e);
      setIsLocalStorageAvailable(false);
      setError(
        "Browser storage is not available. Trading history will not be saved.",
      );
    }
  }, []);

  // Function to process raw records and stats
  const processRecords = React.useCallback(() => {
    if (!connected || !publicKey || !rawRecords) {
      setProcessedRecords([]);
      setStats(null);
      return;
    }

    try {
      // Get recent successful records only
      const successfulRecords = rawRecords.filter(
        (record) => record.successCount > 0,
      );

      // Process records to handle USDC conversion
      const processedForConversion = successfulRecords.map((record) => {
        // For buy operations, check if this might be a USDC purchase
        // USDC purchases typically have solAmount values that represent USDC amounts (not SOL)
        // We can identify them by checking if the solAmount seems too high for SOL (> 10 SOL is likely USDC)
        if (
          record.operationType === "buy" &&
          record.solAmount &&
          solPriceUsd > 0
        ) {
          // Heuristic: if solAmount > 10, it's likely USDC amount, not SOL
          // This is because most users don't spend more than 10 SOL per transaction
          const isLikelyUsdcPurchase = record.solAmount > 10;

          if (isLikelyUsdcPurchase) {
            const solEquivalentAmount = record.solAmount / solPriceUsd;
            console.log(
              `🔄 TradingHistory USDC conversion: ${record.solAmount} USDC → ${solEquivalentAmount.toFixed(6)} SOL (SOL price: $${solPriceUsd})`,
            );

            return {
              ...record,
              solAmount: solEquivalentAmount,
            };
          }
        }
        return record;
      });

      // Combine sell and close operations that happen within 30 seconds of each other
      const combinedRecords: TrackingRecord[] = [];
      const processedRecordIds = new Set<string>();

      processedForConversion.forEach((record: TrackingRecord) => {
        if (processedRecordIds.has(record.id)) return;

        if (record.operationType === "sell") {
          // Look for a close operation within 30 seconds
          const closeRecord = successfulRecords.find(
            (r: TrackingRecord) =>
              r.operationType === "close" &&
              !processedRecordIds.has(r.id) &&
              Math.abs(r.timestamp - record.timestamp) <= 30000, // 30 seconds
          );

          if (closeRecord) {
            // Combine sell and close into one record
            const combinedRecord: TrackingRecord = {
              ...record,
              operationType: "sell" as const, // Keep as 'sell' but it represents sell+close
              tokens: [...record.tokens, ...closeRecord.tokens].filter(
                (token, index, self) =>
                  index ===
                  self.findIndex((t) => t.mintAddress === token.mintAddress),
              ), // Remove duplicates
              successCount: record.successCount + closeRecord.successCount,
              failureCount: record.failureCount + closeRecord.failureCount,
              totalTokens: record.totalTokens + closeRecord.totalTokens,
              signatures: [...record.signatures, ...closeRecord.signatures],
              feesPaid: record.feesPaid + closeRecord.feesPaid,
              errors: [...(record.errors || []), ...(closeRecord.errors || [])],
            };

            combinedRecords.push(combinedRecord);
            processedRecordIds.add(record.id);
            processedRecordIds.add(closeRecord.id);
          } else {
            // No matching close operation, keep sell as is
            combinedRecords.push(record);
            processedRecordIds.add(record.id);
          }
        } else if (record.operationType === "close") {
          // Check if this close wasn't already combined with a sell
          const sellRecord = successfulRecords.find(
            (r: TrackingRecord) =>
              r.operationType === "sell" &&
              !processedRecordIds.has(r.id) &&
              Math.abs(r.timestamp - record.timestamp) <= 30000, // 30 seconds
          );

          if (!sellRecord) {
            // Standalone close operation
            combinedRecords.push(record);
            processedRecordIds.add(record.id);
          }
          // If there's a matching sell, it will be handled when we process the sell record
        } else {
          // Buy operations and others - keep as is
          combinedRecords.push(record);
          processedRecordIds.add(record.id);
        }
      });

      // Sort by timestamp (most recent first)
      combinedRecords.sort((a, b) => b.timestamp - a.timestamp);

      setProcessedRecords(combinedRecords);

      // Calculate stats including bot operations
      const buyCount = combinedRecords.filter(
        (r) => r.operationType === "buy",
      ).length;
      const sellCount = combinedRecords.filter(
        (r) => r.operationType === "sell",
      ).length;
      const closeCount = combinedRecords.filter(
        (r) => r.operationType === "close",
      ).length;
      const botOperationsCount = combinedRecords.filter(
        (r) => r.is_bot_operation,
      ).length;

      setStats({
        totalOperations: combinedRecords.length,
        totalBuys: buyCount,
        totalSells: sellCount,
        totalCloses: closeCount,
        totalSolSpent: combinedRecords
          .filter((r) => r.operationType === "buy")
          .reduce((sum, r) => sum + (r.solAmount || 0), 0),
        totalSolReceived: combinedRecords
          .filter((r) => r.operationType === "sell")
          .reduce((sum, r) => sum + (r.solAmount || 0), 0),
        totalFeesPaid: combinedRecords.reduce((sum, r) => sum + r.feesPaid, 0),
        totalTokensBought: combinedRecords
          .filter((r) => r.operationType === "buy")
          .reduce((sum, r) => sum + r.successCount, 0),
        totalTokensSold: combinedRecords
          .filter((r) => r.operationType === "sell")
          .reduce((sum, r) => sum + r.successCount, 0),
        totalAccountsClosed: combinedRecords
          .filter((r) => r.operationType === "close")
          .reduce((sum, r) => sum + r.successCount, 0),
        successRate:
          combinedRecords.length > 0
            ? (combinedRecords.reduce((sum, r) => sum + r.successCount, 0) /
                combinedRecords.reduce(
                  (sum, r) => sum + r.successCount + r.failureCount,
                  0,
                )) *
              100
            : 0,
      });
    } catch (err) {
      console.error("Error processing trading records:", err);
      setError("Failed to process trading history");
      setProcessedRecords([]);
      setStats(null);
    }
  }, [connected, publicKey, rawRecords, solPriceUsd]);

  // Fetch SOL price for USDC conversion
  const fetchSolPrice = React.useCallback(async () => {
    try {
      const price = await getSolPriceUSD();
      setSolPriceUsd(price);
    } catch (error) {
      console.error("Failed to fetch SOL price:", error);
    }
  }, []);

  // Fetch SOL price on component mount and periodically
  useEffect(() => {
    if (connected && publicKey) {
      fetchSolPrice();
      // Update price every 5 minutes
      const interval = setInterval(fetchSolPrice, 300000);
      return () => clearInterval(interval);
    }
  }, [connected, publicKey, fetchSolPrice]);

  // Process records when data changes
  useEffect(() => {
    processRecords();
  }, [processRecords]);

  // Enhanced operation icon with bot support
  const getOperationIcon = (type: string, isBot?: boolean, status?: string) => {
    const baseIcon =
      {
        buy: "🟢",
        sell: "🔴",
        close: "🟡",
        waiting: "⏳",
        tracking: "👁️",
        won: "🎉",
        lost: "💔",
        skipped: "⏭️",
      }[type] || "⚪";

    return isBot ? `🤖${baseIcon}` : baseIcon;
  };

  // Enhanced operation type display
  const getOperationTypeDisplay = (record: TrackingRecord) => {
    const baseType =
      record.operationType === "sell" &&
      record.totalTokens > record.tokens.length
        ? "sell & close"
        : record.operationType;

    return (
      <div className="flex items-center space-x-1">
        <span className="text-xs">
          {getOperationIcon(
            record.operationType,
            record.is_bot_operation,
            record.status,
          )}
        </span>
        <span className="capitalize">{baseType}</span>
      </div>
    );
  };

  // Enhanced bot operation indicator
  const BotOperationIndicator = ({ record }: { record: TrackingRecord }) => {
    if (!record.is_bot_operation) return null;

    return (
      <div className="flex items-center space-x-1">
        <span
          className="text-xs bg-purple-600/20 text-purple-400 px-1.5 py-0.5 rounded-full font-medium border border-purple-500/30"
          title={`Bot Strategy: ${record.bot_strategy || "auto"}`}
        >
          BOT
        </span>
        {record.bot_strategy && (
          <span
            className="text-xs text-gray-500"
            title={`Strategy: ${record.bot_strategy}`}
          >
            {record.bot_strategy.split("-")[0]}
          </span>
        )}
      </div>
    );
  };

  // Simulation indicator
  const SimulationIndicator = ({ record }: { record: TrackingRecord }) => {
    if (!record.is_simulation) return null;

    return (
      <div className="flex items-center space-x-1">
        <span
          className="text-xs bg-blue-600/20 text-blue-400 px-1.5 py-0.5 rounded-full font-medium border border-blue-500/30"
          title={`Simulation Type: ${record.simulation_type || "manual"}`}
        >
          SIM
        </span>
      </div>
    );
  };

  // Enhanced status indicator
  const StatusIndicator = ({ record }: { record: TrackingRecord }) => {
    if (!record.status || record.status === "tracking") return null;

    const statusColors = {
      waiting: "bg-yellow-600/20 text-yellow-400 border-yellow-500/30",
      won: "bg-green-600/20 text-green-400 border-green-500/30",
      lost: "bg-red-600/20 text-red-400 border-red-500/30",
      skipped: "bg-gray-600/20 text-gray-400 border-gray-500/30",
    };

    return (
      <span
        className={`text-xs px-1.5 py-0.5 rounded-full font-medium border ${statusColors[record.status as keyof typeof statusColors] || statusColors.skipped}`}
        title={`Status: ${record.status}`}
      >
        {record.status.toUpperCase()}
      </span>
    );
  };

  const formatRelativeTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
    if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    return `${days} day${days !== 1 ? "s" : ""} ago`;
  };

  const openTransactionOnSolscan = (signatures: string[]) => {
    if (signatures && signatures.length > 0) {
      // Open the first signature on Solscan
      const signature = signatures[0];
      const solscanUrl = `https://solscan.io/tx/${signature}`;
      window.open(solscanUrl, "_blank", "noopener,noreferrer");
    }
  };

  // Show error state
  if (error && error.includes("Browser storage")) {
    return (
      <div className="bg-gray-800 border border-gray-600 rounded-xl p-4 text-center">
        <p className="text-gray-400 text-sm">{error}</p>
      </div>
    );
  }

  // Show loading state
  if (isLoadingRecords) {
    return (
      <div className="">
        <TokenSkeleton count={5} variant="trading-history" />
      </div>
    );
  }

  return (
    <div className="">
      {/* Error Display */}
      {error && (
        <div className="bg-red-900/20 border border-red-600/30 rounded-xl p-3 mb-3 text-center">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Stats Summary */}
      {/* {stats && processedRecords.length > 0 && (
        <div className="mb-3 p-3 bg-gray-800/50 rounded-lg border border-gray-700">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="text-center">
              <div className="text-gray-400">Total Ops</div>
              <div className="font-medium">{stats.totalOperations}</div>
            </div>
            <div className="text-center">
              <div className="text-gray-400">Bot Ops</div>
              <div className="font-medium text-purple-400">
                {processedRecords.filter(r => r.is_bot_operation).length}
              </div>
            </div>
            <div className="text-center">
              <div className="text-gray-400">Success Rate</div>
              <div className="font-medium text-green-400">{stats.successRate.toFixed(1)}%</div>
            </div>
            <div className="text-center">
              <div className="text-gray-400">Total Fees</div>
              <div className="font-medium text-orange-400">{stats.totalFeesPaid.toFixed(4)} SOL</div>
            </div>
          </div>
        </div>
      )} */}

      {/* Horizontal Records List */}
      {connected && processedRecords.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-gray-400 text-sm">
            Trade on reloadsol to track your history
          </p>
        </div>
      ) : (
        <div className="flex space-x-2 overflow-x-auto mb-3 scrollbar-hide">
          {processedRecords.slice(0, 10).map((record: TrackingRecord) => (
            <div
              key={record.id}
              className={`relative flex-shrink-0 hover:bg-gray-700/40 transition-all duration-200 min-w-[100px] rounded-lg cursor-pointer group py-2 px-3 mr-2 border ${
                record.is_bot_operation
                  ? "border-purple-500/30 bg-purple-900/10"
                  : "border-gray-600/30"
              }`}
              onClick={() => openTransactionOnSolscan(record.signatures)}
              title="Click to view transaction on Solscan"
            >
              {/* Delete Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (
                    window.confirm(
                      "Are you sure you want to remove this record?",
                    )
                  ) {
                    deleteRecord(record.id);
                  }
                }}
                className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 p-1 bg-gray-800 text-gray-500 hover:text-red-400 border border-gray-600 hover:border-red-400/50 transition-all rounded-full shadow-lg z-10"
                title="Remove record"
              >
                <svg
                  className="w-3 h-3"
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

              {/* Header: Operation type and indicators */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center space-x-2">
                  {getOperationTypeDisplay(record)}
                  <BotOperationIndicator record={record} />
                  <SimulationIndicator record={record} />
                  <StatusIndicator record={record} />
                </div>

                {record.solAmount && record.solAmount > 0 && (
                  <span className="text-xs font-mono text-gray-300">
                    {record.solAmount.toFixed(4)} SOL
                  </span>
                )}
              </div>

              {/* Tokens display */}
              <div className="flex items-center space-x-2 mb-2">
                <div className="relative flex items-center">
                  {record.tokens
                    .slice(0, Math.min(record.successCount, 3))
                    .map((token: any, idx: number) => (
                      <div
                        key={idx}
                        className="w-4 h-4 bg-gray-700 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden border border-gray-600"
                        style={{ marginLeft: idx > 0 ? "-0.5rem" : "0" }}
                      >
                        {token.logoURI ? (
                          <img
                            src={token.logoURI}
                            alt={token.symbol || token.name || "Token"}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.currentTarget.onerror = null;
                              e.currentTarget.src = "";
                              const parent = e.currentTarget
                                .parentElement as HTMLElement | null;
                              if (parent) {
                                parent.textContent = (
                                  token.symbol ||
                                  token.name ||
                                  "?"
                                )
                                  .charAt(0)
                                  .toUpperCase();
                              }
                            }}
                          />
                        ) : (
                          (token.symbol || token.name || "?")
                            .charAt(0)
                            .toUpperCase()
                        )}
                      </div>
                    ))}
                </div>

                <div className="flex items-center space-x-1 flex-1 min-w-0">
                  {record.tokens
                    .slice(0, Math.min(record.successCount, 2))
                    .map((token: any, idx: number) => (
                      <span
                        key={idx}
                        className="text-xs text-gray-300 font-medium truncate"
                      >
                        {token.symbol || token.name || "Unknown"}
                        {idx < Math.min(record.successCount, 2) - 1 ? "," : ""}
                      </span>
                    ))}
                  {record.successCount > 2 && (
                    <span className="text-xs text-gray-400">
                      +{record.successCount - 2}
                    </span>
                  )}
                </div>
              </div>

              {/* Footer: Timestamp and external link */}
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>{formatRelativeTime(record.timestamp)}</span>
                <div className="flex items-center space-x-1">
                  {record.failureCount > 0 && (
                    <span className="text-red-400">
                      {record.failureCount} failed
                    </span>
                  )}
                  <svg
                    className="w-3 h-3 opacity-0 group-hover:opacity-60 transition-opacity duration-200"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
                  </svg>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
