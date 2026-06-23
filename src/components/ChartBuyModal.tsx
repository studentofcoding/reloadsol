"use client";

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useWallet, useConnection } from "@/components/WalletProvider";
import { useWalletTokens } from "@/hooks/useWalletTokens";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { useChartTokenInfo } from "@/hooks/useChartTokenInfo";
import { useAxiomRisk } from "@/hooks/useAxiomRisk";
import PhantomWalletButton from "@/components/PhantomWalletButton";
import RiskAnalysis from "@/components/RiskAnalysis";
import TransactionResultModal from "@/components/TransactionResultModal";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  executeBulkBuy,
  isValidMintAddress,
  fetchUserTokensEfficient,
  UserToken,
} from "@/utils/jupiter";
import {
  SLIPPAGE_OPTIONS,
  PRIORITY_FEE_OPTIONS,
  getSolPriceUSD,
} from "@/utils/solana";
import { BulkBuyRequest, BulkBuyResult } from "@/types";
import { trackBuy } from "@/utils/operations-api";
import { fetchTokenPricesForTracking } from "@/utils/trading-tracker";
import { useTradingData } from "@/components/TradingDataProvider";
import { usePostBuyRefresh } from "@/hooks/usePostBuyRefresh";

interface TokenInfo {
  symbol: string;
  name: string;
  price: number;
  address: string;
  logoURI?: string;
  decimals: number;
  marketCap?: number;
}

interface RiskInfo {
  overallRisk: "LOW" | "MEDIUM" | "HIGH";
  organicScore: number;
  insidersHoldPercent: number;
  bundlersHoldPercent: number;
  snipersHoldPercent: number;
  top10HoldersPercent: number;
}

interface ChartBuyModalProps {
  tokenAddress: string | null;
  onClose: () => void;
  initialBuyAmount?: string;
  // Navigation props
  onNavigate?: (direction: "prev" | "next") => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

export default function ChartBuyModal({
  tokenAddress,
  onClose,
  initialBuyAmount = "0.01",
  onNavigate,
  hasPrev = false,
  hasNext = false,
}: ChartBuyModalProps) {
  const { publicKey, signAllTransactions, connected } = useWallet();
  const { connection } = useConnection();
  const { trackOperation } = useTradingData();
  const triggerPostBuyRefresh = usePostBuyRefresh();
  const walletAddress = connected && publicKey ? publicKey.toString() : null;
  const validTokenAddress =
    tokenAddress && isValidMintAddress(tokenAddress) ? tokenAddress : null;

  const lastUpdateRef = useRef<number>(Date.now());

  const {
    data: chartTokenInfo,
    isLoading,
    error: tokenQueryError,
  } = useChartTokenInfo(validTokenAddress);

  const tokenInfo: TokenInfo | null = useMemo(
    () =>
      chartTokenInfo
        ? {
            symbol: chartTokenInfo.symbol,
            name: chartTokenInfo.name,
            price: chartTokenInfo.price,
            address: chartTokenInfo.address,
            logoURI: chartTokenInfo.logoURI,
            decimals: chartTokenInfo.decimals,
            marketCap: chartTokenInfo.marketCap,
          }
        : null,
    [chartTokenInfo],
  );

  const fetchError = !validTokenAddress
    ? "Invalid token address"
    : tokenQueryError instanceof Error
      ? tokenQueryError.message
      : "";

  const { allTokens, refetchTokens } = useWalletTokens({
    connection,
    publicKey,
    walletAddress,
    activeRpcUrl: connection.rpcEndpoint,
    enabled: connected && !!publicKey && !!validTokenAddress,
  });

  const currentPosition = useMemo(() => {
    if (!validTokenAddress) return null;
    return (
      allTokens.find(
        (token) =>
          token.mintAddress === validTokenAddress &&
          token.uiAmount > 0.001 &&
          !token.frozen &&
          !token.isNFT,
      ) ?? null
    );
  }, [allTokens, validTokenAddress]);

  const isLoadingPositions = false;

  const { walletBalance, refreshBalances } = useWalletBalances({
    connection,
    publicKey,
    walletAddress,
    enabled: connected && !!publicKey,
  });

  // Buy form state
  const [buyAmount, setBuyAmount] = useState(initialBuyAmount);
  const [slippage, setSlippage] = useState<number>(200); // 2%
  const [priorityFee, setPriorityFee] = useState<number>(30000); // 0.0003 SOL
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Transaction state
  const [isBuying, setIsBuying] = useState(false);
  const [result, setResult] = useState<BulkBuyResult | null>(null);
  const [pointsEarned, setPointsEarned] = useState<number | undefined>(
    undefined,
  );
  const [error, setError] = useState<string>("");
  const displayError = error || fetchError;
  const [riskInfo, setRiskInfo] = useState<RiskInfo | null>(null);

  const axiomQuery = useAxiomRisk(
    validTokenAddress ?? "",
    tokenInfo?.marketCap ?? 0,
    !!validTokenAddress && (tokenInfo?.marketCap ?? 0) > 0,
  );

  const derivedRiskInfo = useMemo((): RiskInfo | null => {
    if (!axiomQuery.data) return null;
    const axiomData = axiomQuery.data.axiomData;
    let organicScore = 100;
    if (axiomData.insidersHoldPercent > 15) organicScore -= 25;
    else if (axiomData.insidersHoldPercent > 8) organicScore -= 15;
    if (axiomData.bundlersHoldPercent > 10) organicScore -= 20;
    else if (axiomData.bundlersHoldPercent > 5) organicScore -= 10;
    if (axiomData.snipersHoldPercent > 8) organicScore -= 15;
    else if (axiomData.snipersHoldPercent > 4) organicScore -= 8;
    if (axiomData.top10HoldersPercent > 60) organicScore -= 20;
    else if (axiomData.top10HoldersPercent > 40) organicScore -= 10;
    const overallRisk =
      organicScore >= 70 ? "LOW" : organicScore >= 40 ? "MEDIUM" : "HIGH";
    return {
      overallRisk,
      organicScore: Math.max(0, organicScore),
      insidersHoldPercent: axiomData.insidersHoldPercent,
      bundlersHoldPercent: axiomData.bundlersHoldPercent,
      snipersHoldPercent: axiomData.snipersHoldPercent,
      top10HoldersPercent: axiomData.top10HoldersPercent,
    };
  }, [axiomQuery.data]);

  const effectiveRiskInfo = derivedRiskInfo ?? riskInfo;
  const [showResultModal, setShowResultModal] = useState<boolean>(false);
  const [balanceBefore, setBalanceBefore] = useState<number>(0);
  const [balanceAfter, setBalanceAfter] = useState<number>(0);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!onNavigate) return;

      // Ignore if typing in an input field
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        onNavigate("prev");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        onNavigate("next");
      } else if (e.key === "ArrowLeft") {
        // Also support left/right for convenience
        e.preventDefault();
        onNavigate("prev");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNavigate("next");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNavigate]);

  // Create the GMGN chart URL with correct format
  const gmgnChartUrl = tokenAddress
    ? `https://www.gmgn.cc/kline/sol/${tokenAddress}?interval=1H`
    : "";

  const handleBuy = useCallback(async () => {
    if (!connected || !publicKey || !signAllTransactions || !tokenAddress) {
      setError("Please connect your wallet first");
      return;
    }

    if (!buyAmount || parseFloat(buyAmount) <= 0) {
      setError("Please enter a valid SOL amount");
      return;
    }

    if (!tokenInfo) {
      setError("Token information not loaded");
      return;
    }

    setIsBuying(true);
    setPointsEarned(undefined);
    setError("");
    setResult(null);

    try {
      const balanceBeforeOp = await connection.getBalance(publicKey);
      const balanceBeforeSOL = balanceBeforeOp / LAMPORTS_PER_SOL;
      setBalanceBefore(balanceBeforeSOL);

      const requiredAmount =
        parseFloat(buyAmount) + priorityFee / LAMPORTS_PER_SOL;

      if (balanceBeforeSOL < requiredAmount) {
        throw new Error(
          `Insufficient balance. Required: ${requiredAmount.toFixed(4)} SOL, Available: ${balanceBeforeSOL.toFixed(4)} SOL`,
        );
      }

      const request: BulkBuyRequest = {
        solAmount: parseFloat(buyAmount),
        tokenMints: [tokenAddress],
        slippage,
        priorityFee,
      };

      const buyResult = await executeBulkBuy(
        request,
        publicKey.toString(),
        connection,
        signAllTransactions,
      );

      const balanceAfterOp = await connection.getBalance(publicKey);
      const balanceAfterSOL = balanceAfterOp / LAMPORTS_PER_SOL;
      setBalanceAfter(balanceAfterSOL);

      setResult(buyResult);

      if (
        buyResult &&
        (buyResult.successfulPurchases.length > 0 ||
          buyResult.failedPurchases.length > 0)
      ) {
        setShowResultModal(true);
      }

      if (buyResult) {
        try {
          const trackResult = await trackBuy(
            publicKey.toString(),
            buyResult.successfulPurchases.length,
            {
              failureCount: buyResult.failedPurchases.length,
              solAmount: parseFloat(buyAmount),
              tokenMints: [tokenAddress],
              signatures: buyResult.signatures,
            },
          );
          setPointsEarned(trackResult.pointsEarned);
        } catch (trackError) {
          console.error(
            "Failed to track buy operation for points:",
            trackError,
          );
        }

        try {
          const currentSolPrice = await getSolPriceUSD();
          const tokenPrices = await fetchTokenPricesForTracking([tokenAddress]);
          const priceUsd =
            tokenPrices[tokenAddress] || tokenInfo.price || 0;
          const buySol = parseFloat(buyAmount);
          const tokenAmount =
            priceUsd > 0 && buySol > 0 && currentSolPrice > 0
              ? (buySol * currentSolPrice) / priceUsd
              : 0;

          const tokenData = [
            {
              mintAddress: tokenAddress,
              symbol: tokenInfo.symbol,
              name: tokenInfo.name,
              logoURI: tokenInfo.logoURI,
              priceUsd,
              tokenAmount,
              solAmount: buySol,
            },
          ];

          await trackOperation({
            walletAddress: publicKey.toString(),
            operationType: "buy",
            tokens: tokenData.map((token) => ({
              ...token,
              solPrice: currentSolPrice,
            })),
            successCount: buyResult.successfulPurchases.length,
            failureCount: buyResult.failedPurchases.length,
            totalTokens: 1,
            solAmount: parseFloat(buyAmount),
            feesPaid: 0,
            solPriceUsd: currentSolPrice,
            totalUsdValue: currentSolPrice
              ? parseFloat(buyAmount) * currentSolPrice
              : undefined,
            signatures: buyResult.signatures,
            slippage: slippage / 100,
            priorityFee,
            errors:
              buyResult.failedPurchases.length > 0
                ? buyResult.failedPurchases.map((f) => f.error)
                : undefined,
          });
        } catch (trackError) {
          console.error(
            "Failed to track buy operation for history/PnL:",
            trackError,
          );
        }
      }

      if (buyResult.success) {
        setBuyAmount(initialBuyAmount);
        triggerPostBuyRefresh({
          refreshWalletTokens: (forceRefresh) => refetchTokens(forceRefresh),
          refreshBalances,
        });
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unknown error occurred",
      );
    } finally {
      setIsBuying(false);
    }
  }, [
    connected,
    publicKey,
    signAllTransactions,
    connection,
    buyAmount,
    tokenAddress,
    slippage,
    priorityFee,
    tokenInfo,
    trackOperation,
    refetchTokens,
    refreshBalances,
    triggerPostBuyRefresh,
    initialBuyAmount,
  ]);

  const getRiskBadgeColor = (risk: "LOW" | "MEDIUM" | "HIGH") => {
    switch (risk) {
      case "LOW":
        return "bg-green-900/20 text-green-400 border-green-400/30";
      case "MEDIUM":
        return "bg-yellow-900/20 text-yellow-400 border-yellow-400/30";
      case "HIGH":
        return "bg-red-900/20 text-red-400 border-red-400/30";
    }
  };

  if (!tokenAddress) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-gray-900 rounded-xl w-full max-w-6xl max-h-[90vh] overflow-y-auto border border-gray-700 shadow-2xl">
        {/* Header */}
        <div className="bg-gray-800 p-4 sticky top-0 z-10 flex justify-between items-center border-b border-gray-700">
          <div className="flex items-center space-x-3">
            {tokenInfo?.logoURI && (
              <OptimizedImage
                src={tokenInfo.logoURI}
                alt={tokenInfo.symbol}
                className="w-8 h-8 rounded-full"
              />
            )}
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                {tokenInfo
                  ? `${tokenInfo.symbol} - ${tokenInfo.name}`
                  : "Loading..."}
                {effectiveRiskInfo && (
                  <span
                    className={`px-2 py-0.5 rounded text-xs border ${getRiskBadgeColor(effectiveRiskInfo.overallRisk)}`}
                  >
                    {effectiveRiskInfo.overallRisk} RISK
                  </span>
                )}
              </h2>
              <div className="text-sm text-gray-400 font-mono">
                {tokenAddress}
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            {onNavigate && (
              <div className="flex bg-gray-700 rounded-lg p-1 mr-2">
                <button
                  onClick={() => onNavigate("prev")}
                  disabled={!hasPrev}
                  className="p-1 text-gray-400 hover:text-white hover:bg-gray-600 rounded disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Previous Token (Up Arrow)"
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
                      d="M5 15l7-7 7 7"
                    />
                  </svg>
                </button>
                <button
                  onClick={() => onNavigate("next")}
                  disabled={!hasNext}
                  className="p-1 text-gray-400 hover:text-white hover:bg-gray-600 rounded disabled:opacity-30 disabled:hover:bg-transparent"
                  title="Next Token (Down Arrow)"
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
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
              </div>
            )}
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white text-2xl px-2"
            >
              ×
            </button>
          </div>
        </div>

        <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left Column: Chart */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-gray-800 rounded-lg p-1 min-h-[500px] flex flex-col">
              <div className="flex justify-between px-2 py-1 bg-gray-700/50 rounded-t-lg">
                <span className="text-xs text-gray-400">
                  Price Chart (GMGN)
                </span>
              </div>
              <div className="flex-1 relative">
                <iframe
                  src={gmgnChartUrl}
                  className="w-full h-full min-h-[500px]"
                  title="Chart"
                  frameBorder="0"
                />
              </div>
            </div>

            {/* Risk Analysis */}
            {tokenInfo?.marketCap && (
              <div className="bg-gray-800 rounded-lg p-4">
                <RiskAnalysis
                  tokenAddress={tokenAddress}
                  marketCap={tokenInfo.marketCap}
                  defaultExpanded={false}
                />
              </div>
            )}
          </div>

          {/* Right Column: Buy & Info */}
          <div className="space-y-4">
            {/* Quick Stats */}
            <div className="bg-gray-800 rounded-lg p-4 grid grid-cols-2 gap-2">
              <div>
                <div className="text-xs text-gray-400">Price</div>
                <div className="text-white font-mono">
                  ${tokenInfo?.price?.toFixed(8) || "..."}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-400">MCap</div>
                <div className="text-white font-mono">
                  ${tokenInfo?.marketCap?.toLocaleString() || "..."}
                </div>
              </div>
            </div>

            {/* Position Card */}
            {connected && (
              <div className="bg-gray-800 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-300 mb-2">
                  Your Position
                </h3>
                {isLoadingPositions ? (
                  <div className="text-xs text-gray-500">Loading...</div>
                ) : currentPosition ? (
                  <div className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Balance:</span>
                      <span className="text-white">
                        {currentPosition.uiAmount.toLocaleString()}{" "}
                        {tokenInfo?.symbol}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-400">Value:</span>
                      <span className="text-white">
                        ${currentPosition.usdValue?.toFixed(2) || "0.00"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-gray-500">No position found</div>
                )}
              </div>
            )}

            {/* Buy Form */}
            <div className="bg-gray-800 rounded-lg p-4 space-y-4 border border-blue-500/20">
              <div className="flex justify-between items-center">
                <h3 className="text-lg font-bold text-white">Quick Buy</h3>
                <div className="text-xs text-gray-400">
                  Bal: {walletBalance?.toFixed(4) || "0"} SOL
                </div>
              </div>

              {!connected ? (
                <PhantomWalletButton />
              ) : (
                <>
                  <div className="space-y-2">
                    <label className="text-xs text-gray-400">
                      Amount (SOL)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        value={buyAmount}
                        onChange={(e) => setBuyAmount(e.target.value)}
                        className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white w-full"
                        step="0.01"
                      />
                      <button
                        onClick={() => setBuyAmount("0.1")}
                        className="px-2 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300"
                      >
                        0.1
                      </button>
                      <button
                        onClick={() => setBuyAmount("0.5")}
                        className="px-2 bg-gray-700 hover:bg-gray-600 rounded text-xs text-gray-300"
                      >
                        0.5
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
                  >
                    {showAdvanced ? "▼" : "▶"} Advanced Settings
                  </button>

                  {showAdvanced && (
                    <div className="grid grid-cols-2 gap-2 bg-gray-700/30 p-2 rounded">
                      <div>
                        <label className="text-xs text-gray-500">
                          Slippage
                        </label>
                        <select
                          value={slippage}
                          onChange={(e) => setSlippage(Number(e.target.value))}
                          className="w-full bg-gray-700 border border-gray-600 rounded text-xs px-2 py-1 text-white"
                        >
                          {SLIPPAGE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">
                          Priority Fee
                        </label>
                        <select
                          value={priorityFee}
                          onChange={(e) =>
                            setPriorityFee(Number(e.target.value))
                          }
                          className="w-full bg-gray-700 border border-gray-600 rounded text-xs px-2 py-1 text-white"
                        >
                          {PRIORITY_FEE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}

                  <button
                    onClick={handleBuy}
                    disabled={isBuying || !tokenInfo}
                    className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white py-3 rounded-lg font-bold text-lg transition-all active:scale-95"
                  >
                    {isBuying ? "Processing..." : `Buy ${buyAmount} SOL`}
                  </button>

                  {error && (
                    <div className="p-2 bg-red-900/30 border border-red-500/30 rounded text-xs text-red-400">
                      {error}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {showResultModal && result && (
        <TransactionResultModal
          isOpen={showResultModal}
          operation="buy"
          result={result}
          pointsEarned={pointsEarned}
          balanceBefore={balanceBefore}
          balanceAfter={balanceAfter}
          onClose={() => setShowResultModal(false)}
        />
      )}
    </div>
  );
}
