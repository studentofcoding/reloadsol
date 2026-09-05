"use client";

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useCallback, useMemo, useState } from "react";
import { TrackingRecord, TrackingStats } from "@/utils/trading-tracker";
import { usePortfolioWallet } from "@/hooks/usePortfolioWallet";
import { useTradingData } from "./TradingDataProvider";
import { useWalletSession } from "./WalletSessionContext";
import WalletSignInPrompt from "./WalletSignInPrompt";
import TokenSkeleton from "./TokenSkeleton";
import { useSolPrice } from "@/hooks/useSolPrice";
import { useQuery } from "@tanstack/react-query";
import { RH_CHAIN_ID, txUrl } from "@/utils/dlmm/rh-clmm/config";
import {
  TRADE_LIST_SORT_OPTIONS,
  compareBySortMode,
  signedSolForHistoryRecord,
  type TradeListSortMode,
} from "@/utils/trade-list-sort";

function checkLocalStorageAvailable(): boolean {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const testKey = "__localStorage_test__";
      localStorage.setItem(testKey, "test");
      localStorage.removeItem(testKey);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function processTradingRecords(
  walletAddress: string | null,
  rawRecords: TrackingRecord[] | undefined,
  solPriceUsd: number,
  chain: "sol" | "robinhood" = "sol",
): { processedRecords: TrackingRecord[]; stats: TrackingStats | null } {
  if (!walletAddress || !rawRecords) {
    return { processedRecords: [], stats: null };
  }

  const successfulRecords = rawRecords.filter((record) => record.successCount > 0);
  const processedForConversion = successfulRecords.map((record) => {
    // Legacy sol quirk: some buys stored USD in solAmount. Skip on RH (amounts are ETH).
    if (
      chain === "sol" &&
      record.operationType === "buy" &&
      record.solAmount &&
      solPriceUsd > 0 &&
      record.solAmount > 10
    ) {
      return {
        ...record,
        solAmount: record.solAmount / solPriceUsd,
      };
    }
    return record;
  });

  const combinedRecords: TrackingRecord[] = [];
  const processedRecordIds = new Set<string>();

  processedForConversion.forEach((record: TrackingRecord) => {
    if (processedRecordIds.has(record.id)) return;

    if (record.operationType === "sell") {
      const closeRecord = successfulRecords.find(
        (r: TrackingRecord) =>
          r.operationType === "close" &&
          !processedRecordIds.has(r.id) &&
          Math.abs(r.timestamp - record.timestamp) <= 30000,
      );

      if (closeRecord) {
        const combinedTokens = [...record.tokens, ...closeRecord.tokens];
        combinedRecords.push({
          ...record,
          operationType: "sell" as const,
          tokens: combinedTokens.filter(
            (token, index, self) =>
              index ===
              self.findIndex((t) =>
                t.mintAddress?.startsWith("0x") ||
                token.mintAddress?.startsWith("0x")
                  ? t.mintAddress?.toLowerCase() ===
                    token.mintAddress?.toLowerCase()
                  : t.mintAddress === token.mintAddress,
              ),
          ),
          successCount: record.successCount + closeRecord.successCount,
          failureCount: record.failureCount + closeRecord.failureCount,
          totalTokens: record.totalTokens + closeRecord.totalTokens,
          signatures: [...record.signatures, ...closeRecord.signatures],
          feesPaid: record.feesPaid + closeRecord.feesPaid,
          errors: [...(record.errors || []), ...(closeRecord.errors || [])],
        });
        processedRecordIds.add(record.id);
        processedRecordIds.add(closeRecord.id);
      } else {
        combinedRecords.push(record);
        processedRecordIds.add(record.id);
      }
    } else if (record.operationType === "close") {
      const sellRecord = successfulRecords.find(
        (r: TrackingRecord) =>
          r.operationType === "sell" &&
          !processedRecordIds.has(r.id) &&
          Math.abs(r.timestamp - record.timestamp) <= 30000,
      );
      if (!sellRecord) {
        combinedRecords.push(record);
        processedRecordIds.add(record.id);
      }
    } else {
      combinedRecords.push(record);
      processedRecordIds.add(record.id);
    }
  });

  combinedRecords.sort((a, b) => b.timestamp - a.timestamp);

  const buyCount = combinedRecords.filter((r) => r.operationType === "buy").length;
  const sellCount = combinedRecords.filter((r) => r.operationType === "sell").length;
  const closeCount = combinedRecords.filter((r) => r.operationType === "close").length;

  return {
    processedRecords: combinedRecords,
    stats: {
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
    },
  };
}

export default function TradingHistory() {
  const { network, walletAddress } = usePortfolioWallet();
  const nativeUnit = network === "robinhood" ? "ETH" : "SOL";
  const { status: walletSessionStatus } = useWalletSession();
  const {
    records: rawRecords,
    isLoadingRecords,
    deleteRecord,
    recordsError,
  } = useTradingData();
  const [modeFilter, setModeFilter] = useState<"all" | "real" | "sim">("all");
  const [sortMode, setSortMode] = useState<TradeListSortMode>("date_desc");
  const [error, setError] = useState<string>("");
  const [isLocalStorageAvailable] = useState(() => checkLocalStorageAvailable());
  const { data: solPriceUsd = 145 } = useSolPrice(300_000);

  const { processedRecords, stats } = useMemo(
    () => processTradingRecords(walletAddress, rawRecords, solPriceUsd, network),
    [walletAddress, rawRecords, solPriceUsd, network],
  );

  const filteredRecords = useMemo(() => {
    const filtered =
      modeFilter === "all"
        ? processedRecords
        : processedRecords.filter((r) =>
            modeFilter === "sim" ? !!r.is_simulation : !r.is_simulation,
          );
    return [...filtered].sort((a, b) =>
      compareBySortMode(
        sortMode,
        a.timestamp,
        b.timestamp,
        signedSolForHistoryRecord(a),
        signedSolForHistoryRecord(b),
      ),
    );
  }, [processedRecords, modeFilter, sortMode]);

  const storageWarning = !isLocalStorageAvailable
    ? "Browser storage is not available. Trading history will not be saved."
    : "";
  const displayError = error || storageWarning;

  // Resolve missing token symbol/name/icon by mint so RH records (often saved
  // without a symbol when bought outside holdings) still display their token.
  const missingMetaMints = useMemo(() => {
    const mints = new Set<string>();
    for (const r of processedRecords) {
      for (const t of r.tokens ?? []) {
        if (!t.mintAddress) continue;
        if (!t.symbol && !t.name) mints.add(t.mintAddress);
      }
    }
    return Array.from(mints);
  }, [processedRecords]);

  const { data: tokenMetaMap } = useQuery({
    queryKey: ["history-token-meta", network, missingMetaMints.join(",")],
    queryFn: async (): Promise<Map<string, { symbol?: string; name?: string; logoURI?: string }>> => {
      const out = new Map<string, { symbol?: string; name?: string; logoURI?: string }>();
      if (missingMetaMints.length === 0) return out;
      // Robinhood tokens resolve via GMGN token search; Solana via Jupiter.
      const url =
        network === "robinhood"
          ? `/api/gmgn/token/search?chain=robinhood&query=`
          : `/api/trending/search?query=`;
      const settled = await Promise.allSettled(
        missingMetaMints.map(async (mint) => {
          const res = await fetch(url + encodeURIComponent(mint));
          if (!res.ok) return;
          const data = (await res.json()) as Array<{
            id?: string;
            address?: string;
            symbol?: string;
            name?: string;
            icon?: string;
          }>;
          const match = Array.isArray(data)
            ? data.find(
                (t) =>
                  t.id?.toLowerCase() === mint.toLowerCase() ||
                  t.address?.toLowerCase() === mint.toLowerCase(),
              )
            : null;
          if (match?.symbol || match?.name) {
            out.set(mint, {
              symbol: match.symbol || undefined,
              name: match.name || undefined,
              logoURI: match.icon || undefined,
            });
          }
        }),
      );
      settled.forEach((s) => {
        if (s.status === "rejected") {
          console.warn("History token meta lookup failed:", s.reason);
        }
      });
      return out;
    },
    enabled: missingMetaMints.length > 0,
    staleTime: 10 * 60 * 1000,
  });

  const metaOf = useCallback(
    (mint: string | undefined): { symbol?: string; name?: string; logoURI?: string } => {
      if (!mint) return {};
      const meta = tokenMetaMap?.get(mint);
      if (meta) return meta;
      // Case-insensitive fallback for EVM records (checksum vs lower storage).
      if (mint.startsWith("0x") && tokenMetaMap) {
        const lower = mint.toLowerCase();
        for (const [k, v] of tokenMetaMap) {
          if (k.toLowerCase() === lower) return v;
        }
      }
      return {};
    },
    [tokenMetaMap],
  );

  // Records whose stored token payload lacks symbol/icon are overlaid with
  // resolved metadata so cards show the actual token (RH buys especially).
  const enrichedRecords = useMemo(
    () =>
      filteredRecords.map((record) => {
        const tokens = (record.tokens ?? []).map((t) => {
          if (t.symbol && t.logoURI) return t;
          const meta = metaOf(t.mintAddress);
          return {
            ...t,
            symbol: t.symbol || meta.symbol || undefined,
            name: t.name || meta.name || undefined,
            logoURI: t.logoURI || meta.logoURI || undefined,
          };
        });
        return { ...record, tokens };
      }),
    [filteredRecords, metaOf],
  );

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

  const formatTokenAmount = (n: number) => {
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
    if (n >= 1) return n.toFixed(2);
    return n.toPrecision(3);
  };

  // A buy should show what token we bought (amount + symbol), not what we spent.
  const buyTokenLabel = (record: TrackingRecord): string | null => {
    if (record.operationType !== "buy") return null;
    const bought = record.tokens.filter(
      (t) => t.tokenAmount && t.tokenAmount > 0,
    );
    if (bought.length === 0) return null;
    const first = bought[0];
    const label = `+${formatTokenAmount(first.tokenAmount!)} ${first.symbol || first.name || "token"}`;
    return bought.length > 1 ? `${label} +${bought.length - 1}` : label;
  };

  const openTransactionOnExplorer = (signatures: string[]) => {
    if (signatures && signatures.length > 0) {
      const signature = signatures[0];
      const url =
        network === "robinhood"
          ? txUrl(RH_CHAIN_ID, signature)
          : `https://solscan.io/tx/${signature}`;
      window.open(url, "_blank", "noopener,noreferrer");
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

  if (
    network === "sol" &&
    walletAddress &&
    walletSessionStatus === "signing"
  ) {
    return (
      <div className="">
        <TokenSkeleton count={5} variant="trading-history" />
      </div>
    );
  }

  if (
    network === "sol" &&
    walletAddress &&
    walletSessionStatus === "error"
  ) {
    return (
      <WalletSignInPrompt title="Sign in to load trading history" />
    );
  }

  if (recordsError === "WALLET_SESSION_REQUIRED") {
    return <WalletSignInPrompt title="Sign in to load trading history" />;
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
              <div className="font-medium text-orange-400">{stats.totalFeesPaid.toFixed(4)} {nativeUnit}</div>
            </div>
          </div>
        </div>
      )} */}

      {/* All / Real / Sim filter + sort */}
      {walletAddress && processedRecords.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex space-x-1 bg-gray-800 rounded-lg p-1 w-fit">
            {(
              [
                { key: "all" as const, label: "All" },
                { key: "real" as const, label: "Real" },
                { key: "sim" as const, label: "Sim" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                onClick={() => setModeFilter(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all min-w-max ${
                  modeFilter === tab.key
                    ? "bg-blue-600 text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-700/50"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as TradeListSortMode)}
            className="bg-gray-800 border border-gray-600 rounded-md px-2 py-1.5 text-xs text-white focus:outline-none focus:border-gray-400"
            title={`PnL = signed ${nativeUnit} (sell +, buy −)`}
          >
            {TRADE_LIST_SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Horizontal Records List */}
      {walletAddress && processedRecords.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-gray-400 text-sm">
            Your completed buys and sells will appear here. Make a trade to start
            tracking your history.
          </p>
        </div>
      ) : enrichedRecords.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-gray-400 text-sm">
            {modeFilter === "all"
              ? "No history records yet."
              : `No ${modeFilter} history records. Switch to All to see every trade.`}
          </p>
        </div>
      ) : (
        <div className="flex space-x-2 overflow-x-auto mb-3 scrollbar-hide">
          {enrichedRecords.slice(0, 10).map((record: TrackingRecord) => (
            <div
              key={record.id}
              className={`relative flex-shrink-0 hover:bg-gray-700/40 transition-all duration-200 min-w-[100px] rounded-lg cursor-pointer group py-2 px-3 mr-2 border ${
                record.is_bot_operation 
                  ? 'border-purple-500/30 bg-purple-900/10' 
                  : 'border-gray-600/30'
              }`}
              onClick={() => openTransactionOnExplorer(record.signatures)}
              title={
                network === "robinhood"
                  ? "Click to view transaction on Blockscout"
                  : "Click to view transaction on Solscan"
              }
            > 
              {/* Delete Button */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm('Are you sure you want to remove this record?')) {
                    deleteRecord(record.id)
                  }
                }}
                className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 p-1 bg-gray-800 text-gray-500 hover:text-red-400 border border-gray-600 hover:border-red-400/50 transition-all rounded-full shadow-lg z-10"
                title="Remove record"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
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

                {(() => {
                  const boughtLabel = buyTokenLabel(record);
                  if (boughtLabel) {
                    return (
                      <span className="text-xs font-mono text-emerald-300">
                        {boughtLabel}
                      </span>
                    );
                  }
                  return record.solAmount && record.solAmount > 0 ? (
                    <span className="text-xs font-mono text-gray-300">
                      {record.solAmount.toFixed(4)} {nativeUnit}
                    </span>
                  ) : null;
                })()}
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
                          <OptimizedImage
                            src={token.logoURI}
                            alt={token.symbol || token.name || "Token"}
                            className="w-full h-full object-cover"
                            fallback={(token.symbol || token.name || "?")
                              .charAt(0)
                              .toUpperCase()}
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
                  {record.txStatus === "pending" ? (
                    <span className="flex items-center gap-1 text-amber-400">
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-400/30 border-t-amber-400" />
                      Confirming…
                    </span>
                  ) : record.txStatus === "failed" ? (
                    <span className="text-red-400">Failed</span>
                  ) : record.failureCount > 0 ? (
                    <span className="text-red-400">
                      {record.failureCount} failed
                    </span>
                  ) : null}
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
