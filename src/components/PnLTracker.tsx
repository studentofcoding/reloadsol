"use client";

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  TrackingRecord,
  fetchTokenPricesForTracking,
} from "@/utils/trading-tracker";
import { getGmgnKlineUrl } from "@/utils/gmgn";
import { useWallet, useConnection, useWalletAddress } from "./WalletProvider";
import { useTradingData } from "./TradingDataProvider";
import { useWalletSession } from "./WalletSessionContext";
import WalletSignInPrompt from "./WalletSignInPrompt";
import TokenSkeleton from "./TokenSkeleton";
import AlgoPositions from "./AlgoPositions";
import { fetchTokenMetadataBatch } from "@/utils/token-metadata-client";
import { getSolPriceUSD } from "@/utils/solana";
import {
  fetchUserTokens,
  executeBulkSellAlt,
  BulkSellRequest,
  UserToken,
  TokenToSell,
} from "@/utils/jupiter";
import {
  fetchJupiterPortfolio,
  mapPortfolioToUserTokens,
  resolveWalletTokenToSell,
} from "@/utils/jupiter-portfolio";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SwapQuote } from "@/types";
import { trackSell } from "@/utils/operations-api";
import { usePnLShare } from "@/hooks/usePnLShare";
import { useNotificationPermission } from "@/hooks/useNotificationPermission";
import { useSolPrice } from "@/hooks/useSolPrice";
import { useQuery } from "@tanstack/react-query";
import PnLShareModal from "./PnLShareModal";
import { pnlShareService } from "@/utils/pnl-share-service";
import { closeSimulationPosition } from "@/utils/simulation-trades";
import { requireSignAllTransactions } from "@/utils/wallet-signing";
import TradeOutcomeModal, { useTradeOutcome } from "./TradeOutcomeModal";

interface PnLRecord {
  id: string;
  mintAddress: string;
  symbol?: string;
  name?: string;
  logoURI?: string;
  buyTimestamp: number;
  sellTimestamp: number;
  buyPrice: number; // SOL price when bought
  sellPrice: number; // SOL price when sold
  solAmountBought: number; // SOL spent on buying (proportional for this sell)
  solAmountSold: number; // SOL received from selling
  pnlSOL: number; // Profit/Loss in SOL
  pnlUSD: number; // Profit/Loss in USD
  pnlPercentage: number; // Percentage gain/loss
  buySignatures: string[];
  sellSignatures: string[];
  isPartialSell: boolean; // New field to indicate if this was a partial sell
  sellTransactionId: string; // Unique ID for the sell transaction
  // New fields from API improvements
  status?: "waiting" | "tracking" | "won" | "lost" | "skipped";
  tradeComparisonData?: any; // Trade comparison result
  tradingSimulation?: any; // Trading simulation data
  priceHistory?: Array<{
    timestamp: string;
    price_usd: number;
    volume?: number;
  }>;
  // ✅ NEW: Bot operation fields
  isBotOperation?: boolean; // Whether this was a bot operation
  botStrategy?: string; // Bot strategy used
  jupiter_swap?: boolean;
  isSimulation?: boolean; // Whether this is a simulation
  simulationType?: string; // Type of simulation
}

interface OpenPosition {
  id: string;
  mintAddress: string;
  symbol?: string;
  name?: string;
  logoURI?: string;
  buyTimestamp: number;
  solAmountBought: number; // SOL spent on buying
  buySignatures: string[];
  isOpen: boolean; // Always true for open positions
  currentUsdValue?: number; // Current USD value of the position
  pnlPercentage?: number; // Current P&L percentage
  isLoadingPrice?: boolean; // Whether we're currently fetching the price
  buyPriceUsd?: number; // Buy price in USD
  buyTokenAmount?: number; // Amount of the bought token
  currentTokenPriceUsd?: number; // Current token price in USD
  actualWalletBalance?: number; // Actual balance in wallet
  walletTokenData?: UserToken; // Full wallet token data for selling
  // New fields from API improvements
  status?: "waiting" | "tracking" | "won" | "lost" | "skipped";
  waitingStartedAt?: string | null;
  waitingInitialPrice?: number | null;
  tradeComparisonData?: any; // Trade comparison result
  tradingSimulation?: any; // Trading simulation data
  priceHistory?: Array<{
    timestamp: string;
    price_usd: number;
    volume?: number;
  }>;
  // ✅ NEW: Bot operation fields
  isBotOperation?: boolean; // Whether this was a bot operation
  botStrategy?: string; // Bot strategy used
  jupiter_swap?: boolean;
  isSimulation?: boolean; // Whether this is a simulation
  simulationType?: string; // Type of simulation
}

const HOLDINGS_DUST_UI = 0.000001;

/** Real opens require a holdings balance; sims always kept. No local-trust fallback. */
function pruneOpenPositionsByHoldings(
  positions: OpenPosition[],
  walletTokens: UserToken[],
): OpenPosition[] {
  return positions.filter((pos) => {
    if (pos.isSimulation) return true;

    const walletTok = walletTokens.find(
      (wt) => wt.mintAddress === pos.mintAddress,
    );
    if (!walletTok || walletTok.uiAmount <= HOLDINGS_DUST_UI) return false;

    pos.actualWalletBalance = walletTok.uiAmount;
    pos.walletTokenData = walletTok;
    if (!pos.symbol) pos.symbol = walletTok.symbol;
    if (!pos.name) pos.name = walletTok.name;
    if (!pos.logoURI) pos.logoURI = walletTok.logoURI;
    return true;
  });
}

export default function PnLTracker() {
  const { publicKey, connected, signAllTransactions } = useWallet();
  const walletAddress = useWalletAddress();
  const { connection } = useConnection();
  const { status: walletSessionStatus } = useWalletSession();
  const { records, trackOperation, isLoadingRecords, recordsError } =
    useTradingData();
  const [pnlRecords, setPnlRecords] = useState<PnLRecord[]>([]);
  const [openPositions, setOpenPositions] = useState<OpenPosition[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const solPriceQuery = useSolPrice();
  const solPriceUsd = solPriceQuery.data ?? 145;
  const [activeTab, setActiveTab] = useState<"completed" | "open">("completed");
  const [modeFilter, setModeFilter] = useState<"all" | "real" | "sim">("all");
  const [showAlgoStrategies, setShowAlgoStrategies] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("pnl-show-algo-strategies") !== "false";
    }
    return true;
  });
  const [isRefreshingPrices, setIsRefreshingPrices] = useState<boolean>(false);

  // Fast sell state
  const [isSelling, setIsSelling] = useState<boolean>(false);
  const [sellError, setSellError] = useState<string>("");
  const [sellingTokenId, setSellingTokenId] = useState<string>("");

  // Token chart state
  const [selectedToken, setSelectedToken] = useState<string>("");
  const [isChartLoading, setIsChartLoading] = useState<boolean>(false);

  // ✅ NEW: Notification state
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(
    () => {
      if (typeof window !== "undefined") {
        return localStorage.getItem("pnl-notifications-enabled") === "true";
      }
      return false;
    },
  );
  const notificationPermission = useNotificationPermission();
  const [notificationThreshold, setNotificationThreshold] = useState<number>(
    () => {
      if (typeof window !== "undefined") {
        const saved = localStorage.getItem("pnl-notification-threshold");
        return saved ? parseFloat(saved) : 50;
      }
      return 50;
    },
  );
  const [notifiedTokens, setNotifiedTokens] = useState<Set<string>>(new Set());

  // ✅ NEW: Use the modular PnL sharing system
  const {
    shareData,
    isShareModalOpen,
    isGeneratingShare,
    showShareModal,
    hideShareModal,
    autoTriggerShare,
  } = usePnLShare();

  const { showOutcome, outcomeModalProps } = useTradeOutcome();

  // Hint message state
  const [showClosedPositionsHint, setShowClosedPositionsHint] =
    useState<boolean>(() => {
      if (typeof window !== "undefined") {
        const dismissed = localStorage.getItem("closedPositionsHintDismissed");
        return dismissed !== "true";
      }
      return true;
    });

  // Sell quote state
  const [sellQuotes, setSellQuotes] = useState<Map<string, SwapQuote>>(
    new Map(),
  );
  const [quotingTokenId, setQuotingTokenId] = useState<string>("");
  const [quoteTimeouts, setQuoteTimeouts] = useState<
    Map<string, NodeJS.Timeout>
  >(new Map());

  // ✅ NEW: Bot operation sync state
  const [lastBotSync, setLastBotSync] = useState<number>(0);
  const [isBotSyncActive, setIsBotSyncActive] = useState<boolean>(false);

  // ✅ NEW: P&L amount visibility state
  const [hiddenPnLAmounts, setHiddenPnLAmounts] = useState<Set<string>>(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("hidden-pnl-amounts");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    }
    return new Set();
  });

  // ✅ NEW: Global P&L visibility state
  const [globalPnLHidden, setGlobalPnLHidden] = useState<boolean>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("global-pnl-hidden") === "true";
    }
    return false;
  });

  // ✅ NEW: Multi-select and drag functionality state
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragEnd, setDragEnd] = useState<{ x: number; y: number } | null>(null);
  const [showBulkSellOverlay, setShowBulkSellOverlay] =
    useState<boolean>(false);
  const [isBulkSelling, setIsBulkSelling] = useState<boolean>(false);
  const [bulkSellError, setBulkSellError] = useState<string>("");

  // Helper function to check if element is within selection rectangle
  const isElementInSelection = useCallback(
    (
      elementRect: DOMRect,
      start: { x: number; y: number },
      end: { x: number; y: number },
    ) => {
      const selectionLeft = Math.min(start.x, end.x);
      const selectionRight = Math.max(start.x, end.x);
      const selectionTop = Math.min(start.y, end.y);
      const selectionBottom = Math.max(start.y, end.y);

      return (
        elementRect.left < selectionRight &&
        elementRect.right > selectionLeft &&
        elementRect.top < selectionBottom &&
        elementRect.bottom > selectionTop
      );
    },
    [],
  );

  // ✅ NEW: Drag selection handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left mouse button

    const rect = e.currentTarget.getBoundingClientRect();
    setDragStart({ x: e.clientX, y: e.clientY });
    setDragEnd({ x: e.clientX, y: e.clientY });
    setIsDragging(true);
    e.preventDefault();
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging || !dragStart) return;

      setDragEnd({ x: e.clientX, y: e.clientY });

      // Get all token elements within the selection rectangle
      const tokenElements = document.querySelectorAll("[data-token-address]");
      const newSelection = new Set<string>();

      tokenElements.forEach((element) => {
        const rect = element.getBoundingClientRect();
        const tokenId = element.getAttribute("data-token-address");

        if (
          tokenId &&
          isElementInSelection(rect, dragStart, { x: e.clientX, y: e.clientY })
        ) {
          const position = openPositions.find(
            (pos) => pos.mintAddress === tokenId,
          );
          if (position) {
            newSelection.add(position.id);
          }
        }
      });

      setSelectedTokens(newSelection);
    },
    [isDragging, dragStart, openPositions, isElementInSelection],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setDragStart(null);
    setDragEnd(null);
  }, []);

  // ✅ NEW: Clear selection helper
  const clearSelection = useCallback(() => {
    setSelectedTokens(new Set());
  }, []);

  // Handler to dismiss the hint message
  const handleDismissHint = useCallback(() => {
    setShowClosedPositionsHint(false);
    localStorage.setItem("pnl-closed-positions-hint-dismissed", "true");
  }, []);

  // Add this function for opening charts
  const handleOpenChart = useCallback(
    (mintAddress: string, symbol?: string) => {
      setSelectedToken(mintAddress);
      setIsChartLoading(true);
    },
    [],
  );

  // ✅ NEW: Check notification permission on mount — via useNotificationPermission hook

  // ✅ NEW: Request notification permission
  const requestNotificationPermission = useCallback(async () => {
    if (!("Notification" in window)) {
      console.warn("This browser does not support notifications");
      return false;
    }

    try {
      const permission = await Notification.requestPermission();
      return permission === "granted";
    } catch (error) {
      console.error("Error requesting notification permission:", error);
      return false;
    }
  }, []);

  // ✅ NEW: Toggle notifications
  const toggleNotifications = useCallback(async () => {
    console.log("🔔 Toggling notifications:", {
      currentState: notificationsEnabled,
      permission: notificationPermission,
    });

    if (!notificationsEnabled) {
      // Enabling notifications - request permission first
      console.log("🔔 Requesting notification permission...");
      const hasPermission =
        notificationPermission === "granted" ||
        (await requestNotificationPermission());

      if (hasPermission) {
        setNotificationsEnabled(true);
        localStorage.setItem("pnl-notifications-enabled", "true");
        console.log("✅ PnL notifications enabled successfully");

        // Test notification
        if (Notification.permission === "granted") {
          try {
            const testNotification = new Notification(
              "🔔 PnL Notifications Enabled",
              {
                body: "You will now receive notifications when your positions reach the threshold",
                icon: "/favicon.ico",
                tag: "pnl-test",
              },
            );
            setTimeout(() => testNotification.close(), 3000);
          } catch (error) {
            console.error("Error sending test notification:", error);
          }
        }
      } else {
        console.warn("❌ Notification permission denied");
        alert(
          "Please enable notifications in your browser settings to receive P&L alerts",
        );
      }
    } else {
      // Disabling notifications
      setNotificationsEnabled(false);
      localStorage.setItem("pnl-notifications-enabled", "false");
      setNotifiedTokens(new Set()); // Clear notified tokens when disabling
      console.log("🔕 PnL notifications disabled");
    }
  }, [
    notificationsEnabled,
    notificationPermission,
    requestNotificationPermission,
  ]);

  // ✅ NEW: Send browser notification
  const sendPnLNotification = useCallback(
    (position: OpenPosition, pnlPercentage: number) => {
      if (!notificationsEnabled || notificationPermission !== "granted") return;

      const tokenName = position.symbol || position.name || "Token";
      const isProfit = pnlPercentage > 0;
      const emoji = isProfit ? "🚀" : "📉";
      const direction = isProfit ? "up" : "down";

      const title = `${emoji} ${tokenName} ${direction} ${Math.abs(pnlPercentage).toFixed(1)}%`;
      const body = `Your ${tokenName} position is ${isProfit ? "gaining" : "losing"} ${Math.abs(pnlPercentage).toFixed(1)}%`;

      try {
        const notification = new Notification(title, {
          body,
          icon: position.logoURI || "/favicon.ico",
          badge: "/favicon.ico",
          tag: `pnl-${position.mintAddress}`, // Prevent duplicate notifications
          requireInteraction: isProfit && Math.abs(pnlPercentage) >= 100, // Require interaction for 100%+ gains
          silent: false,
        });

        // Auto-close notification after 10 seconds
        setTimeout(() => {
          notification.close();
        }, 10000);

        // Handle notification click - could open chart or focus window
        notification.onclick = () => {
          window.focus();
          handleOpenChart(position.mintAddress, position.symbol);
          notification.close();
        };

        console.log(
          `🔔 Sent notification for ${tokenName}: ${pnlPercentage.toFixed(1)}%`,
        );
      } catch (error) {
        console.error("Error sending notification:", error);
      }
    },
    [notificationsEnabled, notificationPermission, handleOpenChart],
  );

  // ✅ NEW: Clear notification flag for a specific token
  const clearNotificationFlag = useCallback((mintAddress: string) => {
    setNotifiedTokens((prev) => {
      const newSet = new Set(prev);
      // Remove all notification flags for this token (all percentage thresholds)
      Array.from(newSet).forEach((key) => {
        if (key.startsWith(`${mintAddress}-`)) {
          newSet.delete(key);
        }
      });
      return newSet;
    });
    console.log(`🔕 Cleared notification flags for token: ${mintAddress}`);
  }, []);

  // ✅ NEW: Toggle P&L amount visibility
  const togglePnLVisibility = useCallback(
    (tokenId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      setHiddenPnLAmounts((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(tokenId)) {
          newSet.delete(tokenId);
        } else {
          newSet.add(tokenId);
        }
        // Save to localStorage
        localStorage.setItem(
          "hidden-pnl-amounts",
          JSON.stringify(Array.from(newSet)),
        );
        return newSet;
      });
    },
    [],
  );

  // ✅ NEW: Toggle global P&L visibility
  const toggleGlobalPnLVisibility = useCallback(() => {
    setGlobalPnLHidden((prev) => {
      const newValue = !prev;
      localStorage.setItem("global-pnl-hidden", newValue.toString());
      return newValue;
    });
  }, []);

  // Calculate PnL records by matching buy and sell operations
  const calculatePnL = useCallback(async () => {
    if (!walletAddress) {
      setPnlRecords([]);
      setOpenPositions([]);
      return;
    }

    if (!connection) {
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const allRecords = records; // Use records from React Query

      // Get successful buy and sell records
      const buyRecords = allRecords.filter(
        (record) => record.operationType === "buy" && record.successCount > 0,
      );

      // Process sell records with sell+close combination logic similar to TradingHistory
      const allSellRecords = allRecords.filter(
        (record) => record.operationType === "sell" && record.successCount > 0,
      );

      // Apply the same sell+close combination logic as TradingHistory for consistency
      const processedSellRecords: TrackingRecord[] = [];
      const processedRecordIds = new Set<string>();

      allSellRecords.forEach((sellRecord) => {
        if (processedRecordIds.has(sellRecord.id)) return;

        // Look for a close operation within 30 seconds (same logic as TradingHistory)
        const closeRecord = allRecords.find(
          (r) =>
            r.operationType === "close" &&
            r.successCount > 0 &&
            !processedRecordIds.has(r.id) &&
            Math.abs(r.timestamp - sellRecord.timestamp) <= 30000, // 30 seconds
        );

        if (closeRecord) {
          // Combine sell and close into one record for P&L calculation
          const combinedRecord: TrackingRecord = {
            ...sellRecord,
            // Combine tokens but prioritize sell tokens for P&L calculation
            tokens: [...sellRecord.tokens, ...closeRecord.tokens].filter(
              (token, index, self) =>
                index ===
                self.findIndex((t) => t.mintAddress === token.mintAddress),
            ),
            successCount: sellRecord.successCount + closeRecord.successCount,
            totalTokens: sellRecord.totalTokens + closeRecord.totalTokens,
            signatures: [...sellRecord.signatures, ...closeRecord.signatures],
            // ✅ NEW: Preserve bot operation flags when combining records
            is_bot_operation:
              sellRecord.is_bot_operation || closeRecord.is_bot_operation,
            bot_strategy: sellRecord.bot_strategy || closeRecord.bot_strategy,
            // ✅ NEW: Preserve simulation flags
            is_simulation: sellRecord.is_simulation,
            simulation_type: sellRecord.simulation_type,
          };

          processedSellRecords.push(combinedRecord);
          processedRecordIds.add(sellRecord.id);
          processedRecordIds.add(closeRecord.id);
        } else {
          // No matching close operation, keep sell as is
          processedSellRecords.push(sellRecord);
          processedRecordIds.add(sellRecord.id);
        }
      });

      // NEW CYCLE-AWARE PnL CALCULATION ----------------------------------------------------
      // The legacy aggregation logic below mixes multiple buy/sell cycles of the same token
      // into a single position.  That causes a reopened position (buying again after a full
      // close) to inherit the previous PnL.  We now compute PnL on a per-cycle basis: once the
      // remaining token amount for a cycle reaches ~0 the cycle is considered closed and we
      // start a fresh one for any subsequent buys.
      {
        // Helper type for an open trade cycle
        type Cycle = {
          mintAddress: string;
          symbol?: string;
          name?: string;
          logoURI?: string;
          totalSolBought: number;
          totalSolSold: number;
          totalTokenBought: number;
          remainingTokenAmount: number;
          weightedBuyPriceUsd: number; // simple average for now
          weightedSellPriceUsd: number;
          buyCount: number;
          sellCount: number;
          buySignatures: string[];
          sellSignatures: string[];
          firstBuyTimestamp: number;
          // ✅ NEW: Track bot operation info
          isBotOperation: boolean;
          botStrategy?: string;
          isSimulation: boolean;
          simulationType?: string;
        };

        const allOpsUnsorted = [...buyRecords, ...processedSellRecords];
        allOpsUnsorted.sort((a, b) => a.timestamp - b.timestamp);

        const openCycles = new Map<string, Cycle>();
        const closedCycles: PnLRecord[] = [];

        const solPriceCache = solPriceUsd; // capture once

        // Iterate chronologically through all operations and build cycles
        for (const op of allOpsUnsorted) {
          const isBuy = op.operationType === "buy";
          const tokensInOp = op.tokens || [];

          // Guard – skip malformed records
          if (!op.solAmount || op.successCount === 0) continue;

          // Evenly distribute SOL across tokens in the operation (we usually have 1 token)
          const solPerToken = op.solAmount / op.successCount;

          for (const tkn of tokensInOp) {
            const mint = tkn.mintAddress;
            if (!mint) continue;

            const isSim = !!op.is_simulation;
            const cycleKey = `${mint}-${isSim ? "sim" : "real"}`;

            if (isBuy) {
              let cycle = openCycles.get(cycleKey);
              if (!cycle) {
                cycle = {
                  mintAddress: mint,
                  symbol: tkn.symbol,
                  name: tkn.name,
                  logoURI: tkn.logoURI,
                  totalSolBought: 0,
                  totalSolSold: 0,
                  totalTokenBought: 0,
                  remainingTokenAmount: 0,
                  weightedBuyPriceUsd: 0,
                  weightedSellPriceUsd: 0,
                  buyCount: 0,
                  sellCount: 0,
                  buySignatures: [],
                  sellSignatures: [],
                  firstBuyTimestamp: op.timestamp,
                  // ✅ NEW: Initialize bot operation tracking
                  isBotOperation: !!op.is_bot_operation,
                  botStrategy: op.bot_strategy,
                  // ✅ NEW: Initialize simulation tracking
                  isSimulation: isSim,
                  simulationType: op.simulation_type,
                };
                openCycles.set(cycleKey, cycle);
              }

              const solForToken = tkn.solAmount ?? solPerToken;
              const solPrice =
                op.solPriceUsd ?? tkn.solPrice ?? solPriceCache;
              let tokenAmt = tkn.tokenAmount || 0;
              if (
                tokenAmt === 0 &&
                solForToken > 0 &&
                tkn.priceUsd &&
                solPrice > 0
              ) {
                tokenAmt = (solForToken * solPrice) / tkn.priceUsd;
              }
              cycle.totalSolBought += solPerToken;
              cycle.totalTokenBought += tokenAmt;
              cycle.remainingTokenAmount += tokenAmt;
              if (tkn.priceUsd) {
                // simple running average
                cycle.weightedBuyPriceUsd =
                  (cycle.weightedBuyPriceUsd * cycle.buyCount + tkn.priceUsd) /
                  (cycle.buyCount + 1);
              }
              cycle.buyCount += 1;
              cycle.buySignatures.push(...op.signatures);

              // ✅ NEW: Update bot operation info if this is a bot operation
              if (op.is_bot_operation) {
                cycle.isBotOperation = true;
                cycle.botStrategy = op.bot_strategy || cycle.botStrategy;
              }
            } else {
              // SELL branch
              let cycle = openCycles.get(cycleKey);
              if (!cycle) {
                // sell without open cycle (shouldn't happen) – skip
                continue;
              }

              const tokenAmt = tkn.tokenAmount || 0;
              let deducted = tokenAmt;
              if (op.is_simulation && op.close_position) {
                deducted = cycle.remainingTokenAmount;
              } else if (
                op.is_simulation &&
                tokenAmt >= cycle.remainingTokenAmount * 0.99
              ) {
                deducted = cycle.remainingTokenAmount;
              }

              cycle.totalSolSold += solPerToken;
              cycle.remainingTokenAmount = Math.max(
                0,
                cycle.remainingTokenAmount - deducted,
              );
              if (tkn.priceUsd) {
                cycle.weightedSellPriceUsd =
                  (cycle.weightedSellPriceUsd * cycle.sellCount +
                    tkn.priceUsd) /
                  (cycle.sellCount + 1);
              }
              cycle.sellCount += 1;
              cycle.sellSignatures.push(...op.signatures);

              // ✅ NEW: Update bot operation info if this is a bot operation
              if (op.is_bot_operation) {
                cycle.isBotOperation = true;
                cycle.botStrategy = op.bot_strategy || cycle.botStrategy;
              }

              // If the cycle is fully closed, compute PnL record and remove from open map
              if (cycle.remainingTokenAmount <= 1e-6) {
                const pnlSOL = cycle.totalSolSold - cycle.totalSolBought;
                const pnlUSD = pnlSOL * solPriceCache;
                const pnlPerc =
                  cycle.totalSolBought > 0
                    ? (pnlSOL / cycle.totalSolBought) * 100
                    : 0;

                const pnlRecord: PnLRecord = {
                  id: `${mint}-${cycle.firstBuyTimestamp}-${op.timestamp}`,
                  mintAddress: mint,
                  symbol: cycle.symbol,
                  name: cycle.name,
                  logoURI: cycle.logoURI,
                  buyTimestamp: cycle.firstBuyTimestamp,
                  sellTimestamp: op.timestamp,
                  buyPrice: cycle.weightedBuyPriceUsd,
                  sellPrice: cycle.weightedSellPriceUsd,
                  solAmountBought: cycle.totalSolBought,
                  solAmountSold: cycle.totalSolSold,
                  pnlSOL,
                  pnlUSD,
                  pnlPercentage: pnlPerc,
                  buySignatures: cycle.buySignatures,
                  sellSignatures: cycle.sellSignatures,
                  isPartialSell: false,
                  sellTransactionId: `${mint}-${op.timestamp}`,
                  // ✅ NEW: Include bot operation info in PnL records
                  isBotOperation: cycle.isBotOperation,
                  botStrategy: cycle.botStrategy,
                  // ✅ NEW: Include simulation info
                  isSimulation: cycle.isSimulation,
                  simulationType: cycle.simulationType,
                };

                closedCycles.push(pnlRecord);

                openCycles.delete(cycleKey);
              }
            }
          }
        }

        // Build open positions array - optimistic initialization from local tracking
        let openPositionsResult: OpenPosition[] = Array.from(
          openCycles.values(),
        ).map((cycle) => ({
          id: `open-${cycle.mintAddress}-${cycle.isSimulation ? "sim" : "real"}`,
          mintAddress: cycle.mintAddress,
          symbol: cycle.symbol,
          name: cycle.name,
          logoURI: cycle.logoURI,
          buyTimestamp: cycle.firstBuyTimestamp,
          solAmountBought: cycle.totalSolBought,
          buySignatures: cycle.buySignatures,
          isOpen: true,
          buyPriceUsd: cycle.weightedBuyPriceUsd,
          buyTokenAmount: cycle.totalTokenBought,
          actualWalletBalance: cycle.remainingTokenAmount,
          // ✅ NEW: Include bot operation info in open positions
          isBotOperation: cycle.isBotOperation,
          botStrategy: cycle.botStrategy,
          // ✅ NEW: Include simulation info
          isSimulation: cycle.isSimulation,
          simulationType: cycle.simulationType,
        }));

        if (openCycles.size > 0) {
          try {
            // Prefer Jupiter Portfolio (same as /sell) so Token-2022 / portfolio
            // holdings attach for Fast Sell; RPC fetchUserTokens as fallback.
            let walletTokens: UserToken[] = [];
            try {
              const portfolio = await fetchJupiterPortfolio(
                publicKey!.toString(),
              );
              walletTokens = mapPortfolioToUserTokens(portfolio);
            } catch (portfolioErr) {
              console.warn(
                "Jupiter portfolio unavailable for open positions, falling back to RPC",
                portfolioErr,
              );
              walletTokens = await fetchUserTokens(
                connection,
                publicKey!,
                false,
                false,
              );
            }

            // Holdings are source of truth for real opens (drop ghost / sold tokens)
            openPositionsResult = pruneOpenPositionsByHoldings(
              openPositionsResult,
              walletTokens,
            );

            // ✅ NEW: Add any tokens found in wallet but NOT in open cycles (e.g. bought by bot or outside app)
            const trackedMints = new Set(
              openPositionsResult.map((p) => p.mintAddress),
            );

            walletTokens.forEach((wt) => {
              // Add if not already tracked and has balance
              // We use a lower threshold here to ensure we capture even small bot positions
              if (!trackedMints.has(wt.mintAddress) && wt.uiAmount > 0) {
                // Create a new untracked open position
                openPositionsResult.push({
                  id: `open-${wt.mintAddress}`,
                  mintAddress: wt.mintAddress,
                  symbol: wt.symbol || "Unknown",
                  name: wt.name || "Unknown Token",
                  logoURI: wt.logoURI,
                  buyTimestamp: Date.now(), // Show as recent
                  solAmountBought: 0, // Unknown
                  buySignatures: [],
                  isOpen: true,
                  buyPriceUsd: 0, // Unknown
                  buyTokenAmount: wt.uiAmount,
                  actualWalletBalance: wt.uiAmount,
                  walletTokenData: wt,
                  isBotOperation: false, // Mark as external
                  botStrategy: "External",
                });
              }
            });
          } catch (walletErr) {
            console.error(
              "Failed fetching wallet tokens for verification, showing tracked positions",
              walletErr,
            );
            // On error, we keep the optimistic list (better to show stale data than nothing)
          }
        }

        closedCycles.sort((a, b) => {
          // Sort by P&L percentage (highest positive first)
          return (b.pnlPercentage || 0) - (a.pnlPercentage || 0);
        });

        openPositionsResult.sort((a, b) => {
          // First, prioritize positions with calculated P&L
          const aHasPnL = a.pnlPercentage !== undefined;
          const bHasPnL = b.pnlPercentage !== undefined;

          if (aHasPnL && !bHasPnL) return -1;
          if (!aHasPnL && bHasPnL) return 1;

          // If both have P&L, sort by percentage (highest positive first)
          if (aHasPnL && bHasPnL) {
            return (b.pnlPercentage || 0) - (a.pnlPercentage || 0);
          }

          // If neither has P&L, sort by timestamp (newest first)
          return b.buyTimestamp - a.buyTimestamp;
        });

        // Update state and exit this calculation early – legacy logic below is skipped
        setPnlRecords(closedCycles);
        setOpenPositions(openPositionsResult);
        setIsLoading(false);
        return; // <––    EARLY EXIT  (legacy aggregation will be skipped)
      }
    } catch (err) {
      console.error("Error calculating PnL:", err);
      setError("Failed to calculate PnL data");
      setPnlRecords([]);
      setOpenPositions([]);
    } finally {
      setIsLoading(false);
    }
  }, [walletAddress, records, solPriceUsd, connection, publicKey]);

  const recordsKey = useMemo(
    () => records.map((r) => `${r.id}:${r.timestamp}`).join("|"),
    [records],
  );

  const { refetch: refetchPnL } = useQuery({
    queryKey: ["pnl-calc", walletAddress, recordsKey, solPriceUsd],
    queryFn: async () => {
      await calculatePnL();
      return true;
    },
    enabled: !!walletAddress,
  });

  // Resolve missing token symbols/icons in one batch call
  const missingMetaMints = useMemo(() => {
    const mints = new Set<string>();
    for (const r of pnlRecords) {
      if (!r.symbol || !r.logoURI) mints.add(r.mintAddress);
    }
    for (const p of openPositions) {
      if (!p.symbol || !p.logoURI) mints.add(p.mintAddress);
    }
    return Array.from(mints);
  }, [pnlRecords, openPositions]);

  const { data: tokenMetaMap } = useQuery({
    queryKey: ["pnl-token-meta", missingMetaMints.join(",")],
    queryFn: () => fetchTokenMetadataBatch(missingMetaMints),
    enabled: missingMetaMints.length > 0,
    staleTime: 10 * 60 * 1000,
  });

  const displayRecords = useMemo(
    () =>
      pnlRecords.map((r) => {
        const meta = tokenMetaMap?.get(r.mintAddress);
        if (!meta) return r;
        return {
          ...r,
          symbol: r.symbol || meta.symbol || undefined,
          name: r.name || meta.name || undefined,
          logoURI: r.logoURI || meta.logoURI || undefined,
        };
      }),
    [pnlRecords, tokenMetaMap],
  );

  const displayOpenPositions = useMemo(
    () =>
      openPositions.map((p) => {
        const meta = tokenMetaMap?.get(p.mintAddress);
        if (!meta) return p;
        return {
          ...p,
          symbol: p.symbol || meta.symbol || undefined,
          name: p.name || meta.name || undefined,
          logoURI: p.logoURI || meta.logoURI || undefined,
        };
      }),
    [openPositions, tokenMetaMap],
  );

  const filteredDisplayRecords = useMemo(() => {
    if (modeFilter === "all") return displayRecords;
    return displayRecords.filter((r) =>
      modeFilter === "sim" ? !!r.isSimulation : !r.isSimulation,
    );
  }, [displayRecords, modeFilter]);

  const filteredDisplayOpenPositions = useMemo(() => {
    if (modeFilter === "all") return displayOpenPositions;
    return displayOpenPositions.filter((p) =>
      modeFilter === "sim" ? !!p.isSimulation : !p.isSimulation,
    );
  }, [displayOpenPositions, modeFilter]);

  // ✅ NEW: Toggle token selection for bulk sell
  const toggleTokenSelection = useCallback(
    (tokenId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      setSelectedTokens((prev) => {
        const newSet = new Set(prev);
        if (newSet.has(tokenId)) {
          newSet.delete(tokenId);
        } else {
          newSet.add(tokenId);
        }
        return newSet;
      });
    },
    [],
  );

  // ✅ NEW: Select all tokens (filtered open list)
  const selectAllTokens = useCallback(() => {
    setSelectedTokens(
      new Set(filteredDisplayOpenPositions.map((pos) => pos.id)),
    );
  }, [filteredDisplayOpenPositions]);

  // ✅ NEW: Clear all selections
  const clearAllSelections = useCallback(() => {
    setSelectedTokens(new Set());
  }, []);

  // ✅ NEW: Handle bulk sell
  const handleBulkSell = useCallback(async () => {
    if (!connected || !publicKey || selectedTokens.size === 0) {
      setBulkSellError("Please connect your wallet and select tokens to sell");
      return;
    }

    const positionsToSell = openPositions.filter((pos) =>
      selectedTokens.has(pos.id),
    );
    const hasRealPositions = positionsToSell.some((pos) => !pos.isSimulation);

    if (hasRealPositions && !signAllTransactions) {
      setBulkSellError("Wallet signing is required to sell on-chain positions");
      return;
    }

    if (hasRealPositions && !connection) {
      setBulkSellError("RPC connection not ready");
      return;
    }

    setIsBulkSelling(true);
    setBulkSellError("");

    try {
      // Get selected positions
      const positionsToSell = openPositions.filter((pos) =>
        selectedTokens.has(pos.id),
      );

      if (positionsToSell.length === 0) {
        throw new Error("No valid positions selected for selling");
      }

      const simPositions = positionsToSell.filter((pos) => pos.isSimulation);
      const realPositions = positionsToSell.filter((pos) => !pos.isSimulation);

      let totalSimSolReceived = 0;
      for (const position of simPositions) {
        const { solReceived } = await closeSimulationPosition({
          walletAddress: publicKey.toString(),
          mintAddress: position.mintAddress,
          records,
          trackOperation,
          symbol: position.symbol,
          name: position.name,
          logoURI: position.logoURI,
          sellPriceUsd: position.currentTokenPriceUsd,
        });
        totalSimSolReceived += solReceived;
        clearNotificationFlag(position.mintAddress);
      }

      if (realPositions.length === 0) {
        setSelectedTokens(new Set());
        setShowBulkSellOverlay(false);
        setBulkSellError("");
        showOutcome({
          success: true,
          operation: "sell",
          isSimulation: true,
          tokenSymbol:
            simPositions.length === 1
              ? simPositions[0].symbol || simPositions[0].name
              : `${simPositions.length} simulation positions`,
          mintAddress:
            simPositions.length === 1 ? simPositions[0].mintAddress : undefined,
          solAmount: totalSimSolReceived,
        });
        return;
      }

      if (!connection) {
        throw new Error("RPC connection not ready");
      }

      const balanceBeforeOp = await connection.getBalance(publicKey);
      const balanceBeforeSOL = balanceBeforeOp / LAMPORTS_PER_SOL;

      // Prepare tokens for bulk sell (real positions only)
      const tokensToSell: TokenToSell[] = [];

      for (const position of realPositions) {
        if (
          !position.walletTokenData ||
          position.walletTokenData.uiAmount <= 0
        ) {
          console.warn(
            `Skipping ${position.symbol}: No wallet data or zero balance`,
          );
          continue;
        }

        tokensToSell.push({
          ...position.walletTokenData,
          sellAmount: position.walletTokenData.balance,
          sellPercentage: 100,
        });
      }

      if (tokensToSell.length === 0) {
        throw new Error("No tokens available for selling");
      }

      console.log(`💰 Bulk selling ${tokensToSell.length} tokens...`);

      // Prepare bulk sell request with optimized settings
      const sellRequest: BulkSellRequest = {
        tokens: tokensToSell,
        slippage: 300, // 3% slippage
        priorityFee: 30000, // 0.0003 SOL priority fee
      };

      // Execute bulk sell using the more efficient executeBulkSellAlt
      const signTx = requireSignAllTransactions(
        signAllTransactions,
        "Wallet signing is required to sell on-chain positions",
      );
      const sellResult = await executeBulkSellAlt(
        sellRequest,
        publicKey.toString(),
        connection,
        signTx,
      );

      // Get balance after operation for better tracking
      const balanceAfterOp = await connection.getBalance(publicKey);
      const balanceAfterSOL = balanceAfterOp / LAMPORTS_PER_SOL;

      console.log(
        `💰 Bulk sell balance change: ${(balanceAfterSOL - balanceBeforeSOL).toFixed(6)} SOL`,
      );

      if (sellResult.success && sellResult.successfulSwaps.length > 0) {
        // Clear notification flags for sold tokens
        positionsToSell.forEach((position) => {
          if (!position.isSimulation) {
            clearNotificationFlag(position.mintAddress);
          }
        });

        // Track the successful bulk sell operation
        try {
          const trackResult = await trackSell(
            publicKey.toString(),
            sellResult.successfulSwaps.length,
            {
              failureCount: sellResult.failedSwaps.length,
              solAmount: sellResult.totalReceived || 0,
              tokenMints: positionsToSell.map((pos) => pos.mintAddress),
              signatures: sellResult.signatures,
            },
          );
          console.log(
            `🎉 Earned ${trackResult.pointsEarned} points from bulk sell!`,
          );
        } catch (trackError) {
          console.error(
            "Failed to track bulk sell operation for points:",
            trackError,
          );
        }

        // Track operations for PnL and history
        try {
          const tokenMints = realPositions.map((pos) => pos.mintAddress);
          const tokenPrices = await fetchTokenPricesForTracking(tokenMints);
          const currentSolPrice = await getSolPriceUSD();

          // Track each sold token
          for (const position of realPositions) {
            const enhancedTokenData = {
              mintAddress: position.mintAddress,
              symbol: position.symbol,
              name: position.name,
              logoURI: position.logoURI,
              priceUsd: tokenPrices[position.mintAddress] || 0,
              tokenAmount: position.walletTokenData?.balance || 0,
              solPrice: currentSolPrice,
            };

            await trackOperation({
              walletAddress: publicKey.toString(),
              operationType: "sell",
              tokens: [enhancedTokenData],
              successCount: 1,
              failureCount: 0,
              totalTokens: 1,
              solAmount:
                (sellResult.totalReceived || 0) /
                sellResult.successfulSwaps.length, // Approximate per token
              feesPaid: 0,
              solPriceUsd: currentSolPrice,
              totalUsdValue: currentSolPrice
                ? ((sellResult.totalReceived || 0) /
                    sellResult.successfulSwaps.length) *
                  currentSolPrice
                : undefined,
              signatures: sellResult.signatures,
              slippage: 3,
              priorityFee: 30000,
              errors: undefined,
            });
          }
        } catch (trackError) {
          console.error("Failed to track bulk sell operations:", trackError);
          // Fallback: manual refresh
          setTimeout(() => {
            calculatePnL();
          }, 200);
        }

        // Clear selections and close overlay
        setSelectedTokens(new Set());
        setShowBulkSellOverlay(false);
        setBulkSellError("");

        console.log(
          `✅ Bulk sell completed: ${sellResult.successfulSwaps.length} successful, ${sellResult.failedSwaps.length} failed`,
        );

        showOutcome({
          success: true,
          operation: "sell",
          isSimulation: false,
          tokenSymbol:
            realPositions.length === 1
              ? realPositions[0].symbol || realPositions[0].name
              : `${realPositions.length} tokens`,
          solAmount: sellResult.totalReceived || 0,
        });
      } else {
        throw new Error(
          `Bulk sell failed: ${sellResult.failedSwaps[0]?.error || "Unknown error"}`,
        );
      }
    } catch (err) {
      console.error("Bulk sell error:", err);
      const message =
        err instanceof Error ? err.message : "Failed to execute bulk sell";
      setBulkSellError(message);
      showOutcome({
        success: false,
        operation: "sell",
        isSimulation: positionsToSell.every((p) => p.isSimulation),
        error: message,
      });
    } finally {
      setIsBulkSelling(false);
    }
  }, [
    connected,
    publicKey,
    signAllTransactions,
    connection,
    selectedTokens,
    openPositions,
    records,
    clearNotificationFlag,
    trackOperation,
    calculatePnL,
    showOutcome,
  ]);

  // ✅ NEW: Check for notification-worthy positions
  const checkForNotifications = useCallback(() => {
    console.log("🔔 Checking notifications:", {
      notificationsEnabled,
      connected,
      openPositionsCount: openPositions.length,
      notificationPermission,
      notificationThreshold,
    });

    if (!notificationsEnabled || !connected) {
      console.log("🔕 Notifications disabled or not connected");
      return;
    }

    if (notificationPermission !== "granted") {
      console.log(
        "🔕 Notification permission not granted:",
        notificationPermission,
      );
      return;
    }

    let checkedPositions = 0;
    let notifiablePositions = 0;

    openPositions.forEach((position) => {
      checkedPositions++;

      if (position.pnlPercentage === undefined) {
        console.log(
          `⏳ Position ${position.symbol || "Unknown"} has no P&L yet`,
        );
        return;
      }

      const pnlAbs = Math.abs(position.pnlPercentage);
      const tokenKey = `${position.mintAddress}-${Math.floor(pnlAbs / 10) * 10}`;

      console.log(
        `📊 Position ${position.symbol || "Unknown"}: ${position.pnlPercentage.toFixed(1)}%, threshold: ${notificationThreshold}%, already notified: ${notifiedTokens.has(tokenKey)}`,
      );

      // Check if this position exceeds the threshold and hasn't been notified recently
      if (pnlAbs >= notificationThreshold && !notifiedTokens.has(tokenKey)) {
        notifiablePositions++;
        console.log(
          `🚨 Sending notification for ${position.symbol || "Unknown"}: ${position.pnlPercentage.toFixed(1)}%`,
        );

        sendPnLNotification(position, position.pnlPercentage);

        // Mark as notified
        setNotifiedTokens((prev) => new Set(prev).add(tokenKey));

        // Clear notification flag after 30 minutes to allow re-notification
        setTimeout(
          () => {
            setNotifiedTokens((prev) => {
              const newSet = new Set(prev);
              newSet.delete(tokenKey);
              return newSet;
            });
          },
          30 * 60 * 1000,
        ); // 30 minutes
      }
    });

    console.log(
      `🔔 Notification check complete: ${checkedPositions} positions checked, ${notifiablePositions} notifications sent`,
    );
  }, [
    notificationsEnabled,
    connected,
    openPositions,
    notificationThreshold,
    notifiedTokens,
    sendPnLNotification,
    notificationPermission,
  ]);

  // ✅ NEW: Monitor positions for notifications
  useEffect(() => {
    if (notificationsEnabled && openPositions.length > 0) {
      // Add a small delay to ensure P&L calculations are complete
      const timeoutId = setTimeout(() => {
        checkForNotifications();
      }, 1000); // 1 second delay

      return () => clearTimeout(timeoutId);
    }
  }, [checkForNotifications, notificationsEnabled, openPositions]);

  const BotOperationIndicator = ({
    isBotOperation,
    botStrategy,
  }: {
    isBotOperation?: boolean;
    botStrategy?: string;
  }) => {
    if (!isBotOperation) return null;

    return (
      <div className="flex items-center gap-1 text-xs">
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
          🤖 Bot
        </span>
        {botStrategy && (
          <span className="text-gray-500 dark:text-gray-400">
            {botStrategy}
          </span>
        )}
      </div>
    );
  };

  const JupiterSwapIndicator = ({
    isJupiterSwap,
  }: {
    isJupiterSwap?: boolean;
  }) => {
    if (!isJupiterSwap) return null;

    return (
      <div className="flex items-center gap-1 text-xs">
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
          ⚡ Jupiter
        </span>
      </div>
    );
  };

  const SimulationIndicator = ({
    isSimulation,
    simulationType,
  }: {
    isSimulation?: boolean;
    simulationType?: string;
  }) => {
    if (!isSimulation) return null;

    return (
      <div className="flex items-center gap-1 text-xs">
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200">
          🎮 SIM
        </span>
        {simulationType && (
          <span className="text-gray-500 dark:text-gray-400">
            {simulationType}
          </span>
        )}
      </div>
    );
  };

  // Hint dismissal persisted via lazy useState initializer above

  // Clear old localStorage data on component mount
  useEffect(() => {
    console.log(
      "🧹 PnLTracker: Cleared old localStorage data, now using Supabase!",
    );
  }, []);

  // ✅ NEW: Bot operation sync polling
  useEffect(() => {
    if (!connected || !publicKey) return;

    const walletAddress = publicKey.toString();
    let syncInterval: NodeJS.Timeout;

    const checkForBotUpdates = async () => {
      try {
        const response = await fetch(
          `/api/trading/sync?wallet=${encodeURIComponent(walletAddress)}`,
        );
        if (response.ok) {
          const { hasUpdate, lastUpdate, source } = await response.json();

          if (hasUpdate && lastUpdate > lastBotSync) {
            console.log(
              `🤖 Bot operation detected from ${source}, refreshing PnL...`,
            );
            setLastBotSync(lastUpdate);
            setIsBotSyncActive(true);

            // Force refresh the PnL calculation
            await calculatePnL();

            // Reset sync indicator after a delay
            setTimeout(() => setIsBotSyncActive(false), 2000);
          }
        }
      } catch (error) {
        // Silent fail - sync is best effort
      }
    };

    // Check immediately and then every 10 seconds
    checkForBotUpdates();
    syncInterval = setInterval(checkForBotUpdates, 10000);

    return () => {
      if (syncInterval) clearInterval(syncInterval);
    };
  }, [connected, publicKey, lastBotSync, calculatePnL, refetchPnL]);

  useEffect(() => {
    const handleRecordAdded = () => {
      void refetchPnL();
    };
    window.addEventListener("tradingRecordAdded", handleRecordAdded);
    return () =>
      window.removeEventListener("tradingRecordAdded", handleRecordAdded);
  }, [refetchPnL]);

  // Real-time updates are now handled by React Query in TradingDataProvider
  // No need for manual subscription here

  // SOL price fetched via useSolPrice hook

  // Function to refresh wallet balances for open positions
  const refreshWalletBalances = React.useCallback(async () => {
    if (openPositions.length === 0 || !connection) return;

    try {
      const walletTokens = await fetchUserTokens(
        connection,
        publicKey!,
        false,
        false,
      );

      setOpenPositions((prev) =>
        prev.map((position) => {
          const walletToken = walletTokens.find(
            (token) => token.mintAddress === position.mintAddress,
          );

          if (walletToken && walletToken.uiAmount > 0) {
            return {
              ...position,
              actualWalletBalance: walletToken.uiAmount,
              walletTokenData: walletToken,
            };
          } else {
            // Token no longer in wallet, should be filtered out on next PnL calculation
            console.log(`⚠️ Token ${position.symbol} no longer in wallet`);
            return position;
          }
        }),
      );
    } catch (error) {
      console.error("Error refreshing wallet balances:", error);
    }
  }, [openPositions, connection, publicKey]);

  const applyOpenPrices = React.useCallback(
    (prices: Record<string, number>, clearLoading = true) => {
      setOpenPositions((prev) => {
        const updatedPositions = prev.map((position) => {
          const currentTokenPriceUsd = prices[position.mintAddress];
          if (!(currentTokenPriceUsd && currentTokenPriceUsd > 0)) {
            return clearLoading
              ? { ...position, isLoadingPrice: false }
              : position;
          }

          if (position.buyPriceUsd && position.buyPriceUsd > 0) {
            const pnlPercentage =
              ((currentTokenPriceUsd - position.buyPriceUsd) /
                position.buyPriceUsd) *
              100;
            const initialUsdValue = position.solAmountBought * solPriceUsd;
            const priceMultiplier =
              currentTokenPriceUsd / position.buyPriceUsd;
            const estimatedCurrentValue = initialUsdValue * priceMultiplier;
            return {
              ...position,
              currentUsdValue: estimatedCurrentValue,
              currentTokenPriceUsd,
              pnlPercentage,
              isLoadingPrice: false,
            };
          }

          // External / wallet-only opens: no cost basis — keep live price, do not fake 0% PnL
          if (position.solAmountBought === 0) {
            const currentUsdValue =
              (position.actualWalletBalance || 0) * currentTokenPriceUsd;
            return {
              ...position,
              currentUsdValue,
              currentTokenPriceUsd,
              pnlPercentage: undefined,
              isLoadingPrice: false,
            };
          }

          const initialUsdValue = position.solAmountBought * solPriceUsd;
          const currentSolValue = position.solAmountBought;
          const priceMultiplier =
            currentTokenPriceUsd / (initialUsdValue / currentSolValue);
          const estimatedCurrentValue =
            initialUsdValue * Math.max(0.1, priceMultiplier);
          const pnlPercentage =
            ((estimatedCurrentValue - initialUsdValue) / initialUsdValue) *
            100;

          return {
            ...position,
            currentUsdValue: estimatedCurrentValue,
            currentTokenPriceUsd,
            pnlPercentage,
            isLoadingPrice: false,
          };
        });

        updatedPositions.sort((a, b) => {
          const aHasPnL = a.pnlPercentage !== undefined;
          const bHasPnL = b.pnlPercentage !== undefined;
          if (aHasPnL && !bHasPnL) return -1;
          if (!aHasPnL && bHasPnL) return 1;
          if (aHasPnL && bHasPnL) {
            return (b.pnlPercentage || 0) - (a.pnlPercentage || 0);
          }
          return b.buyTimestamp - a.buyTimestamp;
        });

        return updatedPositions;
      });
    },
    [solPriceUsd],
  );

  const openMintsKey = useMemo(
    () =>
      openPositions
        .map((p) => p.mintAddress)
        .sort()
        .join(","),
    [openPositions],
  );

  // Server-side GMGN/Jupiter open prices (warms Redis + publishes for SSE)
  const refreshOpenPositionPrices = React.useCallback(async () => {
    if (!openMintsKey) return;

    setIsRefreshingPrices(true);
    try {
      setOpenPositions((prev) =>
        prev.map((pos) => ({ ...pos, isLoadingPrice: true })),
      );
      const mintAddresses = openMintsKey.split(",").filter(Boolean);
      const res = await fetch("/api/prices/open/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mints: mintAddresses }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        prices?: Record<string, number>;
      };
      if (!res.ok || !data.success) {
        throw new Error("open price refresh failed");
      }
      applyOpenPrices(data.prices ?? {});
    } catch (error) {
      console.error("Error refreshing open position prices:", error);
      setOpenPositions((prev) =>
        prev.map((pos) => ({ ...pos, isLoadingPrice: false })),
      );
    } finally {
      setIsRefreshingPrices(false);
    }
  }, [openMintsKey, applyOpenPrices]);

  // Redis pub/sub → SSE for near-realtime open-card prices
  useEffect(() => {
    if (!openMintsKey) return;

    let es: EventSource | null = null;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    const startPollFallback = () => {
      if (pollId || closed) return;
      pollId = setInterval(() => {
        void refreshOpenPositionPrices();
      }, 5_000);
    };

    try {
      es = new EventSource(
        `/api/prices/open/stream?mints=${encodeURIComponent(openMintsKey)}`,
      );
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data) as {
            mint?: string;
            price?: number;
          };
          if (
            typeof payload.mint === "string" &&
            typeof payload.price === "number" &&
            payload.price > 0
          ) {
            applyOpenPrices({ [payload.mint]: payload.price }, false);
          }
        } catch {
          // ignore bad events
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        startPollFallback();
      };
    } catch {
      startPollFallback();
    }

    return () => {
      closed = true;
      es?.close();
      if (pollId) clearInterval(pollId);
    };
  }, [openMintsKey, applyOpenPrices, refreshOpenPositionPrices]);

  useQuery({
    queryKey: ["pnl-open-prices", openMintsKey, solPriceUsd],
    queryFn: async () => {
      await refreshOpenPositionPrices();
      return true;
    },
    enabled: !!openMintsKey && !isRefreshingPrices,
    // Safety net if SSE is quiet; primary updates come via Redis pub/sub
    refetchInterval: openMintsKey ? 15_000 : false,
  });

  // Handle token selection for chart display
  const handleSelectToken = useCallback((mintAddress: string) => {
    setSelectedToken(mintAddress);
    setIsChartLoading(true);
  }, []);

  // ✅ NEW: Manual share trigger function (for existing share buttons)
  const handleShare = useCallback(
    async (
      coinName: string,
      profitPercentage: number,
      tokenAddress?: string,
    ) => {
      await showShareModal({
        coinName,
        profitPercentage,
        tokenAddress,
      });
    },
    [showShareModal],
  );

  // Function to fetch sell quote for a position
  const fetchSellQuote = useCallback(
    async (position: OpenPosition) => {
      if (!connected || !publicKey || !position.walletTokenData) return;

      setQuotingTokenId(position.id);

      try {
        const { getSwapQuote } = await import("@/utils/jupiter");
        const quote = await getSwapQuote(
          position.mintAddress,
          "So11111111111111111111111111111111111111112", // SOL mint address
          position.walletTokenData.balance, // Use full balance for quote
          300, // 3% slippage
        );

        if (quote) {
          setSellQuotes((prev) => new Map(prev).set(position.id, quote));
        }
      } catch (error) {
        console.error("Failed to fetch sell quote:", error);
      } finally {
        setQuotingTokenId("");
      }
    },
    [connected, publicKey],
  );

  // Add these handlers after the fetchSellQuote function
  const handlePositionHover = useCallback(
    (position: OpenPosition) => {
      // Clear any existing timeout for this position
      const existingTimeout = quoteTimeouts.get(position.id);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Set a new timeout to fetch quote after 300ms hover
      const timeout = setTimeout(() => {
        fetchSellQuote(position);
      }, 300);

      setQuoteTimeouts((prev) => new Map(prev).set(position.id, timeout));
    },
    [fetchSellQuote, quoteTimeouts],
  );

  const handlePositionHoverOut = useCallback(
    (position: OpenPosition) => {
      // Clear timeout if user stops hovering before quote is fetched
      const existingTimeout = quoteTimeouts.get(position.id);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        setQuoteTimeouts((prev) => {
          const newMap = new Map(prev);
          newMap.delete(position.id);
          return newMap;
        });
      }

      // Remove quote after 1 second delay to allow for quick re-hover
      setTimeout(() => {
        setSellQuotes((prev) => {
          const newMap = new Map(prev);
          newMap.delete(position.id);
          return newMap;
        });
      }, 1000);
    },
    [quoteTimeouts],
  );

  // Fast sell function for open positions
  const handleFastSell = React.useCallback(
    async (position: OpenPosition, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (!connected || !publicKey) {
        setSellError("Please connect your wallet first");
        return;
      }

      if (!position.isSimulation && !signAllTransactions) {
        setSellError("Wallet signing is required to sell on-chain");
        return;
      }

      if (!position.isSimulation && !connection) {
        setSellError("RPC connection not ready");
        return;
      }

      setIsSelling(true);
      setSellingTokenId(position.id);
      setSellError("");

      try {
        if (position.isSimulation) {
          if (!walletAddress) {
            setSellError("Please connect your wallet first");
            return;
          }

          const { solReceived } = await closeSimulationPosition({
            walletAddress,
            mintAddress: position.mintAddress,
            records,
            trackOperation,
            symbol: position.symbol,
            name: position.name,
            logoURI: position.logoURI,
            sellPriceUsd: position.currentTokenPriceUsd,
          });

          clearNotificationFlag(position.mintAddress);
          setSellError("");
          showOutcome({
            success: true,
            operation: "sell",
            isSimulation: true,
            tokenSymbol: position.symbol || position.name,
            mintAddress: position.mintAddress,
            solAmount: solReceived,
          });
          return;
        }

        if (!connection) {
          setSellError("RPC connection not ready");
          return;
        }

        // Get balance before operation for better tracking
        const balanceBeforeOp = await connection.getBalance(publicKey);
        const balanceBeforeSOL = balanceBeforeOp / LAMPORTS_PER_SOL;

        // Resolve via Jupiter Portfolio first (same source as /sell), then
        // cached position data / RPC — Token-2022 often missing from RPC-only.
        const tokenToSell = await resolveWalletTokenToSell(
          publicKey.toString(),
          position.mintAddress,
          {
            cached: position.walletTokenData,
            rpcFetch: () =>
              fetchUserTokens(connection, publicKey, false, false),
          },
        );

        if (!tokenToSell || tokenToSell.uiAmount <= 0 || !tokenToSell.balance) {
          throw new Error(
            "Not in wallet — refresh or use /sell",
          );
        }

        // Keep open-position card sellable after resolve
        setOpenPositions((prev) =>
          prev.map((p) =>
            p.id === position.id
              ? {
                  ...p,
                  walletTokenData: tokenToSell,
                  actualWalletBalance: tokenToSell.uiAmount,
                }
              : p,
          ),
        );

        console.log(
          `💰 Fast selling ${tokenToSell.symbol}: ${tokenToSell.uiAmount} tokens (portfolio-resolved)`,
        );

        const tokenForSale: TokenToSell = {
          ...tokenToSell,
          sellAmount: tokenToSell.balance,
          sellPercentage: 100,
        };

        // Match /sell (BulkTokenSeller) defaults
        const sellRequest: BulkSellRequest = {
          tokens: [tokenForSale],
          slippage: 200, // 2%
          priorityFee: 30000,
        };

        // Execute the sell using the more efficient executeBulkSellAlt
        const signTx = requireSignAllTransactions(
          signAllTransactions,
          "Wallet signing is required to sell on-chain",
        );
        const sellResult = await executeBulkSellAlt(
          sellRequest,
          publicKey.toString(),
          connection,
          signTx,
        );

        // Get balance after operation for better tracking
        const balanceAfterOp = await connection.getBalance(publicKey);
        const balanceAfterSOL = balanceAfterOp / LAMPORTS_PER_SOL;

        console.log(
          `💰 Balance change: ${(balanceAfterSOL - balanceBeforeSOL).toFixed(6)} SOL`,
        );

        if (sellResult.success && sellResult.successfulSwaps.length > 0) {
          // ✅ NEW: Clear notification flag when position is sold
          clearNotificationFlag(position.mintAddress);

          // Track the successful sell operation for points
          try {
            const trackResult = await trackSell(
              publicKey.toString(),
              sellResult.successfulSwaps.length,
              {
                failureCount: sellResult.failedSwaps.length,
                solAmount: sellResult.totalReceived || 0,
                tokenMints: [position.mintAddress],
                signatures: sellResult.signatures,
              },
            );
            console.log(
              `🎉 Earned ${trackResult.pointsEarned} points from fast sell!`,
            );
          } catch (trackError) {
            console.error(
              "Failed to track sell operation for points:",
              trackError,
            );
          }

          // ✅ NEW: Auto-trigger share modal for fast sells
          const pnlPercentage = pnlShareService.calculatePnLPercentage(
            position.solAmountBought,
            sellResult.totalReceived || 0,
          );

          if (Math.abs(pnlPercentage) >= 1) {
            // Only trigger for trades with >= 1% P&L
            setTimeout(async () => {
              try {
                await autoTriggerShare({
                  coinName: position.symbol || position.name || "Token",
                  profitPercentage: pnlPercentage,
                  tokenAddress: position.mintAddress,
                  solAmountBought: position.solAmountBought,
                  solAmountSold: sellResult.totalReceived || 0,
                });
              } catch (error) {
                console.error(
                  "Error auto-triggering share for fast sell:",
                  error,
                );
              }
            }, 1000);
          }

          // Track operation for PnL and history via React Query system
          // Note: This will automatically trigger PnL recalculation via real-time subscription
          try {
            const { fetchTokenPricesForTracking } =
              await import("@/utils/trading-tracker");
            const tokenPrices = await fetchTokenPricesForTracking([
              position.mintAddress,
            ]);
            const currentSolPrice = await getSolPriceUSD();

            const enhancedTokenData = {
              mintAddress: position.mintAddress,
              symbol: position.symbol,
              name: position.name,
              logoURI: position.logoURI,
              priceUsd: tokenPrices[position.mintAddress] || 0,
              tokenAmount: tokenToSell.balance,
              solPrice: currentSolPrice,
            };

            // Track via centralized system - this will trigger automatic PnL refresh
            await trackOperation({
              walletAddress: publicKey.toString(),
              operationType: "sell",
              tokens: [enhancedTokenData],
              successCount: 1,
              failureCount: 0,
              totalTokens: 1,
              solAmount: sellResult.totalReceived || 0,
              feesPaid: 0,
              solPriceUsd: currentSolPrice,
              totalUsdValue: currentSolPrice
                ? (sellResult.totalReceived || 0) * currentSolPrice
                : undefined,
              signatures: sellResult.signatures,
              slippage: 2, // 2% slippage
              priorityFee: 300000,
              errors: undefined,
            });

            // Show success message briefly
            setSellError("");

            showOutcome({
              success: true,
              operation: "sell",
              isSimulation: false,
              tokenSymbol: position.symbol || position.name,
              mintAddress: position.mintAddress,
              solAmount: sellResult.totalReceived || 0,
            });

            // The PnL will refresh automatically via React Query subscription
            // No need for manual calculatePnL() call
          } catch (trackError) {
            console.error(
              "Failed to track sell operation for history/PnL:",
              trackError,
            );

            // Fallback: manual refresh if tracking fails
            setTimeout(() => {
              calculatePnL();
            }, 200);
          }
        } else {
          throw new Error(
            "Failed to sell token: " +
              (sellResult.failedSwaps[0]?.error || "Unknown error"),
          );
        }
      } catch (err) {
        console.error("Fast sell error:", err);
        const message =
          err instanceof Error ? err.message : "Failed to sell token";
        setSellError(message);
        showOutcome({
          success: false,
          operation: "sell",
          isSimulation: position.isSimulation,
          tokenSymbol: position.symbol || position.name,
          mintAddress: position.mintAddress,
          error: message,
        });
      } finally {
        setIsSelling(false);
        setSellingTokenId("");
      }
    },
    [
      connected,
      publicKey,
      walletAddress,
      signAllTransactions,
      connection,
      records,
      calculatePnL,
      clearNotificationFlag,
      autoTriggerShare,
      trackOperation,
      showOutcome,
    ],
  );

  // Cleanup timeouts when component unmounts
  useEffect(() => {
    return () => {
      quoteTimeouts.forEach((timeout) => clearTimeout(timeout));
    };
  }, [quoteTimeouts]);

  // Event-based updates are no longer needed - React Query handles all updates
  // The records dependency in the calculatePnL useEffect will trigger recalculation

  const formatRelativeTime = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  const openTransactionOnSolscan = (signatures: string[]) => {
    if (signatures && signatures.length > 0) {
      const signature = signatures[0];
      const solscanUrl = `https://solscan.io/tx/${signature}`;
      window.open(solscanUrl, "_blank", "noopener,noreferrer");
    }
  };

  const formatPnL = (pnl: number, isPercentage: boolean = false) => {
    const isPositive = pnl > 0;
    const color = isPositive ? "text-green-400" : "text-red-400";
    const prefix = isPositive ? "+" : "";

    if (isPercentage) {
      return (
        <span className={color}>
          {prefix}
          {pnl.toFixed(2)}%
        </span>
      );
    }

    return (
      <span className={color}>
        {prefix}
        {pnl.toFixed(4)} SOL
      </span>
    );
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
  if (isLoading) {
    return (
      <div className="">
        <TokenSkeleton count={3} variant="trading-history" />
      </div>
    );
  }

  if (recordsError === "WALLET_SESSION_REQUIRED") {
    return <WalletSignInPrompt title="Sign in to load P&amp;L" />;
  }

  if (walletAddress && walletSessionStatus === "signing") {
    return (
      <div className="">
        <TokenSkeleton count={3} variant="trading-history" />
      </div>
    );
  }

  if (walletAddress && walletSessionStatus === "error") {
    return <WalletSignInPrompt title="Sign in to load P&amp;L" />;
  }

  const selectedOpenPositions = openPositions.filter((pos) =>
    selectedTokens.has(pos.id),
  );
  const selectedAllSimulation =
    selectedOpenPositions.length > 0 &&
    selectedOpenPositions.every((pos) => pos.isSimulation);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-2">
          {isBotSyncActive && (
            <div className="flex items-center space-x-2 text-purple-400">
              <div className="w-2 h-2 bg-purple-400 rounded-full animate-pulse"></div>
              <span className="text-sm">Bot sync active</span>
            </div>
          )}
        </div>
      </div>

      {/* Chart Display Section */}
      {selectedToken && (
        <div className="rounded-lg border border-gray-600">
          <div className="flex items-center justify-between border-b border-gray-700">
            <button
              onClick={() => {
                setSelectedToken("");
                setIsChartLoading(false);
              }}
              className="text-gray-400 hover:text-white transition-colors"
              title="Close Chart"
            >
              ✕
            </button>
          </div>
          <div className="p-3">
            {isChartLoading && (
              <div className="flex items-center justify-center py-8">
                <div className="flex items-center space-x-2">
                  <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-gray-400">Loading chart...</span>
                </div>
              </div>
            )}
            <iframe
              src={getGmgnKlineUrl(selectedToken, { interval: "1D", theme: "dark" })}
              height="400"
              className="w-full rounded-lg"
              style={{
                border: "none",
                display: isChartLoading ? "none" : "block",
              }}
              title={`GMGN Chart - ${selectedToken}`}
              onLoad={() => setIsChartLoading(false)}
              onError={() => {
                console.error("Chart failed to load for token:", selectedToken);
                setIsChartLoading(false);
              }}
              allowFullScreen
              frameBorder="0"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
            />
          </div>
        </div>
      )}

      {/* Header with tabs and controls */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-4">
          <h2 className="text-lg font-semibold text-white">Your PnL</h2>
          <div className="flex items-center space-x-2">
            <div className="flex space-x-1 bg-gray-800 rounded-lg p-1">
              <button
                onClick={() => setActiveTab("completed")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  activeTab === "completed"
                    ? "bg-gray-700 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                Completed ({filteredDisplayRecords.length})
              </button>
              <button
                onClick={() => setActiveTab("open")}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  activeTab === "open"
                    ? "bg-gray-700 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                Open ({filteredDisplayOpenPositions.length})
              </button>
            </div>

            <div className="flex space-x-1 bg-gray-800 rounded-lg p-1">
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

            {/* ✅ NEW: Global P&L visibility toggle */}
            <button
              onClick={toggleGlobalPnLVisibility}
              className="text-gray-500 hover:text-gray-300 transition-colors p-1"
              title={
                globalPnLHidden
                  ? "Show all P&L amounts"
                  : "Hide all P&L amounts"
              }
            >
              {globalPnLHidden ? (
                <svg
                  className="w-4 h-4"
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
              ) : (
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          {/* ✅ NEW: Bulk sell controls */}
          {activeTab === "open" && filteredDisplayOpenPositions.length > 0 && (
            <div className="flex items-center space-x-2">
              {selectedTokens.size > 0 ? (
                <>
                  <span className="text-xs text-gray-400">
                    {selectedTokens.size} selected
                  </span>
                  <button
                    onClick={() => setShowBulkSellOverlay(true)}
                    className="px-2 py-1 text-xs bg-red-600 hover:bg-red-700 text-white rounded-md transition-colors"
                    title={
                      selectedAllSimulation
                        ? `Close ${selectedTokens.size} simulation positions`
                        : `Sell ${selectedTokens.size} selected tokens`
                    }
                  >
                    {selectedAllSimulation
                      ? `Close (${selectedTokens.size})`
                      : `Sell (${selectedTokens.size})`}
                  </button>
                  <button
                    onClick={clearAllSelections}
                    className="px-2 py-1 text-xs bg-gray-600 hover:bg-gray-700 text-white rounded-md transition-colors"
                    title="Clear selection"
                  >
                    Clear
                  </button>
                </>
              ) : (
                <button
                  onClick={selectAllTokens}
                  className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
                  title="Select all tokens for bulk sell"
                >
                  Select All
                </button>
              )}
            </div>
          )}

          {/* ✅ NEW: Notification controls */}
          {activeTab === "open" && (
            <div className="flex items-center space-x-2">
              <button
                onClick={toggleNotifications}
                className={`flex items-center space-x-1 px-2 py-1 text-xs rounded-md transition-colors ${
                  notificationsEnabled
                    ? "bg-green-600 hover:bg-green-700 text-white"
                    : "bg-gray-600 hover:bg-gray-700 text-gray-300"
                }`}
                title={`${notificationsEnabled ? "Disable" : "Enable"} notifications for 50%+ P&L (once per token)`}
              >
                <span>{notificationsEnabled ? "🔔" : "🔕"}</span>
                <span>50%+</span>
              </button>

              {/* ✅ NEW: Reset notifications button */}
              {notificationsEnabled && notifiedTokens.size > 0 && (
                <button
                  onClick={() => {
                    setNotifiedTokens(new Set());
                    localStorage.removeItem("pnl-notified-tokens");
                    console.log("🔄 Reset all notification flags");
                  }}
                  className="px-2 py-1 text-xs bg-yellow-600 hover:bg-yellow-700 text-white rounded-md transition-colors"
                  title={`Reset notifications for ${notifiedTokens.size} tokens`}
                >
                  🔄 Reset ({notifiedTokens.size})
                </button>
              )}
            </div>
          )}

          {/* Refresh list: re-fetch holdings + drop tokens not in wallet */}
          {activeTab === "open" && (
            <button
              onClick={() => {
                void calculatePnL();
              }}
              disabled={isLoading}
              className="flex items-center space-x-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white text-xs rounded-md transition-colors"
              title="Refresh list (drop tokens not in wallet)"
            >
              <span className={isLoading ? "animate-spin" : ""}>🔄</span>
              <span>Refresh list</span>
            </button>
          )}

          {/* Price-only refresh */}
          {activeTab === "open" && (
            <button
              onClick={() => {
                if (openPositions.length > 0) {
                  refreshOpenPositionPrices();
                }
              }}
              disabled={isLoading || isRefreshingPrices || openPositions.length === 0}
              className="flex items-center space-x-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 text-white text-xs rounded-md transition-colors"
              title="Refresh open position prices"
            >
              <span
                className={isRefreshingPrices ? "animate-spin" : ""}
              >
                💲
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <TokenSkeleton key={i} />
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-8">
            <p className="text-red-400 text-sm">{error}</p>
          </div>
        ) : (
          <>
            {activeTab === "completed" && (
              <>
                {showClosedPositionsHint && pnlRecords.length === 0 && (
                  <div className="bg-blue-900/20 border border-blue-500/30 rounded-lg p-4 mb-4">
                    <div className="flex items-start space-x-3">
                      <div className="flex-shrink-0">
                        <svg
                          className="w-5 h-5 text-blue-400 mt-0.5"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </div>
                      <div className="flex-1">
                        <h3 className="text-sm font-medium text-blue-400 mb-1">
                          How P&L Tracking Works
                        </h3>
                        <p className="text-sm text-blue-300 mb-3">
                          Your completed trades will appear here once you buy
                          and sell tokens. The tracker automatically matches
                          your buy and sell operations to calculate profit/loss.
                        </p>
                        <div className="flex items-center space-x-2">
                          <button
                            onClick={handleDismissHint}
                            className="text-xs text-blue-400 hover:text-blue-300 underline"
                          >
                            Got it, don't show again
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {filteredDisplayRecords.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-gray-400 text-sm">
                      {pnlRecords.length === 0
                        ? "No completed trades yet"
                        : `No ${modeFilter} completed trades`}
                    </p>
                    <p className="text-gray-500 text-xs mt-1">
                      Buy and sell tokens to see your P&L here
                    </p>
                  </div>
                ) : (
                  <div className="flex space-x-2 overflow-x-auto mb-3 scrollbar-hide">
                    {filteredDisplayRecords.map((record) => {
                      // Calculate USD amounts
                      const buyAmountUSD = record.solAmountBought * solPriceUsd;
                      const pnlAmountUSD =
                        buyAmountUSD * (record.pnlPercentage / 100);

                      return (
                        <div
                          key={record.id}
                          className={`flex-shrink-0 hover:bg-gray-700/40 transition-all duration-200 w-auto rounded-lg cursor-pointer group py-2 px-3 border ${
                            record.isBotOperation
                              ? "border-purple-500/30 bg-purple-900/10"
                              : "border-gray-600/30"
                          }`}
                          onClick={() =>
                            openTransactionOnSolscan(record.sellSignatures)
                          }
                          title="Click to view transaction on Solscan"
                        >
                          {/* Header: P&L and Action Buttons */}
                          <div className="flex items-center justify-between mb-2 ml-1">
                            <div className="flex items-center space-x-1">
                              <span
                                className={`text-sm font-medium ${
                                  record.pnlPercentage > 0
                                    ? "text-green-400"
                                    : record.pnlPercentage < 0
                                      ? "text-red-400"
                                      : "text-gray-400"
                                }`}
                              >
                                {record.pnlPercentage > 0 ? "+" : ""}
                                {record.pnlPercentage.toFixed(1)}%
                              </span>
                              <BotOperationIndicator
                                isBotOperation={record.isBotOperation}
                                botStrategy={record.botStrategy}
                              />
                              <JupiterSwapIndicator
                                isJupiterSwap={record.jupiter_swap}
                              />
                              <SimulationIndicator
                                isSimulation={record.isSimulation}
                                simulationType={record.simulationType}
                              />
                            </div>

                            <div className="flex items-center space-x-1">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenChart(
                                    record.mintAddress,
                                    record.symbol,
                                  );
                                }}
                                className="px-1.5 py-0.5 bg-green-600 hover:bg-green-700 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Open Chart"
                              >
                                📈
                              </button>

                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleShare(
                                    record.symbol || record.name || "Token",
                                    record.pnlPercentage,
                                    record.mintAddress,
                                  );
                                }}
                                className="px-1.5 py-0.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                title="Share"
                              >
                                📤
                              </button>
                            </div>
                          </div>

                          {/* Token display */}
                          <div className="flex items-center space-x-2 mb-2 ml-1">
                            <div className="relative flex items-center">
                              <div className="w-4 h-4 bg-gray-700 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden border border-gray-600">
                                {record.logoURI ? (
                                  <OptimizedImage
                                    src={record.logoURI}
                                    alt={
                                      record.symbol || record.name || "Token"
                                    }
                                    className="w-full h-full object-cover"
                                    fallback={(record.symbol || record.name || "?")
                                      .charAt(0)
                                      .toUpperCase()}
                                  />
                                ) : (
                                  (record.symbol || record.name || "?")
                                    .charAt(0)
                                    .toUpperCase()
                                )}
                              </div>
                            </div>

                            <div className="flex items-center space-x-1 flex-1 min-w-0">
                              <span className="text-xs text-gray-300 font-medium truncate">
                                {record.symbol || record.name || "Unknown"}
                              </span>
                            </div>
                          </div>

                          {/* Buy Price Display */}
                          <div className="text-xs text-gray-400 mb-1 ml-1">
                            <span className="text-gray-500">Buy Price: </span>
                            <span className="text-gray-300">
                              {Number.isFinite(record.buyPrice)
                                ? `$${record.buyPrice.toFixed(6)}`
                                : "—"}
                            </span>
                          </div>

                          {/* SOL amounts - Hidden when global toggle is active */}
                          {!globalPnLHidden && (
                            <div className="text-xs text-gray-300 mb-1">
                              {record.solAmountBought.toFixed(3)} →{" "}
                              {record.solAmountSold.toFixed(3)} SOL
                            </div>
                          )}

                          {/* USD P&L Amount - Hidden when global toggle is active OR individual toggle is active */}
                          {!globalPnLHidden && (
                            <div className="text-xs mb-1">
                              <span className="text-gray-500">P&L: </span>
                              <div className="inline-flex items-center space-x-1">
                                {hiddenPnLAmounts.has(record.id) ? (
                                  <span className="font-medium text-gray-400">
                                    ••••
                                  </span>
                                ) : (
                                  <span
                                    className={`font-medium ${
                                      pnlAmountUSD > 0
                                        ? "text-green-400"
                                        : pnlAmountUSD < 0
                                          ? "text-red-400"
                                          : "text-gray-400"
                                    }`}
                                  >
                                    {pnlAmountUSD > 0 ? "+" : ""}$
                                    {Math.abs(pnlAmountUSD).toFixed(2)}
                                  </span>
                                )}
                                <button
                                  onClick={(e) =>
                                    togglePnLVisibility(record.id, e)
                                  }
                                  className="text-gray-500 hover:text-gray-300 transition-colors"
                                  title={
                                    hiddenPnLAmounts.has(record.id)
                                      ? "Show P&L amount"
                                      : "Hide P&L amount"
                                  }
                                >
                                  {hiddenPnLAmounts.has(record.id) ? (
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
                                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                                      />
                                      <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                                      />
                                    </svg>
                                  ) : (
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
                                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21"
                                      />
                                    </svg>
                                  )}
                                </button>
                              </div>
                            </div>
                          )}

                          <div className="flex items-center justify-between text-xs text-gray-400">
                            <span>
                              {formatRelativeTime(record.sellTimestamp)}
                            </span>
                            <div className="flex items-center space-x-1">
                              {record.status && (
                                <span
                                  className={`text-xs px-1 py-0.5 rounded ${
                                    record.status === "won"
                                      ? "bg-green-900/50 text-green-300"
                                      : record.status === "lost"
                                        ? "bg-red-900/50 text-red-300"
                                        : "bg-gray-900/50 text-gray-300"
                                  }`}
                                >
                                  {record.status.toUpperCase()}
                                </span>
                              )}
                              {record.tradeComparisonData && (
                                <span
                                  className="text-cyan-400"
                                  title="Trade Comparison Available"
                                >
                                  📊
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {activeTab === "open" && (
              <>
                {filteredDisplayOpenPositions.length === 0 ? (
                  <div className="text-center py-8">
                    <p className="text-gray-400 text-sm">
                      {openPositions.length === 0
                        ? "No open positions"
                        : `No ${modeFilter} open positions`}
                    </p>
                    <p className="text-gray-500 text-xs mt-1">
                      Buy some tokens to see your positions here
                    </p>
                  </div>
                ) : (
                  <>
                    {/* ✅ NEW: Drag selection container */}
                    <div
                      className="relative flex space-x-2 overflow-x-auto mb-3 scrollbar-hide select-none"
                      onMouseDown={handleMouseDown}
                      onMouseMove={handleMouseMove}
                      onMouseUp={handleMouseUp}
                      style={{ cursor: isDragging ? "crosshair" : "default" }}
                    >
                      {/* ✅ NEW: Selection rectangle overlay */}
                      {isDragging && dragStart && dragEnd && (
                        <div
                          className="fixed pointer-events-none border-2 border-blue-400 bg-blue-400/10 z-50"
                          style={{
                            left: Math.min(dragStart.x, dragEnd.x),
                            top: Math.min(dragStart.y, dragEnd.y),
                            width: Math.abs(dragEnd.x - dragStart.x),
                            height: Math.abs(dragEnd.y - dragStart.y),
                          }}
                        />
                      )}

                      {filteredDisplayOpenPositions.map((position) => {
                        const isSelected = selectedTokens.has(position.id);
                        const buyAmountUSD =
                          position.solAmountBought * solPriceUsd;
                        const pnlAmountUSD =
                          position.pnlPercentage !== undefined
                            ? buyAmountUSD * (position.pnlPercentage / 100)
                            : 0;

                        return (
                          <div
                            key={position.id}
                            data-token-address={position.mintAddress}
                            className={`flex-shrink-0 hover:bg-gray-700/40 transition-all duration-200 min-w-[100px] rounded-lg cursor-pointer group py-2 px-3 border ${
                              isSelected
                                ? "border-blue-400 bg-blue-900/20 ring-2 ring-blue-400/50"
                                : position.isBotOperation
                                  ? "border-purple-500/30 bg-purple-900/10"
                                  : "border-gray-600/30"
                            }`}
                            title="Open position"
                            onClick={(e) => {
                              if (!isDragging) {
                                toggleTokenSelection(position.id, e);
                              }
                            }}
                          >
                            {/* ✅ NEW: Selection indicator */}
                            {isSelected && (
                              <div className="absolute -top-1 -right-1 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center">
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

                            <div className="token-content">
                              {/* Header: P&L and Action Buttons */}
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center space-x-1">
                                  {position.isLoadingPrice ? (
                                    <div className="flex items-center space-x-1">
                                      <div className="w-2 h-2 bg-gray-400 rounded-full animate-pulse"></div>
                                      <span className="text-xs text-gray-400">
                                        ...
                                      </span>
                                    </div>
                                  ) : position.pnlPercentage !== undefined ? (
                                    <span
                                      className={`text-sm font-medium ${
                                        position.pnlPercentage > 0
                                          ? "text-green-400"
                                          : position.pnlPercentage < 0
                                            ? "text-red-400"
                                            : "text-gray-400"
                                      }`}
                                    >
                                      {position.pnlPercentage > 0 ? "+" : ""}
                                      {position.pnlPercentage.toFixed(1)}%
                                    </span>
                                  ) : position.currentTokenPriceUsd &&
                                    position.currentTokenPriceUsd > 0 ? (
                                    <span
                                      className="text-xs text-gray-300 font-mono"
                                      title="Live price (no buy cost basis)"
                                    >
                                      ${position.currentTokenPriceUsd.toFixed(6)}
                                    </span>
                                  ) : (
                                    <span className="text-blue-400 text-xs">
                                      OPEN
                                    </span>
                                  )}
                                  <BotOperationIndicator
                                    isBotOperation={position.isBotOperation}
                                    botStrategy={position.botStrategy}
                                  />
                                  <JupiterSwapIndicator
                                    isJupiterSwap={position.jupiter_swap}
                                  />
                                  <SimulationIndicator
                                    isSimulation={position.isSimulation}
                                    simulationType={position.simulationType}
                                  />
                                </div>

                                <div className="flex items-center space-x-1">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleOpenChart(
                                        position.mintAddress,
                                        position.symbol,
                                      );
                                    }}
                                    className="px-1.5 py-0.5 bg-green-600 hover:bg-green-700 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="Open Chart"
                                  >
                                    📈
                                  </button>

                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleFastSell(position, e);
                                    }}
                                    disabled={
                                      (isSelling &&
                                        sellingTokenId === position.id) ||
                                      (!position.isSimulation &&
                                        !(
                                          position.walletTokenData &&
                                          position.walletTokenData.uiAmount > 0
                                        ))
                                    }
                                    className="px-1.5 py-0.5 bg-red-600 hover:bg-red-700 disabled:bg-red-800 disabled:opacity-40 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity"
                                    title={
                                      position.isSimulation
                                        ? "Close SIM"
                                        : position.walletTokenData &&
                                            position.walletTokenData.uiAmount >
                                              0
                                          ? "Fast Sell"
                                          : "Not in wallet — refresh or use /sell"
                                    }
                                  >
                                    {isSelling &&
                                    sellingTokenId === position.id ? (
                                      <div className="w-2 h-2 border border-white border-t-transparent rounded-full animate-spin"></div>
                                    ) : position.isSimulation ? (
                                      "Close SIM"
                                    ) : (
                                      "🔴"
                                    )}
                                  </button>
                                </div>
                              </div>

                              {/* Token display */}
                              <div className="flex items-center space-x-2 mb-2">
                                <div className="relative flex items-center">
                                  <div className="w-4 h-4 bg-gray-700 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden border border-gray-600">
                                    {position.logoURI ? (
                                      <OptimizedImage
                                        src={position.logoURI}
                                        alt={
                                          position.symbol ||
                                          position.name ||
                                          "Token"
                                        }
                                        className="w-full h-full object-cover"
                                        fallback={(position.symbol || position.name || "?")
                                          .charAt(0)
                                          .toUpperCase()}
                                      />
                                    ) : (
                                      (position.symbol || position.name || "?")
                                        .charAt(0)
                                        .toUpperCase()
                                    )}
                                  </div>
                                </div>

                                <div className="flex items-center space-x-1 flex-1 min-w-0">
                                  <span className="text-xs text-gray-300 font-medium truncate">
                                    {position.symbol ||
                                      position.name ||
                                      "Unknown"}
                                  </span>
                                </div>
                              </div>

                              {/* Buy / live price — $0 buy is cost-basis gap, not dead pub/sub */}
                              <div className="text-xs text-gray-400 mb-1">
                                <span className="text-gray-500">
                                  Buy Price:{" "}
                                </span>
                                <span className="text-gray-300">
                                  {(() => {
                                    const fromUsd =
                                      position.buyPriceUsd &&
                                      position.buyPriceUsd > 0
                                        ? position.buyPriceUsd
                                        : null;
                                    const fromSol =
                                      !fromUsd &&
                                      position.solAmountBought > 0 &&
                                      buyAmountUSD > 0
                                        ? buyAmountUSD / position.solAmountBought
                                        : null;
                                    const price = fromUsd ?? fromSol;
                                    return price != null && Number.isFinite(price)
                                      ? `$${price.toFixed(6)}`
                                      : "—";
                                  })()}
                                </span>
                                {position.currentTokenPriceUsd &&
                                  position.currentTokenPriceUsd > 0 && (
                                    <span
                                      className="text-gray-400 ml-2"
                                      title="Live mark from open-price feed"
                                    >
                                      · Now $
                                      {position.currentTokenPriceUsd.toFixed(6)}
                                    </span>
                                  )}
                                {position.buyTimestamp > 0 && (
                                  <span
                                    className="text-gray-500 ml-2"
                                    title={new Date(
                                      position.buyTimestamp,
                                    ).toLocaleString()}
                                  >
                                    · {formatRelativeTime(position.buyTimestamp)}
                                  </span>
                                )}
                              </div>

                              {/* SOL amount - Hidden when global toggle is active */}
                              {!globalPnLHidden && (
                                <div className="text-xs text-gray-300 mb-1">
                                  {position.solAmountBought.toFixed(3)} SOL
                                </div>
                              )}

                              {/* USD P&L Amount - Hidden when global toggle is active OR individual toggle is active */}
                              {!globalPnLHidden &&
                                position.pnlPercentage !== undefined && (
                                  <div className="text-xs mb-1">
                                    <span className="text-gray-500">P&L: </span>
                                    <div className="inline-flex items-center space-x-1">
                                      {hiddenPnLAmounts.has(position.id) ? (
                                        <span className="font-medium text-gray-400">
                                          ••••
                                        </span>
                                      ) : (
                                        <span
                                          className={`font-medium ${
                                            pnlAmountUSD > 0
                                              ? "text-green-400"
                                              : pnlAmountUSD < 0
                                                ? "text-red-400"
                                                : "text-gray-400"
                                          }`}
                                        >
                                          {pnlAmountUSD > 0 ? "+" : ""}$
                                          {Math.abs(pnlAmountUSD).toFixed(2)}
                                        </span>
                                      )}
                                      <button
                                        onClick={(e) =>
                                          togglePnLVisibility(position.id, e)
                                        }
                                        className="text-gray-500 hover:text-gray-300 transition-colors"
                                        title={
                                          hiddenPnLAmounts.has(position.id)
                                            ? "Show P&L amount"
                                            : "Hide P&L amount"
                                        }
                                      >
                                        {hiddenPnLAmounts.has(position.id) ? (
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
                                              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                                            />
                                            <path
                                              strokeLinecap="round"
                                              strokeLinejoin="round"
                                              strokeWidth={2}
                                              d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
                                            />
                                          </svg>
                                        ) : (
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
                                              d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21"
                                            />
                                          </svg>
                                        )}
                                      </button>
                                    </div>
                                  </div>
                                )}

                              {/* Footer: USD value and indicators - USD value hidden when global toggle is active */}
                              <div className="flex items-center justify-between text-xs text-gray-400">
                                {!globalPnLHidden && (
                                  <span>~${buyAmountUSD.toFixed(0)}</span>
                                )}
                                <div className="flex items-center space-x-1">
                                  {position.tradingSimulation && (
                                    <span
                                      className="text-purple-300"
                                      title="Trading Simulation"
                                    >
                                      SIM
                                    </span>
                                  )}
                                  {position.tradeComparisonData && (
                                    <span
                                      className="text-cyan-400"
                                      title="Trade Comparison Available"
                                    >
                                      📊
                                    </span>
                                  )}
                                  {position.waitingStartedAt && (
                                    <span
                                      className="text-yellow-400"
                                      title="Waiting"
                                    >
                                      ⏳
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        {!walletAddress && (
          <div className="text-center py-8">
            <p className="text-gray-400 text-sm">
              Connect your wallet to track trading performance
            </p>
          </div>
        )}

        {/* Algo strategy positions — toggle unmounts fetch when hidden */}
        <div className="mt-6">
          {showAlgoStrategies ? (
            <>
              <div className="flex justify-end mb-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowAlgoStrategies(false);
                    localStorage.setItem("pnl-show-algo-strategies", "false");
                  }}
                  className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md transition-colors"
                  title="Hide algo strategy positions"
                >
                  Hide algo
                </button>
              </div>
              <AlgoPositions />
            </>
          ) : (
            <div className="flex items-center justify-between bg-gray-900/60 border border-gray-700 rounded-xl px-4 py-3">
              <span className="text-sm text-gray-400">Algo Strategies</span>
              <button
                type="button"
                onClick={() => {
                  setShowAlgoStrategies(true);
                  localStorage.setItem("pnl-show-algo-strategies", "true");
                }}
                className="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-md transition-colors"
                title="Show algo strategy positions"
              >
                Show algo
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ✅ NEW: Bulk Sell Overlay */}
      {showBulkSellOverlay && selectedTokens.size > 0 && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border border-gray-600">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">
                Bulk Sell Confirmation
              </h3>
              <button
                onClick={() => setShowBulkSellOverlay(false)}
                className="text-gray-400 hover:text-gray-300"
              >
                <svg
                  className="w-6 h-6"
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
            </div>

            <div className="mb-4">
              <p className="text-gray-300 mb-2">
                You are about to sell{" "}
                <span className="font-semibold text-white">
                  {selectedTokens.size}
                </span>{" "}
                tokens:
              </p>

              <div className="max-h-32 overflow-y-auto space-y-1">
                {openPositions
                  .filter((pos) => selectedTokens.has(pos.id))
                  .map((position) => (
                    <div
                      key={position.id}
                      className="flex items-center space-x-2 text-sm"
                    >
                      <div className="w-3 h-3 bg-gray-700 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden">
                        {position.logoURI ? (
                          <OptimizedImage
                            src={position.logoURI}
                            alt={position.symbol ?? "Token"}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          (position.symbol || "?").charAt(0).toUpperCase()
                        )}
                      </div>
                      <span className="text-gray-300">
                        {position.symbol || position.name || "Unknown"}
                      </span>
                      {position.pnlPercentage !== undefined && (
                        <span
                          className={`text-xs ${
                            position.pnlPercentage > 0
                              ? "text-green-400"
                              : position.pnlPercentage < 0
                                ? "text-red-400"
                                : "text-gray-400"
                          }`}
                        >
                          {position.pnlPercentage > 0 ? "+" : ""}
                          {position.pnlPercentage.toFixed(1)}%
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            </div>

            {bulkSellError && (
              <div className="mb-4 p-3 bg-red-900/20 border border-red-500/30 rounded text-red-400 text-sm">
                {bulkSellError}
              </div>
            )}

            <div className="flex space-x-3">
              <button
                onClick={() => setShowBulkSellOverlay(false)}
                className="flex-1 px-4 py-2 bg-gray-600 hover:bg-gray-700 text-white rounded transition-colors"
                disabled={isBulkSelling}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkSell}
                disabled={isBulkSelling}
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-red-800 text-white rounded transition-colors flex items-center justify-center"
              >
                {isBulkSelling ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
                    Selling...
                  </>
                ) : (
                  `Sell All (${selectedTokens.size})`
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ✅ NEW: Replace the old share modal with the new modular one */}
      <PnLShareModal
        isOpen={isShareModalOpen}
        onClose={hideShareModal}
        shareData={shareData}
        onCopySuccess={() => console.log("Tweet text copied!")}
      />
      <TradeOutcomeModal {...outcomeModalProps} />
    </div>
  );
}
