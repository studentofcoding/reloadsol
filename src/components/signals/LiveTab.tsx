"use client";

import { OptimizedImage } from "@/components/OptimizedImage";
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLiveTrendingTokens } from "@/hooks/useLiveTrendingTokens";
import { useWalletTokens } from "@/hooks/useWalletTokens";
import { useOwnedTokenPrices } from "@/hooks/useOwnedTokenPrices";
import { boardTabUrl } from "@/components/signals/shared/parseAddresses";
import GmgnChartEmbed from "@/components/signals/shared/GmgnChartEmbed";
import DlmmChartActions from "@/components/dlmm/DlmmChartActions";
import GlobalWatchlistButton from "@/components/GlobalWatchlistButton";
import { useRugList } from "@/hooks/useRugList";
import { useRouter } from "next/navigation";
import { useWallet, useConnection } from "@/components/WalletProvider";
import { useRpc } from "@/contexts/RpcContext";
import { useTradingData } from "@/components/TradingDataProvider";
import { useSolPrice } from "@/hooks/useSolPrice";
import { trackRealBuy, trackRealSell, trackSimBuy, trackSimClose } from "@/utils/trade-tracking";
import { buildEntryMcapFeatures } from "@/strategies/outcome-features";
import { useSignalsStrategy } from "@/hooks/useSignalsStrategy";
import { computeOpenSimCycle } from "@/utils/simulation-trades";
import { PublicKey } from "@solana/web3.js";
import { formatNumber, formatCurrency } from "@/utils/formatters";
import {
  getSwapQuote,
  fetchUserTokens,
  UserToken,
} from "@/utils/jupiter";
import { executeClientSwap } from "@/utils/swap-executor";
import { TOKENS } from "@/utils/solana";
import {
  fetchAxiomTokenInfo,
  getRiskIndicators,
  formatRiskDisplay,
  calculateFeeToMarketCapRatio,
  AxiomTokenInfo,
  RiskIndicators,
} from "@/utils/axiom";
import { notifyTradingUpdate } from "@/utils/trading-notifications";
import TradeOutcomeModal, { useTradeOutcome } from "@/components/TradeOutcomeModal";

interface TrendingToken {
  token_address: string;
  token_symbol: string;
  price: number;
  change_1h: number;
  change_5m: number;
  buy_volume_1h: number;
  sell_volume_1h: number;
  buy_volume_5m: number;
  sell_volume_5m: number;
  volume_1h: number;
  volume_5m: number;
  mcap: number;
  logo_url?: string;
  organic_score: number;
  last_updated?: number;
  created_at?: number;
}

interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee?: {
    amount: string;
    feeBps: number;
  };
  priceImpactPct: string;
  routePlan: any[];
}

interface OwnedTokenInfo {
  balance: number;
  usdValue: number;
  pnlPercentage?: number;
  buyPrice?: number;
  currentPrice?: number;
}

// Helper to batch fetch prices for owned tokens
async function fetchOwnedTokenPrices(
  tokenMints: string[],
): Promise<Record<string, number>> {
  if (!tokenMints.length) return {};
  try {
    const resp = await fetch(
      `/api/tokens/prices?tokens=${tokenMints.join(",")}`,
    );
    if (!resp.ok) throw new Error("Failed to fetch prices");
    const data = await resp.json();
    // Assume data.prices is { mint: price }
    return data.prices || {};
  } catch (e) {
    console.error("Failed to fetch owned token prices:", e);
    return {};
  }
}

export default function LiveTab() {
  const { strategyId, template, setTemplate } = useSignalsStrategy();
  const router = useRouter();
  const { connected, publicKey, signTransaction, signAllTransactions } =
    useWallet();
  const { connection } = useConnection();
  const { activeRpcUrl } = useRpc();
  const { records, trackOperation } = useTradingData();
  const { data: currentSolPrice = 0 } = useSolPrice();
  const { showOutcome, outcomeModalProps } = useTradeOutcome();
  const { isRugged: isTokenRugged, markRug, unmarkRug } = useRugList();
  const walletAddress = connected && publicKey ? publicKey.toString() : null;

  const trendingQuery = useLiveTrendingTokens(5 * 60 * 1000);
  const { refetch: refetchTrending } = trendingQuery;

  const {
    allTokens: walletTokenList,
    refetchTokens,
  } = useWalletTokens({
    connection,
    publicKey,
    walletAddress,
    activeRpcUrl,
    enabled: connected && !!publicKey,
    includeZeroBalance: false,
  });

  const userTokens = useMemo(
    () => walletTokenList.filter((t) => !t.isNFT),
    [walletTokenList],
  );

  const ownedMints = useMemo(
    () =>
      userTokens
        .filter((t) => t.uiAmount > 0.001)
        .map((t) => t.mintAddress),
    [userTokens],
  );

  const ownedPricesQuery = useOwnedTokenPrices(ownedMints);
  const ownedTokenPrices = ownedPricesQuery.data ?? {};

  const [tokens, setTokens] = useState<TrendingToken[]>([]);
  const loading = trendingQuery.isLoading && tokens.length === 0;
  const [error, setError] = useState<string | null>(null);
  const [highlightedTokens, setHighlightedTokens] = useState<Set<string>>(
    new Set(),
  );
  const [buyingTokens, setBuyingTokens] = useState<Set<string>>(new Set());
  const [sellingTokens, setSellingTokens] = useState<Set<string>>(new Set());
  const [quotes, setQuotes] = useState<Map<string, JupiterQuote>>(new Map());
  const [sellQuotes, setSellQuotes] = useState<Map<string, JupiterQuote>>(
    new Map(),
  );
  const [buyAmount, setBuyAmount] = useState<number>(0.1); // Default 0.1 SOL
  const [newTokens, setNewTokens] = useState<Set<string>>(new Set()); // Track new tokens for animation
  const [loadingQuotes, setLoadingQuotes] = useState<Set<string>>(new Set()); // Track which tokens are loading quotes
  const previousPricesRef = useRef<Map<string, number>>(new Map());
  const previousTokensRef = useRef<Set<string>>(new Set()); // Track previous token addresses
  const quoteTimestamps = useRef<Map<string, number>>(new Map()); // Track quote timestamps for expiration
  // Add new state for tracking which token is being hovered
  const [hoveredToken, setHoveredToken] = useState<string | null>(null);
  const [hoveredChartToken, setHoveredChartToken] = useState<string | null>(
    null,
  );
  const [debouncedChartToken, setDebouncedChartToken] = useState<string | null>(
    null,
  );
  const [quoteErrors, setQuoteErrors] = useState<Map<string, string>>(
    new Map(),
  );
  // Add state for auto-update indicator and hover tracking
  const [autoUpdateProgress, setAutoUpdateProgress] = useState(0);
  const [isAnyTokenHovered, setIsAnyTokenHovered] = useState(false);
  const autoUpdateIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const autoUpdateProgressRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const delay = hoveredChartToken ? 150 : 0;
    const timer = setTimeout(() => {
      setDebouncedChartToken(hoveredChartToken);
    }, delay);
    return () => clearTimeout(timer);
  }, [hoveredChartToken]);

  // Add sidebar state for owned token prices, sell quotes, and loading
  const [sidebarSellQuotes, setSidebarSellQuotes] = useState<
    Record<string, JupiterQuote | null>
  >({});
  const [sidebarSelling, setSidebarSelling] = useState<Record<string, boolean>>(
    {},
  );
  const [sidebarHovered, setSidebarHovered] = useState<string | null>(null);
  const [axiomData, setAxiomData] = useState<
    Map<
      string,
      {
        data: AxiomTokenInfo | null;
        risk: RiskIndicators | null;
        pairNotFound?: boolean;
      }
    >
  >(new Map());
  const [loadingAxiom, setLoadingAxiom] = useState<Set<string>>(new Set());

  // State for kept and ignored tokens
  const [keptTokenIds, setKeptTokenIds] = useState<Set<string>>(new Set());
  const [ignoredTokenIds, setIgnoredTokenIds] = useState<Set<string>>(
    new Set(),
  );
  const [keptTokensData, setKeptTokensData] = useState<
    Map<string, TrendingToken>
  >(new Map());
  const [tokenLabels, setTokenLabels] = useState<Record<string, string>>({});

  // Fetch labels from server
  useEffect(() => {
    async function fetchLabels() {
      try {
        const res = await fetch("/api/signals");
        const json = await res.json();
        if (json.success && Array.isArray(json.data)) {
          const map: Record<string, string> = {};
          json.data.forEach((item: any) => {
            map[item.token_address] = item.label;
          });
          setTokenLabels(map);

          // Also sync to kept tokens (watchlist)
          setKeptTokenIds((prev) => {
            const newKeptIds = new Set(prev);
            let changed = false;
            json.data.forEach((item: any) => {
              if (
                ["watching", "potential", "rugged"].includes(item.label) &&
                !newKeptIds.has(item.token_address)
              ) {
                newKeptIds.add(item.token_address);
                changed = true;
              }
            });
            return changed ? newKeptIds : prev;
          });
        }
      } catch (e) {
        console.error("Failed to fetch labels", e);
      }
    }
    fetchLabels();
  }, []);

  const handleLabelToken = async (
    token: TrendingToken,
    label: "potential" | "rugged",
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    const currentLabel = tokenLabels[token.token_address];

    let targetLabel: string | null = label;
    if (label === "rugged") {
      const alreadyRugged =
        currentLabel === "rugged" || isTokenRugged(token.token_address);
      targetLabel = alreadyRugged ? "watching" : "rugged";
    } else if (currentLabel === label) {
      targetLabel = "watching";
    }

    // Optimistic update
    setTokenLabels((prev) => ({
      ...prev,
      [token.token_address]: targetLabel!,
    }));

    // Ensure it's in the kept list
    if (!keptTokenIds.has(token.token_address)) {
      const newKeptIds = new Set(keptTokenIds).add(token.token_address);
      setKeptTokenIds(newKeptIds);
      setKeptTokensData((prev) =>
        new Map(prev).set(token.token_address, token),
      );
    }

    try {
      if (label === "rugged") {
        if (targetLabel === "watching") {
          await unmarkRug(token.token_address);
        } else {
          await markRug({
            tokenAddress: token.token_address,
            tokenSymbol: token.token_symbol,
            source: "live",
          });
        }
        return;
      }

      await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenAddress: token.token_address,
          tokenSymbol: token.token_symbol,
          mcap: token.mcap,
          price: token.price,
          initialPrice: token.price, // Explicitly set initial price
          label: targetLabel,
        }),
      });
    } catch (err) {
      console.error("Failed to update label", err);
    }
  };

  // Fetch user's wallet tokens — derived from useWalletTokens
  const ownedTokens = useMemo(() => {
    const ownedMap = new Map<string, OwnedTokenInfo>();
    userTokens.forEach((token) => {
      if (token.uiAmount > 0.001) {
        const buyRecords = records.filter(
          (record) =>
            record.operationType === "buy" &&
            record.tokens.some((t) => t.mintAddress === token.mintAddress),
        );

        let totalSolSpent = 0;
        let totalTokensBought = 0;

        buyRecords.forEach((record) => {
          const tokenInRecord = record.tokens.find(
            (t) => t.mintAddress === token.mintAddress,
          );
          if (tokenInRecord && record.solAmount) {
            const solPerToken = record.solAmount / record.successCount;
            totalSolSpent += solPerToken;
            totalTokensBought += tokenInRecord.tokenAmount || 0;
          }
        });

        const avgBuyPrice =
          totalTokensBought > 0 ? totalSolSpent / totalTokensBought : 0;
        const currentPrice = token.usdValue / token.uiAmount;
        const pnlPercentage =
          avgBuyPrice > 0
            ? ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100
            : 0;

        ownedMap.set(token.mintAddress, {
          balance: token.uiAmount,
          usdValue: token.usdValue,
          pnlPercentage: totalSolSpent > 0 ? pnlPercentage : undefined,
          buyPrice: avgBuyPrice > 0 ? avgBuyPrice : undefined,
          currentPrice,
        });
      }
    });
    return ownedMap;
  }, [userTokens, records]);

  const recordsKey = useMemo(() => records.length, [records]);

  useQuery({
    queryKey: ["live-wallet-sync", walletAddress, recordsKey],
    queryFn: async () => {
      await refetchTokens();
      return true;
    },
    enabled: connected && !!publicKey,
  });

  // Fetch trending tokens with filtering and sorting
  const processTrendingData = useCallback(
    async (rawTokens?: TrendingToken[]) => {
      try {
        let fetchedTokens: TrendingToken[] = rawTokens ?? [];

        if (!rawTokens) {
          const response = await fetch("/api/trending?cache=off", {
            cache: "no-store",
          });
          if (!response.ok) throw new Error("Failed to fetch trending tokens");
          const data = await response.json();
          fetchedTokens = (data.tokens ?? []).filter((token: TrendingToken) => {
            const mcap = token.mcap || 0;
            return mcap > 0 && mcap <= 300000;
          });
        }

        fetchedTokens = fetchedTokens.filter(
          (t) => !ignoredTokenIds.has(t.token_address),
        );

        const currentKeptTokensMap = new Map(keptTokensData);
        const keptIds = Array.from(keptTokenIds);
        const missingKeptIds: string[] = [];

        keptIds.forEach((id) => {
          const found = fetchedTokens.find((t) => t.token_address === id);
          if (found) {
            currentKeptTokensMap.set(id, found);
          } else {
            const existing = currentKeptTokensMap.get(id);
            if (existing) {
              missingKeptIds.push(id);
            }
          }
        });

        if (missingKeptIds.length > 0) {
          try {
            const prices = await fetchOwnedTokenPrices(missingKeptIds);
            missingKeptIds.forEach((id) => {
              const existingData = currentKeptTokensMap.get(id);
              if (existingData && prices[id]) {
                const newPrice = prices[id];
                const priceRatio = existingData.price
                  ? newPrice / existingData.price
                  : 1;
                currentKeptTokensMap.set(id, {
                  ...existingData,
                  price: newPrice,
                  mcap: existingData.mcap * priceRatio,
                });
              }
            });
          } catch (err) {
            console.error("Failed to update prices for kept tokens", err);
          }
        }

        setKeptTokensData(currentKeptTokensMap);

        const missingKeptTokens = Array.from(
          currentKeptTokensMap.values(),
        ).filter(
          (kt) =>
            !fetchedTokens.some((ft) => ft.token_address === kt.token_address),
        );

        const finalTokens = [...fetchedTokens, ...missingKeptTokens];

        finalTokens.sort((a, b) => {
          const isKeptA = keptTokenIds.has(a.token_address);
          const isKeptB = keptTokenIds.has(b.token_address);
          if (isKeptA && !isKeptB) return -1;
          if (!isKeptA && isKeptB) return 1;
          return (a.mcap || 0) - (b.mcap || 0);
        });

        const currentTokenAddresses = new Set(
          finalTokens.map((t) => t.token_address),
        );
        const newTokenAddresses = new Set<string>();

        if (!previousTokensRef.current) {
          previousTokensRef.current = new Set<string>();
        }

        for (const address of Array.from(currentTokenAddresses) as string[]) {
          if (!previousTokensRef.current.has(address as string)) {
            newTokenAddresses.add(address as string);
          }
        }

        previousTokensRef.current = new Set<string>(
          Array.from(currentTokenAddresses) as string[],
        );

        if (newTokenAddresses.size > 0) {
          setNewTokens(new Set<string>(Array.from(newTokenAddresses) as string[]));
          setTimeout(() => {
            setNewTokens(new Set<string>());
          }, 3000);
        }

        setTokens(finalTokens);
        setError(null);
      } catch (err) {
        console.error("Error fetching trending tokens:", err);
        setError("Failed to load trending tokens");
      }
    },
    [ignoredTokenIds, keptTokensData, keptTokenIds],
  );

  const fetchTrendingTokens = useCallback(async () => {
    await processTrendingData(trendingQuery.data);
  }, [processTrendingData, trendingQuery.data]);

  useQuery({
    queryKey: [
      "live-tokens-process",
      trendingQuery.dataUpdatedAt,
      Array.from(ignoredTokenIds).join(","),
      Array.from(keptTokenIds).join(","),
    ],
    queryFn: async () => {
      if (trendingQuery.data) {
        await processTrendingData(trendingQuery.data);
      }
      return true;
    },
    enabled: !!trendingQuery.data,
  });

  // Toggle Keep Token
  const handleKeepToken = async (token: TrendingToken, e: React.MouseEvent) => {
    e.stopPropagation();
    const isKept = keptTokenIds.has(token.token_address);
    let newKeptIds: Set<string>;

    if (isKept) {
      // Remove from kept
      newKeptIds = new Set(keptTokenIds);
      newKeptIds.delete(token.token_address);
      setKeptTokenIds(newKeptIds);
      setKeptTokensData((prev) => {
        const m = new Map(prev);
        m.delete(token.token_address);
        return m;
      });

      // Also remove label from backend (untrack)
      setTokenLabels((prev) => {
        const next = { ...prev };
        delete next[token.token_address];
        return next;
      });
      try {
        await fetch(`/api/signals?tokenAddress=${token.token_address}`, {
          method: "DELETE",
        });
      } catch (e) {
        console.error(e);
      }
    } else {
      // Add to kept
      newKeptIds = new Set(keptTokenIds).add(token.token_address);
      setKeptTokenIds(newKeptIds);
      setKeptTokensData((prev) =>
        new Map(prev).set(token.token_address, token),
      );

      // Add 'watching' label to backend
      setTokenLabels((prev) => ({
        ...prev,
        [token.token_address]: "watching",
      }));
      try {
        await fetch("/api/signals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenAddress: token.token_address,
            tokenSymbol: token.token_symbol,
            mcap: token.mcap,
            price: token.price,
            label: "watching",
          }),
        });
      } catch (e) {
        console.error(e);
      }
    }

    // Re-sort current tokens immediately
    setTokens((prev) => {
      const sorted = [...prev].sort((a, b) => {
        const isKeptA = newKeptIds.has(a.token_address);
        const isKeptB = newKeptIds.has(b.token_address);
        if (isKeptA && !isKeptB) return -1;
        if (!isKeptA && isKeptB) return 1;
        return (a.mcap || 0) - (b.mcap || 0);
      });
      return sorted;
    });
  };

  // Toggle Ignore Token
  const handleIgnoreToken = (token: TrendingToken, e: React.MouseEvent) => {
    e.stopPropagation();
    // Add to ignored
    setIgnoredTokenIds((prev) => new Set(prev).add(token.token_address));
    // Remove from kept if present
    if (keptTokenIds.has(token.token_address)) {
      setKeptTokenIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(token.token_address);
        return newSet;
      });
      setKeptTokensData((prev) => {
        const m = new Map(prev);
        m.delete(token.token_address);
        return m;
      });
    }
    // Remove from current view immediately
    setTokens((prev) =>
      prev.filter((t) => t.token_address !== token.token_address),
    );
  };

  // Fetch single quote on hover with caching and reset on mouse leave
  const fetchSingleBuyQuote = async (token: TrendingToken) => {
    if (buyAmount <= 0) return;
    const tokenAddress = token.token_address;
    // Prevent duplicate fetches
    if (loadingQuotes.has(tokenAddress)) return;
    setLoadingQuotes((prev) => new Set(prev).add(tokenAddress));
    setQuoteErrors((prev) => {
      const m = new Map(prev);
      m.delete(tokenAddress);
      return m;
    });
    try {
      const inputAmount = Math.floor(buyAmount * 1e9); // Convert SOL to lamports
      const quote = await getSwapQuote(
        TOKENS.SOL,
        tokenAddress,
        inputAmount,
        300, // 3% slippage
      );
      if (quote) {
        setQuotes((prev) => new Map(prev).set(tokenAddress, quote));
        quoteTimestamps.current.set(tokenAddress, Date.now());
      } else {
        setQuoteErrors((prev) => {
          const m = new Map(prev);
          m.set(tokenAddress, "No quote available");
          return m;
        });
      }
    } catch (err) {
      setQuoteErrors((prev) => {
        const m = new Map(prev);
        m.set(tokenAddress, "Failed to fetch quote");
        return m;
      });
      console.error(`Failed to get buy quote for ${token.token_symbol}:`, err);
    } finally {
      setLoadingQuotes((prev) => {
        const newSet = new Set(prev);
        newSet.delete(tokenAddress);
        return newSet;
      });
    }
  };

  // Handle token hover to fetch quote
  const handleTokenHover = (token: TrendingToken) => {
    const ownedInfo = ownedTokens.get(token.token_address);
    const isOwned = ownedInfo && ownedInfo.balance > 0.001;
    if (!isOwned) {
      setHoveredToken(token.token_address);
      fetchSingleBuyQuote(token);
    }
  };

  // Handle mouse leave to reset quote state
  const handleTokenMouseLeave = (token: TrendingToken) => {
    setHoveredToken(null);
    setQuotes((prev) => {
      const m = new Map(prev);
      m.delete(token.token_address);
      return m;
    });
    setLoadingQuotes((prev) => {
      const s = new Set(prev);
      s.delete(token.token_address);
      return s;
    });
    setQuoteErrors((prev) => {
      const m = new Map(prev);
      m.delete(token.token_address);
      return m;
    });
  };

  // Fetch Jupiter quotes for buying — removed (no auto-quoting on hover)

  // Check for price changes and highlight tokens
  const checkPriceChanges = useCallback(() => {
    const newHighlighted = new Set<string>();

    tokens.forEach((token) => {
      const previousPrice = previousPricesRef.current.get(token.token_address);
      if (previousPrice && previousPrice !== token.price) {
        const changePercent = Math.abs(
          ((token.price - previousPrice) / previousPrice) * 100,
        );
        if (changePercent >= 5) {
          newHighlighted.add(token.token_address);
        }
      }
      previousPricesRef.current.set(token.token_address, token.price);
    });

    setHighlightedTokens(newHighlighted);

    // Clear highlights after 3 seconds
    if (newHighlighted.size > 0) {
      setTimeout(() => {
        setHighlightedTokens(new Set());
      }, 3000);
    }
  }, [tokens]);

  // Fetch Jupiter quotes for selling owned tokens
  const fetchSellQuotes = useCallback(async () => {
    if (!userTokens.length) return;

    try {
      const sellQuotePromises = userTokens
        .filter((token) => token.uiAmount > 0.001)
        .map(async (token) => {
          try {
            const sellAmount = Math.floor(token.balance); // Use raw balance for quote
            const quote = await getSwapQuote(
              token.mintAddress,
              TOKENS.SOL,
              sellAmount,
              300, // 3% slippage
            );
            return quote ? { mint: token.mintAddress, quote } : null;
          } catch (err) {
            console.error(`Failed to get sell quote for ${token.symbol}:`, err);
            return null;
          }
        });

      const results = await Promise.all(sellQuotePromises);
      const newSellQuotes = new Map<string, JupiterQuote>();

      results.forEach((result) => {
        if (result) {
          newSellQuotes.set(result.mint, result.quote);
        }
      });

      setSellQuotes(newSellQuotes);
    } catch (err) {
      console.error("Error fetching sell quotes:", err);
    }
  }, [userTokens]);

  // Execute buy transaction using existing Jupiter utilities
  const handleBuyToken = async (token: TrendingToken) => {
    if (!connected || !publicKey || !signTransaction) {
      alert("Please connect your wallet first");
      return;
    }

    const quote = quotes.get(token.token_address);
    if (!quote) {
      alert("No quote available for this token");
      return;
    }

    if (!connection) {
      alert("RPC connection not ready");
      return;
    }

    setBuyingTokens((prev) => new Set(prev).add(token.token_address));

    try {
      const inputAmount = Math.floor(buyAmount * 1e9);

      const swapResult = await executeClientSwap({
        userPublicKey: publicKey.toString(),
        inputMint: TOKENS.SOL,
        outputMint: token.token_address,
        amount: inputAmount,
        slippageBps: quote.slippageBps ?? 300,
        priorityFeeLamports: 30000,
        connection,
        signTransaction,
      });

      const signature = swapResult.signature;
      const tokenAmount =
        swapResult.outAmount != null
          ? parseInt(swapResult.outAmount, 10) / Math.pow(10, 6)
          : parseInt(quote.outAmount, 10) / Math.pow(10, 6);

      await trackRealBuy(trackOperation, {
        walletAddress: publicKey.toString(),
        tokens: [
          {
            mintAddress: token.token_address,
            symbol: token.token_symbol,
            name: token.token_symbol,
            logoURI: token.logo_url,
            tokenAmount,
            solAmount: buyAmount,
          },
        ],
        signatures: [signature],
        solAmount: buyAmount,
        feesPaid: 0,
        slippage: 300,
        priorityFee: 30000,
        bot_strategy: strategyId,
      });

      showOutcome({
        success: true,
        operation: "buy",
        isSimulation: false,
        tokenSymbol: token.token_symbol,
        mintAddress: token.token_address,
        solAmount: buyAmount,
      });

      // Refresh wallet tokens and quotes
      await refetchTokens();
      await fetchSellQuotes();
    } catch (err) {
      console.error("Error buying token:", err);
      showOutcome({
        success: false,
        operation: "buy",
        isSimulation: false,
        tokenSymbol: token.token_symbol,
        mintAddress: token.token_address,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setBuyingTokens((prev) => {
        const newSet = new Set(prev);
        newSet.delete(token.token_address);
        return newSet;
      });
    }
  };

  const handleSimulateBuyToken = async (token: TrendingToken) => {
    if (!connected || !publicKey) {
      alert("Please connect your wallet first");
      return;
    }

    const quote = quotes.get(token.token_address);
    if (!quote) {
      alert("No quote available for this token");
      return;
    }

    try {
      // Calculate amounts
      const solAmount = buyAmount;
      // Use raw output amount from quote and normalize it (assuming decimals from quote or default 6 for SOL/SPL)
      // Note: Jupiter quote outAmount is raw integer.
      // We don't have decimals in token info here easily without checking cache or extra call.
      // But for simulation record, we can store approximate or wait for better data.
      // Ideally we should know the decimals. TrendingToken doesn't have it?
      // TOKENS list might have it if it's a known token.

      const estimatedTokenAmount = parseInt(quote.outAmount) / Math.pow(10, 6);

      await trackSimBuy(trackOperation, {
        walletAddress: publicKey.toString(),
        mintAddress: token.token_address,
        symbol: token.token_symbol,
        name: token.token_symbol,
        logoURI: token.logo_url,
        solAmount,
        tokenAmount: estimatedTokenAmount,
        priceUsd:
          currentSolPrice && estimatedTokenAmount > 0
            ? (solAmount * currentSolPrice) / estimatedTokenAmount
            : 0,
        botStrategy: strategyId,
        simulationType: "manual",
        entryFeatures: {
          token_symbol: token.token_symbol,
          organic_score: token.organic_score,
          change_1h: token.change_1h,
          change_5m: token.change_5m,
          ...buildEntryMcapFeatures(token.mcap),
          close_source: "manual_ui",
          ui_tab: "live",
        },
      });

      showOutcome({
        success: true,
        operation: "buy",
        isSimulation: true,
        tokenSymbol: token.token_symbol,
        mintAddress: token.token_address,
        solAmount,
      });
    } catch (err) {
      console.error("Error simulating buy:", err);
      showOutcome({
        success: false,
        operation: "buy",
        isSimulation: true,
        tokenSymbol: token.token_symbol,
        mintAddress: token.token_address,
        error: err instanceof Error ? err.message : "Failed to save simulation",
      });
    }
  };

  const handleSimulateSellToken = async (token: TrendingToken) => {
    if (!connected || !publicKey) {
      alert("Please connect your wallet first");
      return;
    }

    try {
      const { solReceived } = await trackSimClose({
        walletAddress: publicKey.toString(),
        mintAddress: token.token_address,
        records,
        trackOperation,
        symbol: token.token_symbol,
        name: token.token_symbol,
        logoURI: token.logo_url,
      });

      showOutcome({
        success: true,
        operation: "sell",
        isSimulation: true,
        tokenSymbol: token.token_symbol,
        mintAddress: token.token_address,
        solAmount: solReceived,
      });
    } catch (err) {
      console.error("Error closing simulation:", err);
      showOutcome({
        success: false,
        operation: "sell",
        isSimulation: true,
        tokenSymbol: token.token_symbol,
        mintAddress: token.token_address,
        error:
          err instanceof Error ? err.message : "Failed to close simulation",
      });
    }
  };

  // Execute sell transaction using existing Jupiter utilities
  const handleSellToken = async (token: TrendingToken) => {
    if (!connected || !publicKey || !signAllTransactions) {
      alert("Please connect your wallet first");
      return;
    }

    const sellQuote = sellQuotes.get(token.token_address);
    const ownedInfo = ownedTokens.get(token.token_address);

    if (!sellQuote || !ownedInfo) {
      alert("No sell quote available for this token");
      return;
    }

    if (!connection) {
      alert("RPC connection not ready");
      return;
    }

    setSellingTokens((prev) => new Set(prev).add(token.token_address));

    try {
      const expectedSol = parseInt(sellQuote.outAmount, 10) / 1e9;

      const swapResult = await executeClientSwap({
        userPublicKey: publicKey.toString(),
        inputMint: sellQuote.inputMint,
        outputMint: sellQuote.outputMint,
        amount: sellQuote.inAmount,
        slippageBps: sellQuote.slippageBps ?? 300,
        priorityFeeLamports: 30000,
        connection,
        signTransaction: async (tx) => {
          const [signed] = await signAllTransactions!([tx]);
          return signed;
        },
      });

      const signature = swapResult.signature;

      const tokenSold = ownedInfo.balance || 0;

      await trackRealSell(trackOperation, {
        walletAddress: publicKey.toString(),
        tokens: [
          {
            mintAddress: token.token_address,
            symbol: token.token_symbol,
            name: token.token_symbol,
            logoURI: token.logo_url,
            tokenAmount: tokenSold,
            solAmount: expectedSol,
          },
        ],
        signatures: [signature],
        solAmount: expectedSol,
        feesPaid: 0,
        slippage: 300,
        priorityFee: 30000,
      });

      // After successful sell, notify other devices
      if (publicKey) {
        await notifyTradingUpdate(publicKey.toString(), "trade_update", {
          operationType: "sell",
          tokenAddress: token.token_address,
          tokenSymbol: token.token_symbol,
          amount: 100, // 100% sell
        });
      }

      showOutcome({
        success: true,
        operation: "sell",
        isSimulation: false,
        tokenSymbol: token.token_symbol,
        mintAddress: token.token_address,
        solAmount: expectedSol,
      });

      // Refresh wallet tokens and quotes
      await refetchTokens();
      await fetchSellQuotes();
    } catch (err) {
      console.error("Error selling token:", err);
      showOutcome({
        success: false,
        operation: "sell",
        isSimulation: false,
        tokenSymbol: token.token_symbol,
        mintAddress: token.token_address,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSellingTokens((prev) => {
        const newSet = new Set(prev);
        newSet.delete(token.token_address);
        return newSet;
      });
    }
  };

  // Format time ago
  const formatTimeAgo = (dateString: string) => {
    const now = new Date();
    const created = new Date(dateString);
    const diffMs = now.getTime() - created.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays}d ago`;
    if (diffHours > 0) return `${diffHours}h ago`;
    return "Just now";
  };

  const userTokensKey = useMemo(
    () => userTokens.map((t) => t.mintAddress).join(","),
    [userTokens],
  );

  useQuery({
    queryKey: [
      "live-price-changes",
      tokens.map((t) => `${t.token_address}:${t.price}`).join("|"),
    ],
    queryFn: async () => {
      checkPriceChanges();
      return true;
    },
    enabled: tokens.length > 0,
  });

  useQuery({
    queryKey: ["live-sell-quotes", userTokensKey],
    queryFn: async () => {
      await fetchSellQuotes();
      return true;
    },
    enabled: userTokens.length > 0,
  });

  const autoUpdateDepsKey = `${isAnyTokenHovered}-${keptTokenIds.size}-${ignoredTokenIds.size}`;
  const prevAutoUpdateKeyRef = useRef(autoUpdateDepsKey);
  if (prevAutoUpdateKeyRef.current !== autoUpdateDepsKey) {
    prevAutoUpdateKeyRef.current = autoUpdateDepsKey;
    setAutoUpdateProgress(0);
  }

  useEffect(() => {
    if (isAnyTokenHovered) {
      if (autoUpdateIntervalRef.current)
        clearInterval(autoUpdateIntervalRef.current);
      if (autoUpdateProgressRef.current)
        clearInterval(autoUpdateProgressRef.current);
      return;
    }

    let progress = 0;
    autoUpdateProgressRef.current = setInterval(() => {
      progress += 2;
      setAutoUpdateProgress(progress);
      if (progress >= 100) progress = 0;
    }, 100);

    autoUpdateIntervalRef.current = setInterval(() => {
      void refetchTrending();
      setAutoUpdateProgress(0);
      progress = 0;
    }, 5000);

    return () => {
      if (autoUpdateIntervalRef.current)
        clearInterval(autoUpdateIntervalRef.current);
      if (autoUpdateProgressRef.current)
        clearInterval(autoUpdateProgressRef.current);
    };
  }, [isAnyTokenHovered, autoUpdateDepsKey, refetchTrending]);

  // Fetch sell quote for sidebar position on hover
  const handleSidebarHover = async (token: UserToken) => {
    setSidebarHovered(token.mintAddress);
    setSidebarSellQuotes((prev) => ({ ...prev, [token.mintAddress]: null }));
    try {
      const sellAmount = Math.floor(token.balance);
      const quote = await getSwapQuote(
        token.mintAddress,
        TOKENS.SOL,
        sellAmount,
        300, // 3% slippage
      );
      setSidebarSellQuotes((prev) => ({ ...prev, [token.mintAddress]: quote }));
    } catch {
      setSidebarSellQuotes((prev) => ({ ...prev, [token.mintAddress]: null }));
    }
  };
  const handleSidebarMouseLeave = (token: UserToken) => {
    setSidebarHovered(null);
    setSidebarSellQuotes((prev) => ({ ...prev, [token.mintAddress]: null }));
  };

  // Fetch Axiom data for a token
  const fetchAxiomData = async (tokenAddress: string) => {
    if (loadingAxiom.has(tokenAddress) || axiomData.has(tokenAddress)) return;

    setLoadingAxiom((prev) => new Set(prev).add(tokenAddress));

    try {
      const result = await fetchAxiomTokenInfo(tokenAddress);
      if (result.success && result.data) {
        // Find the token to get its market cap for fee analysis
        const token = tokens.find((t) => t.token_address === tokenAddress);
        const marketCap = token?.mcap || 0;
        const risk = getRiskIndicators(result.data, marketCap);
        setAxiomData((prev) =>
          new Map(prev).set(tokenAddress, { data: result.data!, risk }),
        );
      } else if (result.requiresAuth) {
        // Handle authentication error gracefully
        console.warn(
          "Axiom API requires authentication - risk data unavailable",
        );
        // You could show a tooltip or notification here
      } else if (result.pairNotFound) {
        // Handle pair not found error gracefully
        console.warn(
          `Token ${tokenAddress} not found in Axiom database - no risk data available`,
        );
        // Store a special marker to indicate the token was checked but not found
        setAxiomData((prev) =>
          new Map(prev).set(tokenAddress, {
            data: null as any,
            risk: null as any,
            pairNotFound: true,
          }),
        );
      }
    } catch (error) {
      console.error(`Failed to fetch Axiom data for ${tokenAddress}:`, error);
    } finally {
      setLoadingAxiom((prev) => {
        const newSet = new Set(prev);
        newSet.delete(tokenAddress);
        return newSet;
      });
    }
  };

  // Sell handler for sidebar
  const handleSidebarSell = async (token: UserToken) => {
    const quote = sidebarSellQuotes[token.mintAddress];
    if (!quote || !connected || !publicKey || !signAllTransactions || !connection) return;
    setSidebarSelling((prev) => ({ ...prev, [token.mintAddress]: true }));
    try {
      const expectedSol = parseInt(quote.outAmount, 10) / 1e9;
      const swapResult = await executeClientSwap({
        userPublicKey: publicKey.toString(),
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        amount: quote.inAmount,
        slippageBps: quote.slippageBps ?? 300,
        priorityFeeLamports: 30000,
        connection,
        signTransaction: async (tx) => {
          const [signed] = await signAllTransactions!([tx]);
          return signed;
        },
      });
      const signature = swapResult.signature;
      alert(`Successfully sold ${token.symbol}! Transaction: ${signature}`);
      await refetchTokens();
      await fetchSellQuotes();
    } catch (err) {
      alert(`Failed to sell ${token.symbol}`);
    } finally {
      setSidebarSelling((prev) => ({ ...prev, [token.mintAddress]: false }));
    }
  };

  // Helper to handle hover state for all token cards
  const handleTokenCardMouseEnter = (token: TrendingToken) => {
    setIsAnyTokenHovered(true);
    handleTokenHover(token);
  };
  const handleTokenCardMouseLeave = (token: TrendingToken) => {
    setIsAnyTokenHovered(false);
    handleTokenMouseLeave(token);
  };

  const handleOpenCharts = () => {
    const keptAddresses = Array.from(keptTokenIds);
    if (keptAddresses.length === 0) {
      alert("No starred tokens to view in charts");
      return;
    }
    router.push(boardTabUrl(keptAddresses));
  };

  // Token Card Component (defined inline to access state)
  const TokenCard = ({ token }: { token: TrendingToken }) => {
    const isHighlighted = highlightedTokens.has(token.token_address);
    const isBuying = buyingTokens.has(token.token_address);
    const isSelling = sellingTokens.has(token.token_address);
    const isNewToken = newTokens.has(token.token_address);
    const isLoadingQuote = loadingQuotes.has(token.token_address);
    const quote = quotes.get(token.token_address);
    const sellQuote = sellQuotes.get(token.token_address);
    const ownedInfo = ownedTokens.get(token.token_address);
    const isOwned = ownedInfo && ownedInfo.balance > 0.001;
    const isKept = keptTokenIds.has(token.token_address);
    const currentLabel = tokenLabels[token.token_address];
    const isPotential = currentLabel === "potential";
    const isRugged =
      isTokenRugged(token.token_address) || currentLabel === "rugged";
    const expectedTokens = quote
      ? Number(quote.outAmount) / Math.pow(10, 6)
      : 0; // Assuming 6 decimals
    const expectedSol = sellQuote ? parseInt(sellQuote.outAmount) / 1e9 : 0;

    return (
      <div
        className={`bg-gray-800 rounded-xl p-6 border transition-all duration-500 hover:scale-105 ${
          isRugged
            ? "border-red-600 shadow-lg shadow-red-600/20 bg-red-900/10"
            : isPotential
              ? "border-green-400 shadow-lg shadow-green-400/20 bg-green-900/10"
              : isNewToken
                ? "border-cyan-400 shadow-lg shadow-cyan-400/30 animate-bounce-in bg-gradient-to-br from-gray-800 to-cyan-900/20"
                : isHighlighted
                  ? "border-yellow-400 shadow-lg shadow-yellow-400/20 animate-pulse"
                  : isOwned
                    ? "border-green-500 shadow-lg shadow-green-500/20"
                    : "border-gray-700 hover:border-gray-600"
        }`}
        style={{
          animationDelay: isNewToken ? `${Math.random() * 0.5}s` : "0s",
        }}
        onMouseEnter={() => handleTokenCardMouseEnter(token)}
        onMouseLeave={() => handleTokenCardMouseLeave(token)}
      >
        {/* Keep/Ignore Controls */}
        <div className="absolute top-2 right-2 flex gap-1 z-30">
          <button
            onClick={(e) => handleLabelToken(token, "potential", e)}
            className={`p-1.5 rounded-lg border transition-all ${
              isPotential
                ? "bg-green-600 border-green-400 text-white shadow-[0_0_10px_rgba(34,197,94,0.5)]"
                : "bg-gray-800/80 border-gray-600 text-gray-400 hover:text-green-400 hover:border-green-400"
            }`}
            title={isPotential ? "Unmark Potential" : "Mark as Potential"}
          >
            🚀
          </button>
          <button
            onClick={(e) => handleLabelToken(token, "rugged", e)}
            className={`p-1.5 rounded-lg border transition-all ${
              isRugged
                ? "bg-red-600 border-red-400 text-white shadow-[0_0_10px_rgba(239,68,68,0.5)]"
                : "bg-gray-800/80 border-gray-600 text-gray-400 hover:text-red-400 hover:border-red-400"
            }`}
            title={isRugged ? "Unmark Rug" : "Mark as Rug"}
          >
            ☠️
          </button>
          <div className="w-px h-6 bg-gray-700 mx-1 self-center"></div>
          <button
            onClick={(e) => handleKeepToken(token, e)}
            className={`p-1.5 rounded-lg border transition-all ${
              isKept
                ? "bg-blue-600 border-blue-400 text-white shadow-[0_0_10px_rgba(37,99,235,0.5)]"
                : "bg-gray-800/80 border-gray-600 text-gray-400 hover:text-blue-400 hover:border-blue-400"
            }`}
            title={isKept ? "Unkeep token" : "Keep token (always update)"}
          >
            {isKept ? "★" : "+"}
          </button>
          <button
            onClick={(e) => handleIgnoreToken(token, e)}
            className="p-1.5 rounded-lg bg-gray-800/80 border border-gray-600 text-gray-400 hover:text-red-400 hover:border-red-400 transition-all"
            title="Remove token"
          >
            −
          </button>
        </div>

        {/* New Token Indicator */}
        {isNewToken && (
          <div className="flex items-center justify-center mb-3 p-2 bg-cyan-900/30 rounded-lg border border-cyan-400/50 animate-pulse">
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-cyan-400 rounded-full animate-ping"></div>
              <span className="text-cyan-400 text-sm font-bold">
                🚀 NEW POTENTIAL
              </span>
              <div className="w-2 h-2 bg-cyan-400 rounded-full animate-ping"></div>
            </div>
          </div>
        )}

        {/* Owned Token Indicator */}
        {isOwned && (
          <div className="flex items-center justify-between mb-3 p-2 bg-green-900/20 rounded-lg border border-green-500/30">
            <div className="flex items-center space-x-2">
              <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
              <span className="text-green-400 text-sm font-medium">OWNED</span>
            </div>
            <div className="text-right">
              <div className="text-green-400 text-sm font-medium">
                {formatNumber(ownedInfo.balance, 2)} {token.token_symbol}
              </div>
              {ownedInfo.pnlPercentage !== undefined && (
                <div
                  className={`text-xs ${ownedInfo.pnlPercentage >= 0 ? "text-green-400" : "text-red-400"}`}
                >
                  PnL: {ownedInfo.pnlPercentage >= 0 ? "+" : ""}
                  {ownedInfo.pnlPercentage.toFixed(2)}%
                </div>
              )}
            </div>
          </div>
        )}

        {/* Token Header */}
        <div className="flex items-center space-x-3 mb-4">
          <div
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 ${
              isNewToken
                ? "bg-gradient-to-r from-cyan-500 to-blue-500 animate-pulse"
                : "bg-gradient-to-r from-purple-500 to-pink-500"
            }`}
          >
            {token.logo_url ? (
              <OptimizedImage
                src={token.logo_url}
                alt={token.token_symbol}
                className="rounded-full object-cover"
                style={{
                  width: "40px",
                  height: "40px",
                  objectFit: "cover",
                  borderRadius: "50%",
                }}
                fallback={
                  <span className="text-white font-bold text-lg">
                    {token.token_symbol?.charAt(0) || "?"}
                  </span>
                }
              />
            ) : (
              <span className="text-white font-bold text-lg">
                {token.token_symbol?.charAt(0) || "?"}
              </span>
            )}
          </div>
          <div className="flex-1">
            <h3 className="text-white font-semibold text-lg">
              {token.token_symbol}
            </h3>
            <div className="flex items-center space-x-2 mt-1">
              <span className="text-white text-sm font-medium">
                {formatCurrency(token.price, 6, false)}
              </span>
              <span
                className={`text-xs font-semibold ${token.change_1h >= 0 ? "text-green-400" : "text-red-400"}`}
              >
                {token.change_1h >= 0 ? "+" : ""}
                {Math.abs(token.change_1h) < 1
                  ? (token.change_1h * 100).toFixed(2)
                  : token.change_1h.toFixed(2)}
                %
              </span>
            </div>
          </div>
        </div>

        {/* Token Stats */}
        <div className="space-y-2 mb-4 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Market Cap:</span>
            <span
              className={`font-medium ${isNewToken ? "text-cyan-400" : "text-white"}`}
            >
              {formatCurrency(token.mcap)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Volume 1h:</span>
            <span className="text-white">
              {formatCurrency(token.volume_1h)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Volume 5m:</span>
            <span className="text-white">
              {formatCurrency(token.volume_5m)}
            </span>
          </div>
          {/* Quote info with loading state */}
          {!isOwned && (
            <div className="flex justify-between">
              <span className="text-gray-400">You'll get:</span>
              {loadingQuotes.has(token.token_address) &&
              hoveredToken === token.token_address ? (
                <div className="flex items-center space-x-1">
                  <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                  <span className="text-gray-400 text-xs">
                    Getting Quote...
                  </span>
                </div>
              ) : quoteErrors.get(token.token_address) ? (
                <span className="text-red-400 text-xs">
                  {quoteErrors.get(token.token_address)}
                </span>
              ) : quotes.has(token.token_address) ? (
                <span className="text-green-400">
                  ~{formatNumber(expectedTokens, 2, false)} {token.token_symbol}
                </span>
              ) : (
                <span className="text-gray-500 text-xs">Hover to quote</span>
              )}
            </div>
          )}
          {sellQuote && isOwned && (
            <div className="flex justify-between">
              <span className="text-gray-400">Sell for:</span>
              <span className="text-blue-400">
                ~{expectedSol.toFixed(4)} SOL
              </span>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="space-y-2">
          {/* Chart Hover Button */}
          <div
            className="relative w-full z-20"
            onMouseEnter={() => setHoveredChartToken(token.token_address)}
            onMouseLeave={() => setHoveredChartToken(null)}
          >
            <button className="w-full py-2 px-4 rounded-lg font-semibold bg-gray-700 text-gray-200 hover:bg-gray-600 transition-all duration-200 flex items-center justify-center gap-2 border border-gray-600">
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
                  d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"
                />
              </svg>
              <span>Hover for Chart</span>
            </button>

            {/* Floating Chart Popup */}
            {debouncedChartToken === token.token_address && (
              <div
                className="absolute bottom-full left-0 right-0 mb-2 bg-gray-900 rounded-lg shadow-2xl border border-gray-600 overflow-hidden z-50"
                style={{ height: "280px" }}
              >
                <div className="flex items-center justify-between px-2 py-1 border-b border-gray-700 bg-gray-800">
                  <span className="text-xs text-gray-300 truncate">
                    {token.token_symbol || token.token_address.slice(0, 8)}
                  </span>
                  <GlobalWatchlistButton
                    tokenAddress={token.token_address}
                    tokenSymbol={token.token_symbol}
                    initialPrice={token.price}
                    logoUrl={token.logo_url}
                  />
                </div>
                <div className="relative h-[250px] w-full">
                  <div className="absolute inset-0 bg-gray-800 flex items-center justify-center -z-10">
                    <div className="w-6 h-6 border-2 border-gray-500 border-t-white rounded-full animate-spin"></div>
                  </div>
                  <GmgnChartEmbed
                    tokenAddress={token.token_address}
                    interval="5"
                    className="w-full h-full"
                    height="250px"
                    title={`Chart - ${token.token_symbol}`}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Buy Button */}
          {!isOwned && (
            <>
              <button
                onClick={() => handleBuyToken(token)}
                disabled={
                  isBuying ||
                  !quotes.has(token.token_address) ||
                  loadingQuotes.has(token.token_address) ||
                  hoveredToken !== token.token_address
                }
                className={`w-full py-3 px-4 rounded-lg font-semibold transition-all duration-200 ${
                  isBuying
                    ? "bg-gray-600 text-gray-400 cursor-not-allowed"
                    : quotes.has(token.token_address) &&
                        hoveredToken === token.token_address
                      ? isNewToken
                        ? "bg-gradient-to-r from-cyan-600 to-blue-600 text-white hover:from-cyan-700 hover:to-blue-700 hover:scale-105"
                        : "bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-700 hover:to-pink-700 hover:scale-105"
                      : loadingQuotes.has(token.token_address) &&
                          hoveredToken === token.token_address
                        ? "bg-gray-700 text-gray-300 cursor-wait"
                        : "bg-gray-600 text-gray-400 cursor-not-allowed"
                }`}
              >
                {isBuying ? (
                  <div className="flex items-center justify-center space-x-2">
                    <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                    <span>Buying...</span>
                  </div>
                ) : loadingQuotes.has(token.token_address) &&
                  hoveredToken === token.token_address ? (
                  <div className="flex items-center justify-center space-x-2">
                    <div className="w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full animate-spin"></div>
                    <span>Getting Quote...</span>
                  </div>
                ) : quotes.has(token.token_address) &&
                  hoveredToken === token.token_address ? (
                  isNewToken ? (
                    `🚀 Catch NEW ${token.token_symbol} (${buyAmount} SOL)`
                  ) : (
                    `🎯 Catch ${token.token_symbol} (${buyAmount} SOL)`
                  )
                ) : (
                  "Hover to Quote"
                )}
              </button>

              {/* Simulate Button */}
              <button
                onClick={() => handleSimulateBuyToken(token)}
                disabled={
                  !quotes.has(token.token_address) ||
                  loadingQuotes.has(token.token_address)
                }
                className={`w-full py-2 px-4 rounded-lg font-semibold text-sm border border-gray-600 hover:bg-gray-700 text-gray-300 transition-all duration-200 flex items-center justify-center gap-2 ${
                  !quotes.has(token.token_address)
                    ? "opacity-50 cursor-not-allowed"
                    : ""
                }`}
              >
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
                    d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  />
                </svg>
                <span>Simulate Buy</span>
              </button>
              {computeOpenSimCycle(records, token.token_address) && (
                <button
                  onClick={() => handleSimulateSellToken(token)}
                  className="w-full mt-2 py-2 px-4 rounded-lg font-medium bg-blue-900/40 border border-blue-600/40 text-blue-200 hover:bg-blue-900/60 transition-colors"
                >
                  Sim Close
                </button>
              )}
            </>
          )}

          {/* Sell Button */}
          {isOwned && (
            <button
              onClick={() => handleSellToken(token)}
              disabled={isSelling || !sellQuote}
              className={`w-full py-3 px-4 rounded-lg font-semibold transition-all duration-200 ${
                isSelling
                  ? "bg-gray-600 text-gray-400 cursor-not-allowed"
                  : sellQuote
                    ? "bg-gradient-to-r from-red-600 to-orange-600 text-white hover:from-red-700 hover:to-orange-700 hover:scale-105"
                    : "bg-gray-600 text-gray-400 cursor-not-allowed"
              }`}
            >
              {isSelling ? (
                <div className="flex items-center justify-center space-x-2">
                  <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                  <span>Selling...</span>
                </div>
              ) : sellQuote ? (
                `💰 Sell ${token.token_symbol} (${expectedSol.toFixed(4)} SOL)`
              ) : (
                "Getting Sell Quote..."
              )}
            </button>
          )}

          <div className="flex justify-end pt-1">
            <DlmmChartActions
              tokenAddress={token.token_address}
              tokenSymbol={token.token_symbol}
              source="live"
            />
          </div>
        </div>

        {/* Highlight Indicator */}
        {isHighlighted && (
          <div className="mt-2 text-center">
            <span className="text-yellow-400 text-xs font-medium animate-pulse">
              🔥 Price moved {`>`}5%!
            </span>
          </div>
        )}

        {/* Axiom Risk Indicators */}
        <div className="mt-2 pt-2 border-t border-gray-700">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-1">
              <span className="text-gray-400">Risk:</span>
              <span
                className="text-gray-500 cursor-help"
                title="Risk analysis based on insider holdings, bundler concentration, sniper activity, and holder distribution"
              >
                ℹ️
              </span>
            </div>
            <div className="flex items-center space-x-1">
              {(() => {
                const tokenAxiomData = axiomData.get(token.token_address);
                const isLoading = loadingAxiom.has(token.token_address);

                if (isLoading) {
                  return (
                    <div className="flex items-center space-x-1">
                      <div className="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                      <span className="text-gray-400">Loading...</span>
                    </div>
                  );
                }

                if (!tokenAxiomData) {
                  return (
                    <button
                      onClick={() => fetchAxiomData(token.token_address)}
                      className="text-blue-400 hover:text-blue-300 text-xs"
                    >
                      Check Risk
                    </button>
                  );
                }

                // Handle pair not found case
                if (tokenAxiomData.pairNotFound) {
                  return (
                    <div className="px-2 py-1 rounded text-xs font-medium bg-gray-900/20 border border-gray-500/30 text-gray-400">
                      No Data
                    </div>
                  );
                }

                const { risk } = tokenAxiomData;
                if (!risk) return null;

                const riskDisplay = formatRiskDisplay(risk.overallRisk);

                return (
                  <div className="flex items-center gap-2">
                    <div
                      className={`px-2 py-1 rounded text-xs font-medium ${riskDisplay.bg} ${riskDisplay.border} ${riskDisplay.color}`}
                    >
                      {riskDisplay.text}
                    </div>
                    <div className="text-xs text-gray-400">
                      {risk.overallRisk === "HIGH"
                        ? "⚠️"
                        : risk.overallRisk === "MEDIUM"
                          ? "⚡"
                          : "✅"}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Detailed risk breakdown */}
          {(() => {
            const tokenAxiomData = axiomData.get(token.token_address);
            if (
              !tokenAxiomData ||
              tokenAxiomData.pairNotFound ||
              !tokenAxiomData.data ||
              !tokenAxiomData.risk
            )
              return null;

            const { data, risk } = tokenAxiomData;
            if (!data || !risk) return null;

            const insiderDisplay = formatRiskDisplay(risk!.insiderRisk);
            const bundlerDisplay = formatRiskDisplay(risk!.bundlerRisk);
            const sniperDisplay = formatRiskDisplay(risk!.sniperRisk);
            const concentrationDisplay = formatRiskDisplay(
              risk!.concentrationRisk,
            );
            const feeDisplay = formatRiskDisplay(risk!.feeRisk);

            // Calculate fee analysis
            const marketCap = token.mcap || 0;
            const feeAnalysis = calculateFeeToMarketCapRatio(
              data.totalPairFeesPaid,
              marketCap,
            );

            return (
              <div className="mt-2 space-y-2">
                {/* Risk Metrics Grid */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">Insiders:</span>
                    <div className="flex items-center gap-1">
                      <span className="text-white">
                        {data.insidersHoldPercent.toFixed(1)}%
                      </span>
                      <span
                        className={`px-1 py-0.5 rounded text-xs ${insiderDisplay.bg} ${insiderDisplay.color}`}
                      >
                        {insiderDisplay.text}
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">Bundlers:</span>
                    <div className="flex items-center gap-1">
                      <span className="text-white">
                        {data.bundlersHoldPercent.toFixed(1)}%
                      </span>
                      <span
                        className={`px-1 py-0.5 rounded text-xs ${bundlerDisplay.bg} ${bundlerDisplay.color}`}
                      >
                        {bundlerDisplay.text}
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">Snipers:</span>
                    <div className="flex items-center gap-1">
                      <span className="text-white">
                        {data.snipersHoldPercent.toFixed(1)}%
                      </span>
                      <span
                        className={`px-1 py-0.5 rounded text-xs ${sniperDisplay.bg} ${sniperDisplay.color}`}
                      >
                        {sniperDisplay.text}
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">Top 10:</span>
                    <div className="flex items-center gap-1">
                      <span className="text-white">
                        {data.top10HoldersPercent.toFixed(1)}%
                      </span>
                      <span
                        className={`px-1 py-0.5 rounded text-xs ${concentrationDisplay.bg} ${concentrationDisplay.color}`}
                      >
                        {concentrationDisplay.text}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Fee Analysis */}
                <div className="border-t border-gray-700 pt-2 space-y-1">
                  <div className="flex justify-between items-center text-xs">
                    <span className="text-gray-400">Organic Trading:</span>
                    <div className="flex items-center gap-1">
                      <span
                        className={`text-xs font-medium ${feeAnalysis.isOrganic ? "text-green-400" : "text-red-400"}`}
                      >
                        {feeAnalysis.isOrganic ? "✅ Organic" : "⚠️ Bundled"}
                      </span>
                      <span
                        className={`px-1 py-0.5 rounded text-xs ${feeDisplay.bg} ${feeDisplay.color}`}
                      >
                        {feeDisplay.text}
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Fees/MCap Ratio:</span>
                    <span className="text-white font-medium">
                      {feeAnalysis.ratio.toFixed(2)} SOL/5K MC
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Organic Score:</span>
                    <span
                      className={`font-medium ${feeAnalysis.organicScore >= 70 ? "text-green-400" : feeAnalysis.organicScore >= 40 ? "text-yellow-400" : "text-red-400"}`}
                    >
                      {feeAnalysis.organicScore}/100
                    </span>
                  </div>
                </div>

                {/* Additional Info */}
                <div className="flex justify-between text-xs border-t border-gray-700 pt-2">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400">Holders:</span>
                    <span className="text-white font-medium">
                      {data.numHolders.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400">Fees:</span>
                    <span className="text-white font-medium">
                      {data.totalPairFeesPaid.toFixed(1)} SOL
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  if (!connected) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-white mb-4">
            Live trending
          </h2>
          <p className="text-gray-400 mb-8">
            Connect your wallet to start catching trending tokens!
          </p>
          <div className="bg-gray-800 rounded-lg p-8">
            <p className="text-gray-300">
              Please connect your wallet to access the Catch the Coin feature.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="max-w-8xl mx-auto px-4 py-8 flex flex-col md:flex-row-reverse gap-6">
      {/* Main content: Trending tokens grid */}
      <div className="flex-1">
        {/* Header */}
        <div className="text-center mb-8">
          <h2 className="text-xl font-semibold text-white mb-4">
            Live trending
          </h2>
          <div className="bg-gray-900 rounded-xl p-4 shadow-lg sticky top-8 z-40">
            {/* Header styled like TradingHistory */}
            <div className="mb-4 p-3 bg-cyan-900/30 rounded-lg border border-cyan-500/30 flex items-center gap-3">
              <span className="text-2xl">🎯</span>
              <div className="flex-1">
                <div className="text-cyan-300 font-bold text-base">
                  Your Recent Positions
                </div>
                {(() => {
                  // Get all mint addresses with a 'buy' record and tradeSource: 'catch-the-coin'
                  // Use (r as any).tradeSource for compatibility with older records
                  const boughtRecords = records.filter(
                    (r) =>
                      r.operationType === "buy" &&
                      (r as any).tradeSource === "catch-the-coin",
                  );
                  const boughtMints = new Set(
                    boughtRecords.flatMap((r) =>
                      r.tokens.map((t) => t.mintAddress),
                    ),
                  );
                  const filteredTokens = userTokens.filter(
                    (t) => t.uiAmount > 0.001 && boughtMints.has(t.mintAddress),
                  );
                  const totalPnl = filteredTokens.reduce((sum, token) => {
                    const price = ownedTokenPrices[token.mintAddress] || 0;
                    const avgBuyPrice =
                      ownedTokens.get(token.mintAddress)?.buyPrice || 0;
                    const pnl =
                      avgBuyPrice > 0
                        ? ((price - avgBuyPrice) / avgBuyPrice) * 100
                        : 0;
                    return sum + pnl;
                  }, 0);
                  return (
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-cyan-200">
                        {filteredTokens.length} coins
                      </span>
                      <span
                        className={`text-xs font-semibold ${totalPnl >= 0 ? "text-green-400" : "text-red-400"}`}
                      >
                        Total PnL: {totalPnl >= 0 ? "+" : ""}
                        {totalPnl.toFixed(2)}%
                      </span>
                    </div>
                  );
                })()}
              </div>
            </div>
            {(() => {
              // Get all mint addresses with a 'buy' record and tradeSource: 'catch-the-coin'
              // Use (r as any).tradeSource for compatibility with older records
              const boughtRecords = records.filter(
                (r) =>
                  r.operationType === "buy" &&
                  (r as any).tradeSource === "catch-the-coin",
              );
              const boughtMints = new Set(
                boughtRecords.flatMap((r) =>
                  r.tokens.map((t) => t.mintAddress),
                ),
              );
              // Only show userTokens that are in boughtMints and have a balance
              const filteredTokens = userTokens.filter(
                (t) => t.uiAmount > 0.001 && boughtMints.has(t.mintAddress),
              );
              if (filteredTokens.length === 0) {
                return (
                  <div className="text-gray-400 text-sm">No positions</div>
                );
              }
              return (
                <ul className="space-y-3">
                  {filteredTokens.map((token) => {
                    const price = ownedTokenPrices[token.mintAddress] || 0;
                    const avgBuyPrice =
                      ownedTokens.get(token.mintAddress)?.buyPrice || 0;
                    const pnl =
                      avgBuyPrice > 0
                        ? ((price - avgBuyPrice) / avgBuyPrice) * 100
                        : 0;
                    const quote = sidebarSellQuotes[token.mintAddress];
                    const isSelling = sidebarSelling[token.mintAddress];
                    return (
                      <li
                        key={token.mintAddress}
                        className="bg-gray-800 rounded-lg p-3 flex items-center gap-3 group hover:bg-gray-700 transition"
                        onMouseEnter={() => handleSidebarHover(token)}
                        onMouseLeave={() => handleSidebarMouseLeave(token)}
                      >
                        <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center overflow-hidden">
                          {token.logoURI ? (
                            <OptimizedImage
                              src={token.logoURI}
                              alt={token.symbol ?? "Token"}
                              className="object-cover w-10 h-10 rounded-full"
                            />
                          ) : (
                            <span className="text-white font-bold text-lg">
                              {token.symbol?.charAt(0) || "?"}
                            </span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-white font-semibold text-sm truncate">
                              {token.symbol}
                            </span>
                            <span className="text-gray-400 text-xs">
                              {formatNumber(token.uiAmount, 2)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs font-medium text-gray-300">
                              PnL:
                            </span>
                            <span
                              className={`text-xs font-bold ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}
                            >
                              {pnl >= 0 ? "+" : ""}
                              {pnl.toFixed(2)}%
                            </span>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          {sidebarHovered === token.mintAddress &&
                            (quote === undefined ? (
                              <span className="text-xs text-gray-400">
                                Loading...
                              </span>
                            ) : quote ? (
                              <span className="text-xs text-blue-400">
                                ~{(parseInt(quote.outAmount) / 1e9).toFixed(4)}{" "}
                                SOL
                              </span>
                            ) : (
                              <span className="text-xs text-red-400">
                                No quote
                              </span>
                            ))}
                          <button
                            className={`mt-1 px-3 py-1 rounded bg-gradient-to-r from-red-600 to-orange-600 text-white text-xs font-semibold shadow hover:from-red-700 hover:to-orange-700 transition disabled:opacity-60 disabled:cursor-not-allowed`}
                            disabled={isSelling || !quote}
                            onClick={() => handleSidebarSell(token)}
                          >
                            {isSelling ? "Selling..." : "Sell"}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              );
            })()}
          </div>
          {/* Auto-update moving indicator */}
          <div className="w-full h-2 mb-4 bg-gray-700 rounded-full overflow-hidden relative">
            <div
              className="h-full bg-gradient-to-r from-cyan-400 to-blue-500 transition-all duration-100"
              style={{ width: `${autoUpdateProgress}%` }}
            />
            <div className="absolute inset-0 flex items-center justify-center text-xs text-cyan-200 font-semibold pointer-events-none">
              {isAnyTokenHovered
                ? "⏸ Paused (hovering)"
                : `Auto update in ${Math.ceil((100 - autoUpdateProgress) / 20) * 1}s`}
            </div>
          </div>

          {/* Buy Amount Selector */}
          <div className="flex flex-wrap items-center justify-center gap-4 mb-6">
            <label className="text-gray-300">Buy Amount (SOL):</label>
            <select
              value={buyAmount}
              onChange={(e) => setBuyAmount(Number(e.target.value))}
              className="bg-gray-800 text-white px-4 py-2 rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
            >
              <option value={0.05}>0.05 SOL</option>
              <option value={0.1}>0.1 SOL</option>
              <option value={0.25}>0.25 SOL</option>
              <option value={0.5}>0.5 SOL</option>
              <option value={1}>1 SOL</option>
              <option value={2}>2 SOL</option>
              <option value={5}>5 SOL</option>
            </select>
            <label className="text-gray-300">Strategy:</label>
            <select
              value={template}
              onChange={(e) =>
                setTemplate(e.target.value as "default" | "sell_over_100")
              }
              className="bg-gray-800 text-white px-4 py-2 rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
            >
              <option value="default">Default</option>
              <option value="sell_over_100">Sell over 100%</option>
            </select>
          </div>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-gray-800 rounded-xl p-6 animate-pulse">
                <div className="flex items-center space-x-3 mb-4">
                  <div className="w-12 h-12 bg-gray-700 rounded-full"></div>
                  <div className="flex-1">
                    <div className="h-4 bg-gray-700 rounded mb-2"></div>
                    <div className="h-3 bg-gray-700 rounded w-2/3"></div>
                  </div>
                </div>
                <div className="space-y-2 mb-4">
                  <div className="h-3 bg-gray-700 rounded"></div>
                  <div className="h-3 bg-gray-700 rounded w-3/4"></div>
                </div>
                <div className="h-10 bg-gray-700 rounded"></div>
              </div>
            ))}
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="text-center py-8">
            <div className="bg-red-900/20 border border-red-500 rounded-lg p-6">
              <p className="text-red-400">{error}</p>
              <button
                onClick={fetchTrendingTokens}
                className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {/* Token Cards */}
        {!loading && !error && tokens.length > 0 && (
          <div className="space-y-8">
            {/* Kept Tokens Section */}
            {tokens.some((t) => keptTokenIds.has(t.token_address)) && (
              <div className="bg-gray-900/50 rounded-2xl p-6 border border-yellow-500/20">
                <div className="flex justify-between items-center mb-6">
                  <h2 className="text-2xl font-bold text-yellow-400 flex items-center gap-2">
                    <span>⭐</span> Watchlist
                  </h2>
                  <button
                    onClick={handleOpenCharts}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors flex items-center gap-2"
                  >
                    <span>📈</span> View All in Charts
                  </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  {tokens
                    .filter((t) => keptTokenIds.has(t.token_address))
                    .map((token) => (
                      <TokenCard key={token.token_address} token={token} />
                    ))}
                </div>
              </div>
            )}

            {/* Trending Tokens Section */}
            <div>
              <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
                <span>🔥</span> Trending Now
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {tokens
                  .filter((t) => !keptTokenIds.has(t.token_address))
                  .slice(0, 12)
                  .map((token) => (
                    <TokenCard key={token.token_address} token={token} />
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && tokens.length === 0 && (
          <div className="text-center py-8">
            <div className="bg-gray-800 rounded-lg p-8">
              <p className="text-gray-300 mb-4">
                No trending tokens found at the moment.
              </p>
              <button
                onClick={fetchTrendingTokens}
                className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
              >
                Refresh
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
    <TradeOutcomeModal {...outcomeModalProps} />
    </>
  );
}
