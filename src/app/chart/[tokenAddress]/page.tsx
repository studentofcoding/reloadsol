"use client";

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useWallet, useConnection } from "@/components/WalletProvider";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { useRhEvmWallet } from "@/hooks/useRhEvmWallet";
import { connectedSellPath } from "@/config/route-network";
import { useRpc } from "@/contexts/RpcContext";
import { useWalletTokens } from "@/hooks/useWalletTokens";
import { useChartTokenInfo } from "@/hooks/useChartTokenInfo";
import { useAxiomRisk } from "@/hooks/useAxiomRisk";
import UniversalWalletButton from "@/components/UniversalWalletButton";
import RiskAnalysis from "@/components/RiskAnalysis";
import TradeProviderBar from "@/components/TradeProviderBar";
import RowTradePanel from "@/components/signals/shared/RowTradePanel";
import { useSolRowHoldings } from "@/hooks/useSolRowHoldings";
import { isValidMintAddress } from "@/utils/jupiter";
import { getGmgnKlineUrl, inferGmgnChain, type GmgnChain } from "@/utils/gmgn";
import type { TrackerTradeSide } from "@/utils/tracker-base-asset";

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
  const { publicKey, connected } = useWallet();
  const { connection } = useConnection();
  const { activeRpcUrl } = useRpc();
  const { network } = useAppNetwork();
  const rh = useRhEvmWallet();
  const tokenAddress = params.tokenAddress as string;
  const chainParam = searchParams.get("chain");
  const chainFromAddress: GmgnChain | null = tokenAddress
    ? /^0x[a-fA-F0-9]{40}$/i.test(tokenAddress)
      ? "robinhood"
      : isValidMintAddress(tokenAddress)
        ? "sol"
        : null
    : null;
  const chartChain: GmgnChain =
    chainParam === "sol" ||
    chainParam === "robinhood" ||
    chainParam === "bsc" ||
    chainParam === "base" ||
    chainParam === "eth"
      ? chainParam
      : (chainFromAddress ??
        (network === "robinhood" || network === "sol"
          ? network
          : inferGmgnChain(tokenAddress)));
  const validTokenAddress =
    tokenAddress &&
    (chartChain === "robinhood"
      ? /^0x[a-fA-F0-9]{40}$/i.test(tokenAddress)
      : isValidMintAddress(tokenAddress))
      ? tokenAddress
      : null;
  const walletAddress = connected && publicKey ? publicKey.toString() : null;
  const isSolChart = chartChain === "sol";

  const lastUpdateRef = useRef<number>(Date.now());
  const [tradeSide, setTradeSide] = useState<TrackerTradeSide | null>(null);

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

  const {
    allTokens,
    refetchFresh,
    isPending: tokensIsPending,
  } = useWalletTokens({
    connection,
    publicKey,
    walletAddress,
    activeRpcUrl,
    enabled: connected && !!publicKey && !!validTokenAddress && isSolChart,
    refetchInterval: connected && publicKey && isSolChart ? 30_000 : false,
  });

  const rowHoldings = useSolRowHoldings(isSolChart);

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

  const heldToken = validTokenAddress
    ? rowHoldings.heldTokenByMint.get(validTokenAddress.trim().toLowerCase())
    : undefined;

  const isLoadingPositions = allTokens.length === 0 && tokensIsPending;

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

  const handleBackToHome = () => {
    router.push(
      connectedSellPath(connected, Boolean(rh.address), network) ?? "/",
    );
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

  if (fetchError && !tokenInfo) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-400 mb-4">Error</h1>
          <p className="text-gray-400 mb-4">{fetchError}</p>
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

  const symbol = tokenInfo?.symbol ?? tokenAddress.slice(0, 8);

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="max-w-7xl mx-auto px-4 pt-3">
        <TradeProviderBar />
      </div>
      <div className="bg-gray-800 border-b border-gray-700 p-4">
        <div className="flex items-center justify-between max-w-7xl mx-auto flex-wrap gap-3">
          <div className="flex items-center space-x-4">
            <button
              onClick={handleBackToHome}
              className="text-gray-400 hover:text-white transition-colors"
              type="button"
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

          <div className="flex items-center space-x-2">
            {!connected ? (
              <UniversalWalletButton />
            ) : isSolChart ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setTradeSide((s) => (s === "buy" ? null : "buy"))
                  }
                  className={`px-4 py-2 rounded-lg text-sm font-medium ${
                    tradeSide === "buy"
                      ? "bg-green-700 ring-1 ring-green-300 text-white"
                      : "bg-green-600 hover:bg-green-700 text-white"
                  }`}
                >
                  Buy
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setTradeSide((s) => (s === "sell" ? null : "sell"))
                  }
                  className={`px-4 py-2 rounded-lg text-sm font-medium ${
                    tradeSide === "sell"
                      ? "bg-amber-700 ring-1 ring-amber-300 text-white"
                      : "bg-amber-600 hover:bg-amber-700 text-white"
                  }`}
                >
                  Sell
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => {
                  window.location.href = "/sell";
                }}
                className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 rounded-lg font-medium"
              >
                Trade on /sell
              </button>
            )}
          </div>
        </div>

        {isSolChart && tradeSide && validTokenAddress && (
          <div className="max-w-7xl mx-auto mt-3">
            <RowTradePanel
              tokenAddress={validTokenAddress}
              tokenSymbol={symbol}
              side={tradeSide}
              usdtUi={rowHoldings.usdtUi}
              usdtReady={rowHoldings.usdtReady}
              holding={
                heldToken
                  ? {
                      balanceRaw: heldToken.balance,
                      uiAmount: heldToken.uiAmount,
                      decimals: heldToken.decimals,
                    }
                  : null
              }
              onClose={() => setTradeSide(null)}
              onSettled={() => {
                void refetchFresh();
                void rowHoldings.refetchFresh();
                lastUpdateRef.current = Date.now();
              }}
            />
          </div>
        )}

        {fetchError ? (
          <div className="max-w-7xl mx-auto mt-4 p-3 bg-red-900/20 border border-red-400/30 rounded-lg">
            <p className="text-red-400 text-sm">{fetchError}</p>
          </div>
        ) : null}
      </div>

      {connected && isSolChart && (
        <div className="bg-gray-800 border-b border-gray-700 p-4">
          <div className="max-w-7xl mx-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold text-white">Your Position</h3>
              <div className="flex items-center space-x-2 text-xs text-gray-400">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                <span>Live updates every 30s</span>
              </div>
            </div>

            {isLoadingPositions ? (
              <div className="flex items-center space-x-2 text-gray-400">
                <div className="w-4 h-4 border-2 border-gray-400 border-t-white rounded-full animate-spin" />
                <span>Loading positions...</span>
              </div>
            ) : currentPosition ? (
              <div className="bg-gray-700/50 rounded-lg p-4">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-xs text-gray-400 mb-1">Token Amount</div>
                    <div className="text-white font-medium">
                      {currentPosition.uiAmount.toLocaleString(undefined, {
                        maximumFractionDigits: 6,
                      })}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-400 mb-1">USD Value</div>
                    {currentPosition.usdValue && currentPosition.usdValue > 0 ? (
                      <div className="text-white font-medium">
                        ${currentPosition.usdValue.toFixed(2)}
                      </div>
                    ) : (
                      <div className="text-gray-400 text-sm">Calculating...</div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs text-gray-400 mb-1">Token Price</div>
                    <div className="text-white font-medium">
                      {tokenInfo?.price
                        ? `$${tokenInfo.price.toFixed(8)}`
                        : "N/A"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-400 mb-1">Last Updated</div>
                    <div className="text-white font-medium text-xs">
                      {new Date(lastUpdateRef.current).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-gray-700/30 rounded-lg p-4 border-2 border-dashed border-gray-600">
                <div className="text-center text-gray-400">
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

      <div className="relative max-w-7xl mx-auto" style={{ height: "70vh" }}>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <div className="w-12 h-12 border-4 border-gray-400 border-t-white rounded-full animate-spin" />
          </div>
        )}
        <iframe
          src={gmgnChartUrl}
          className="w-full h-full"
          style={{ border: "none", minHeight: "600px" }}
          title={`GMGN Chart - ${tokenInfo?.symbol || tokenAddress}`}
          allowFullScreen
        />
      </div>

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
    </div>
  );
}
