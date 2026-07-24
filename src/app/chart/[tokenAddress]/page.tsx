"use client";

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useWallet, useConnection } from "@/components/WalletProvider";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { useRpc } from "@/contexts/RpcContext";
import { useWalletTokens } from "@/hooks/useWalletTokens";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { useChartTokenInfo } from "@/hooks/useChartTokenInfo";
import { useAxiomRisk } from "@/hooks/useAxiomRisk";
import UniversalWalletButton from "@/components/UniversalWalletButton";
import RiskAnalysis from "@/components/RiskAnalysis";
import TransactionResultModal from "@/components/TransactionResultModal";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  executeBulkBuy,
  isValidMintAddress,
  UserToken,
} from "@/utils/jupiter";
import { fetchTokenPricesForTracking, tradingTracker } from "@/utils/trading-tracker";
import {
  SLIPPAGE_OPTIONS,
  PRIORITY_FEE_OPTIONS,
  getSolPriceUSD,
} from "@/utils/solana";
import { BulkBuyRequest, BulkBuyResult } from "@/types";
import { trackBuy } from "@/utils/operations-api";
import { getGmgnKlineUrl, inferGmgnChain, type GmgnChain } from "@/utils/gmgn";
import TradeProviderBar from "@/components/TradeProviderBar";

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

export default function ChartPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { publicKey, signAllTransactions, connected } = useWallet();
  const { connection } = useConnection();
  const { activeRpcUrl } = useRpc();

  const { network } = useAppNetwork();
  const tokenAddress = params.tokenAddress as string;
  const chainParam = searchParams.get("chain");
  const chartChain: GmgnChain =
    chainParam === "sol" ||
    chainParam === "robinhood" ||
    chainParam === "bsc" ||
    chainParam === "base" ||
    chainParam === "eth"
      ? chainParam
      : network === "robinhood" || network === "sol"
        ? network
        : inferGmgnChain(tokenAddress);
  const validTokenAddress =
    tokenAddress &&
    (chartChain === "robinhood"
      ? /^0x[a-fA-F0-9]{40}$/i.test(tokenAddress)
      : isValidMintAddress(tokenAddress))
      ? tokenAddress
      : null;
  const walletAddress = connected && publicKey ? publicKey.toString() : null;

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
    activeRpcUrl,
    enabled: connected && !!publicKey && !!validTokenAddress,
    includeZeroBalance: false,
    refetchInterval: connected && publicKey ? 30_000 : false,
  });

  const userTokens = useMemo(
    () =>
      allTokens.filter(
        (token) => token.uiAmount > 0.001 && !token.frozen && !token.isNFT,
      ),
    [allTokens],
  );

  const currentPosition = useMemo(() => {
    if (!validTokenAddress) return null;
    return (
      userTokens.find((token) => token.mintAddress === validTokenAddress) ??
      null
    );
  }, [userTokens, validTokenAddress]);

  const isLoadingPositions = false;

  const { walletBalance, refreshBalances } = useWalletBalances({
    connection,
    publicKey,
    walletAddress,
    enabled: connected && !!publicKey,
  });

  const axiomQuery = useAxiomRisk(
    validTokenAddress ?? "",
    tokenInfo?.marketCap ?? 0,
    !!validTokenAddress && (tokenInfo?.marketCap ?? 0) > 0,
  );

  const riskInfo = useMemo((): RiskInfo | null => {
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

  const gmgnChartUrl = getGmgnKlineUrl(tokenAddress, {
    interval: "5",
    theme: "dark",
    chain: chartChain,
  });

  // Buy form state
  const [buyAmount, setBuyAmount] = useState("0.1");
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
  const [showResultModal, setShowResultModal] = useState<boolean>(false);

  // Balance tracking
  const [balanceBefore, setBalanceBefore] = useState<number>(0);
  const [balanceAfter, setBalanceAfter] = useState<number>(0);

  const handleBuy = useCallback(async () => {
    if (!connected || !publicKey || !signAllTransactions) {
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

    if (!connection) {
      setError("RPC connection not ready");
      return;
    }

    setIsBuying(true);
    setPointsEarned(undefined);
    setError("");
    setResult(null);

    try {
      // Get balance before operation
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

      // Get balance after operation
      const balanceAfterOp = await connection.getBalance(publicKey);
      const balanceAfterSOL = balanceAfterOp / LAMPORTS_PER_SOL;
      setBalanceAfter(balanceAfterSOL);

      setResult(buyResult);

      // Only show modal if there were actual transaction attempts (success or failure)
      if (
        buyResult &&
        (buyResult.successfulPurchases.length > 0 ||
          buyResult.failedPurchases.length > 0)
      ) {
        setShowResultModal(true);
      }

      // Track the buy operation for points
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
          console.log(
            `🎉 Earned ${trackResult.pointsEarned} points from buy operation!`,
          );
          setPointsEarned(trackResult.pointsEarned);
        } catch (trackError) {
          console.error(
            "Failed to track buy operation for points:",
            trackError,
          );
        }

        // Track operation for PnL and history via React Query
        try {
          const { fetchTokenPricesForTracking } =
            await import("@/utils/trading-tracker");

          const [tokenPrices, currentSolPrice] = await Promise.all([
            fetchTokenPricesForTracking([tokenAddress]),
            getSolPriceUSD(),
          ]);

          const tokenData = [
            {
              mintAddress: tokenAddress,
              symbol: tokenInfo.symbol,
              name: tokenInfo.name,
              logoURI: tokenInfo.logoURI,
              priceUsd: tokenPrices[tokenAddress] || 0,
              tokenAmount: 0, // We don't have exact token amounts from buy result
              solAmount: parseFloat(buyAmount),
            },
          ];

          // Track via centralized React Query system
          await tradingTracker.trackOperation({
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
        // Reset form on success
        setBuyAmount("0.1");

        // Immediately refresh positions after successful buy
        console.log("✅ Buy successful, refreshing positions...");
        setTimeout(() => {
          void refetchTokens(false);
          void refreshBalances();
        }, 2000);
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
    refetchTokens,
    refreshBalances,
  ]);

  const handleBackToHome = () => {
    router.push("/");
  };

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

  // Slider value (percentage of wallet balance)
  const maxPercent = 96;
  const sliderValue =
    walletBalance && buyAmount
      ? Math.round((parseFloat(buyAmount) / walletBalance) * 100)
      : 0;

  const handleSliderChange = (value: number) => {
    if (walletBalance) {
      const newAmount = ((walletBalance * value) / 100).toFixed(4);
      setBuyAmount(newAmount);
    }
  };

  if (displayError && !tokenInfo) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-400 mb-4">Error</h1>
          <p className="text-gray-400 mb-4">{displayError}</p>
          <button
            onClick={handleBackToHome}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="max-w-7xl mx-auto px-4 pt-3">
        <TradeProviderBar />
      </div>
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 p-4">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          <div className="flex items-center space-x-4">
            <button
              onClick={handleBackToHome}
              className="text-gray-400 hover:text-white transition-colors"
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
                  d="M10 19l-7-7m0 0l7-7m-7 7h18"
                />
              </svg>
            </button>
            <div className="flex items-center space-x-3">
              {tokenInfo?.logoURI && (
                <OptimizedImage
                  src={tokenInfo.logoURI}
                  alt={tokenInfo.symbol}
                  className="w-8 h-8 rounded-full"
                  fallback={
                    <div className="w-8 h-8 bg-gray-700 rounded-full flex items-center justify-center text-white text-sm font-bold">
                      {(tokenInfo.symbol || "?").charAt(0).toUpperCase()}
                    </div>
                  }
                />
              )}
              <div>
                <h1 className="text-xl font-bold">
                  {tokenInfo
                    ? `${tokenInfo.symbol} - ${tokenInfo.name}`
                    : "Loading..."}
                </h1>
                <div className="flex items-center space-x-3">
                  <p className="text-gray-400 text-sm">
                    {tokenInfo && tokenInfo.price > 0
                      ? `$${tokenInfo.price.toFixed(8)}`
                      : "Price: N/A"}
                  </p>
                  {tokenInfo?.marketCap && (
                    <p className="text-gray-400 text-sm">
                      MCap: ${tokenInfo.marketCap.toLocaleString()}
                    </p>
                  )}
                  {riskInfo && (
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium border ${getRiskBadgeColor(riskInfo.overallRisk)}`}
                    >
                      {riskInfo.overallRisk} RISK ({riskInfo.organicScore}/100)
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Buy Section */}
          <div className="flex items-center space-x-3">
            {!connected ? (
              <UniversalWalletButton />
            ) : (
              <>
                <div className="flex flex-col">
                  <label className="text-xs text-gray-400 mb-1">
                    Amount (SOL)
                  </label>
                  <input
                    type="number"
                    value={buyAmount}
                    onChange={(e) => setBuyAmount(e.target.value)}
                    className="bg-gray-700 border border-gray-600 rounded px-3 py-2 text-white w-24 text-sm"
                    step="0.01"
                    min="0.01"
                    max="10"
                    disabled={isBuying}
                  />
                </div>
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-gray-400 hover:text-white text-sm"
                  disabled={isBuying}
                >
                  ⚙️
                </button>
                <button
                  onClick={handleBuy}
                  disabled={isBuying || !tokenInfo}
                  className="bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  {isBuying ? "Buying..." : "Buy"}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Wallet Balance and Slider */}
        {connected && walletBalance !== null && (
          <div className="max-w-7xl mx-auto mt-4 p-3 bg-gray-700/50 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-400">
                Wallet Balance: {walletBalance.toFixed(4)} SOL
              </span>
              <span className="text-sm text-gray-400">
                {sliderValue}% of balance
              </span>
            </div>
            <input
              type="range"
              min="1"
              max={maxPercent}
              value={sliderValue}
              onChange={(e) => handleSliderChange(Number(e.target.value))}
              className="w-full h-2 bg-gray-600 rounded-lg appearance-none cursor-pointer slider"
              disabled={isBuying}
            />
            <div className="flex justify-between mt-1">
              <button
                onClick={() => handleSliderChange(10)}
                className="text-xs text-gray-400 hover:text-white"
                disabled={isBuying}
              >
                10%
              </button>
              <button
                onClick={() => handleSliderChange(25)}
                className="text-xs text-gray-400 hover:text-white"
                disabled={isBuying}
              >
                25%
              </button>
              <button
                onClick={() => handleSliderChange(50)}
                className="text-xs text-gray-400 hover:text-white"
                disabled={isBuying}
              >
                50%
              </button>
              <button
                onClick={() => handleSliderChange(75)}
                className="text-xs text-gray-400 hover:text-white"
                disabled={isBuying}
              >
                75%
              </button>
              <button
                onClick={() => handleSliderChange(maxPercent)}
                className="text-xs text-gray-400 hover:text-white"
                disabled={isBuying}
              >
                Max
              </button>
            </div>
          </div>
        )}

        {/* Advanced Settings */}
        {showAdvanced && connected && (
          <div className="max-w-7xl mx-auto mt-4 p-4 bg-gray-700 rounded-lg">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Slippage (%)
                </label>
                <select
                  value={slippage}
                  onChange={(e) => setSlippage(Number(e.target.value))}
                  className="bg-gray-600 border border-gray-500 rounded px-3 py-2 text-white text-sm w-full"
                  disabled={isBuying}
                >
                  {SLIPPAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Priority Fee
                </label>
                <select
                  value={priorityFee}
                  onChange={(e) => setPriorityFee(Number(e.target.value))}
                  className="bg-gray-600 border border-gray-500 rounded px-3 py-2 text-white text-sm w-full"
                  disabled={isBuying}
                >
                  {PRIORITY_FEE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Error Display */}
        {displayError && (
          <div className="max-w-7xl mx-auto mt-4 p-3 bg-red-900/20 border border-red-400/30 rounded-lg">
            <p className="text-red-400 text-sm">{displayError}</p>
          </div>
        )}
      </div>

      {/* Enhanced Current Position Display */}
      {connected && (
        <div className="bg-gray-800 border-b border-gray-700 p-4">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold text-white">
                Your Position
              </h3>
              <div className="flex items-center space-x-2 text-xs text-gray-400">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                <span>Live updates every 30s</span>
              </div>
            </div>

            {isLoadingPositions ? (
              <div className="flex items-center space-x-2 text-gray-400">
                <div className="w-4 h-4 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
                <span>Loading positions...</span>
              </div>
            ) : currentPosition ? (
              <div className="bg-gray-700/50 rounded-lg p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs text-gray-400 mb-1">
                      Token Amount
                    </div>
                    <div className="text-white font-medium">
                      {currentPosition.uiAmount.toLocaleString(undefined, {
                        maximumFractionDigits: 6,
                      })}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-400 mb-1">USD Value</div>
                    {currentPosition.usdValue &&
                    currentPosition.usdValue > 0 ? (
                      <div className="text-white font-medium">
                        ${currentPosition.usdValue.toFixed(2)}
                      </div>
                    ) : (
                      <div className="text-gray-400 text-sm">
                        Calculating...
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs text-gray-400 mb-1">
                      Token Price
                    </div>
                    <div className="text-white font-medium">
                      {tokenInfo?.price
                        ? `$${tokenInfo.price.toFixed(8)}`
                        : "N/A"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-400 mb-1">
                      Last Updated
                    </div>
                    <div className="text-white font-medium text-xs">
                      {new Date(lastUpdateRef.current).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-gray-700/30 rounded-lg p-4 border-2 border-dashed border-gray-600">
                <div className="text-center text-gray-400">
                  <div className="text-lg mb-1">📊</div>
                  <div>No position in this token</div>
                  <div className="text-sm mt-1">
                    Buy some tokens to see your position here
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Risk Analysis Section */}
      {tokenInfo && tokenInfo.marketCap && tokenInfo.marketCap > 0 && (
        <div className="bg-gray-800 border-b border-gray-700 p-4">
          <div className="max-w-7xl mx-auto">
            <RiskAnalysis
              tokenAddress={tokenAddress}
              marketCap={tokenInfo.marketCap}
              defaultExpanded={false}
            />
          </div>
        </div>
      )}

      {/* Chart Container */}
      <div className="relative max-w-7xl mx-auto" style={{ height: "70vh" }}>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <div className="w-12 h-12 border-4 border-gray-400 border-t-white rounded-full animate-spin"></div>
          </div>
        )}
        <iframe
          src={gmgnChartUrl}
          className="w-full h-full"
          style={{
            border: "none",
            minHeight: "600px",
          }}
          title={`GMGN Chart - ${tokenInfo?.symbol || tokenAddress}`}
          allowFullScreen
          frameBorder="0"
        />
      </div>

      {/* Footer */}
      <div className="bg-gray-800 border-t border-gray-700 p-4">
        <div className="max-w-7xl mx-auto text-center">
          <p className="text-gray-400 text-sm">
            Token Address:{" "}
            <span className="text-white font-mono text-xs">{tokenAddress}</span>
          </p>
          <p className="text-gray-500 text-xs mt-1">
            Chart powered by GMGN.cc • Risk analysis by Axiom
          </p>
        </div>
      </div>

      {/* Transaction Result Modal */}
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
