"use client";

import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  useWallet,
  useConnection,
  useDevWalletAccess,
} from "../components/WalletProvider";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { useRhWalletMode } from "@/contexts/RhWalletModeContext";
import { useResolvedWalletPublicKey } from "@/hooks/useResolvedWalletPublicKey";
import { useWalletTokens, refreshWalletTokensData, type WalletTokensData } from "@/hooks/useWalletTokens";
import { useSolPrice } from "@/hooks/useSolPrice";
import UniversalWalletButton from "./UniversalWalletButton";
import TradeOutcomeModal, { useTradeOutcome } from "./TradeOutcomeModal";
import TokenSkeleton from "./TokenSkeleton";
import ConfirmTransportSelect from "./ConfirmTransportSelect";
import HoldingsTokenList from "./HoldingsTokenList";
import GmgnTradeConfirmModal, {
  type GmgnConfirmLeg,
} from "./GmgnTradeConfirmModal";
import { useGmgnBoundWallets } from "@/hooks/useGmgnBoundWallets";
import { useRhEvmWallet } from "@/hooks/useRhEvmWallet";
import { useRhWalletTokens } from "@/hooks/useRhWalletTokens";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import RhPermit2SetupSheet, {
  RhPermit2StatusBanner,
} from "@/components/rh/RhPermit2SetupSheet";
import { useRhPermit2Readiness } from "@/hooks/useRhPermit2Readiness";
import {
  GMGN_RH_USDG,
  GMGN_RH_WETH,
  gmgnNativeToken,
  matchesTradeChainAddress,
} from "@/utils/gmgn-currencies";
import { walletsMatch } from "@/utils/rh-wallet-holdings";
import { executeGmgnBulkSell } from "@/utils/gmgn-bulk-trade";
import type { RhSwapQuote } from "@/utils/dlmm/rh-univ2-swap";
import { executeRhParentKyberSell } from "@/utils/dlmm/rh-kyber-swap";
import { getRhBatchExecutorAddress, RH_PLATFORM_FEE_LABEL } from "@/utils/dlmm/rh-batch-executor";
import { MAX_TRADE_TOKENS, capTradeTokens } from "@/utils/trade-ui-limits";
import { prefetchSwapTransaction } from "@/utils/swap-executor";
import {
  AUTO_SLIPPAGE_BPS,
  AUTO_SLIPPAGE_CAP_BPS,
  prefetchSlippageBps,
  quoteIsVolatile,
  resolveTradeSlippageBps,
  worstImpactPct,
} from "@/utils/auto-slippage";
import { RH_WETH, erc20Abi } from "@/utils/dlmm/rh-univ2";
import {
  fetchEthUsdSpot,
  simulateRhBoundSellLeg,
  simulateRhParentSellLeg,
  rawAmountToHuman,
} from "@/utils/rh-trade-sim";
import {
  buildRhSellToken,
  rhQuoteUsdPerUnit,
} from "@/utils/rh-trade-record";
import {
  readTradeAutoConfirm,
  writeTradeAutoConfirm,
} from "@/utils/trade-auto-confirm";
import {
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  executeBulkSellAlt,
  fetchUserTokens,
  fetchZeroBalanceTokens,
  closeZeroBalanceTokens,
  getTokenUsdValue,
  isPumpFunToken,
  getAllFeeRates,
  getFeeForOperation,
  MIN_BALANCE_UI,
  setMetadataUpdateCallback,
  clearMetadataUpdateCallback,
  UserToken,
  TokenToSell,
  BulkSellRequest,
  BulkSellResult,
} from "@/utils/jupiter";
import {
  SLIPPAGE_OPTIONS,
  PRIORITY_FEE_OPTIONS,
  getSolPriceUSD,
  TOKENS,
} from "@/utils/solana";
import { trackSell, trackClose } from "@/utils/operations-api";
import { fetchTokenPricesForTracking } from "@/utils/trading-tracker";
import GmgnKlineChart from "@/components/GmgnKlineChart";
import { useTradingData } from "./TradingDataProvider";
// ✅ NEW: Import PnL sharing system
import { usePnLShare } from "@/hooks/usePnLShare";
import { usePostTradeRefresh } from "@/hooks/usePostTradeRefresh";
import { useRpc } from "@/contexts/RpcContext";
import RpcPanel from "./RpcPanel";
import PnLShareModal from "./PnLShareModal";
import { pnlShareService } from "@/utils/pnl-share-service";
import { mapRaptorQuoteToDisplay, RAPTOR_DEV_FEE_ACCOUNT, RAPTOR_DEV_FEE_BPS } from "@/utils/solanatracker-raptor";

function patchWalletTokenLists(
  data: WalletTokensData,
  patchList: (tokens: UserToken[]) => UserToken[],
): WalletTokensData {
  return {
    ...data,
    allTokens: patchList(data.allTokens),
    valuable: patchList(data.valuable),
    dust: patchList(data.dust),
    zeroValue: patchList(data.zeroValue),
    sellable: patchList(data.sellable),
    closeOnly: patchList(data.closeOnly),
  };
}

const TRADE_SLIPPAGE_OPTIONS = [
  {
    label: `Auto · cap ${AUTO_SLIPPAGE_CAP_BPS / 100}% · quote+20bps`,
    value: AUTO_SLIPPAGE_BPS,
  },
  ...SLIPPAGE_OPTIONS,
];

interface QuoteData {
  provider: "solanatracker";
  inputMint: string;
  outputMint: string;
  amount: string;
  outAmount: string;
  priceImpact: number;
  fee?: number;
  timestamp: number;
  route?: any; // Provider-specific route data
}

export default function BulkTokenSeller() {
  const { signAllTransactions, connected } = useWallet();
  const { publicKey, walletAddress, isWalletReady } =
    useResolvedWalletPublicKey();
  const { connection } = useConnection();
  const {
    selectedEndpoint,
    selectedEndpointIndex,
    endpoints,
    activeRpcUrl,
    diagnostics,
    isRunningDiagnostics,
    setSelectedEndpointIndex,
    runDiagnostics,
    autoSelectBest,
    setAutoSelectBest,
    autoSelectBestEndpoint,
  } = useRpc();
  const triggerPostTradeRefresh = usePostTradeRefresh({ refetchRecords: true });
  const { trackOperation } = useTradingData();
  const { showOutcome, hideOutcome, outcomeModalProps } = useTradeOutcome();
  const [pendingCloseableTokens, setPendingCloseableTokens] = useState<
    TokenToSell[]
  >([]);
  const [isClosingAccounts, setIsClosingAccounts] = useState(false);

  // ✅ NEW: Add PnL sharing hook
  const {
    shareData,
    isShareModalOpen,
    isGeneratingShare,
    showShareModal,
    hideShareModal,
    autoTriggerShare,
  } = usePnLShare();

  // UI state — token lists come from useWalletTokens query
  const [selectedTokens, setSelectedTokens] = useState<TokenToSell[]>([]);
  const [selectedZeroBalanceTokens, setSelectedZeroBalanceTokens] = useState<
    UserToken[]
  >([]);
  const [slippage, setSlippage] = useState<number>(AUTO_SLIPPAGE_BPS);
  const [priorityFee, setPriorityFee] = useState<number>(30000); // 0.00003 SOL
  const isDevUser = useDevWalletAccess();
  const { effectiveChain, canUseRh } = useAppNetwork();
  const { mode: rhMode } = useRhWalletMode();
  const rhWallet = useRhEvmWallet();
  const rhBatchExecutor = getRhBatchExecutorAddress();
  const [useGmgnOnSol, setUseGmgnOnSol] = useState(false);
  const [gmgnConfirmOpen, setGmgnConfirmOpen] = useState(false);
  const [permit2SetupOpen, setPermit2SetupOpen] = useState(false);
  const [gmgnConfirmLegs, setGmgnConfirmLegs] = useState<GmgnConfirmLeg[]>([]);
  const [gmgnConfirmBusy, setGmgnConfirmBusy] = useState(false);
  const [tradeAutoConfirm, setTradeAutoConfirm] = useState(readTradeAutoConfirm);
  const [gmgnQuoteRefreshing, setGmgnQuoteRefreshing] = useState(false);
  const autoConfirmFiredRef = useRef(false);
  const [rhQuoteCurrency, setRhQuoteCurrency] =
    useState<RhSwapQuote>("ETH");
  const boundWallets = useGmgnBoundWallets();
  // App network (header) is source of truth; the per-chain pages ensure
  // `effectiveChain` matches the URL. No local canUseRh coercion here.
  const isRhChain = effectiveChain === "robinhood";
  /** Sol-only: Raptor quotes + Jupiter/Sol RPC sell. Never true on Robinhood. */
  const isSolTrade = effectiveChain === "sol";
  const effectiveUseGmgn = isDevUser && isSolTrade && useGmgnOnSol;

  const solGmgnSynced = boundWallets.isSyncedSol(walletAddress);
  const useRhParentPath = canUseRh && isRhChain && rhMode === "parent";
  const useGmgnPath =
    (canUseRh && isRhChain && rhMode === "bound") ||
    (isDevUser && isSolTrade && effectiveUseGmgn);
  const tradeFromAddress =
    effectiveChain === "robinhood"
      ? rhMode === "parent"
        ? rhWallet.address
        : boundWallets.evm
      : effectiveUseGmgn
        ? boundWallets.sol
        : null;
  const permit2SetupTokens = useMemo(
    () =>
      useRhParentPath && rhBatchExecutor
        ? selectedTokens.map((token) => ({
            address: token.mintAddress as Address,
            symbol: token.symbol,
          }))
        : [],
    [useRhParentPath, rhBatchExecutor, selectedTokens],
  );
  const permit2Readiness = useRhPermit2Readiness({
    publicClient: useRhParentPath ? rhWallet.getPublicClient() : null,
    account:
      useRhParentPath && tradeFromAddress
        ? (tradeFromAddress as Address)
        : null,
    tokens: permit2SetupTokens.map((token) => token.address),
    spender: rhBatchExecutor,
    enabled: useRhParentPath,
  });
  const rhWalletTokens = useRhWalletTokens();

  const rosterSellRecsQuery = useQuery({
    queryKey: ["gmgn-roster-sell-recs", effectiveChain],
    queryFn: async () => {
      const res = await fetch("/api/gmgn/roster");
      if (!res.ok) return [] as string[];
      const data = (await res.json()) as {
        roster?: Array<{
          hit_tokens?: Array<{ token_address: string; chain?: string }>;
        }>;
      };
      const seen = new Set<string>();
      const out: string[] = [];
      for (const row of data.roster ?? []) {
        for (const hit of row.hit_tokens ?? []) {
          const addr = hit.token_address?.trim();
          if (!addr) continue;
          const hitChain = hit.chain === "robinhood" ? "robinhood" : "sol";
          if (hitChain !== effectiveChain) continue;
          if (!matchesTradeChainAddress(effectiveChain, addr)) continue;
          const key =
            effectiveChain === "robinhood" ? addr.toLowerCase() : addr;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(key);
          if (out.length >= 12) return out;
        }
      }
      return out;
    },
    enabled: isDevUser,
    staleTime: 60_000,
  });

  const {
    valuable: userTokens,
    dust: dustTokens,
    zeroValue: zeroValueTokens,
    sellable: swappableTokens,
    closeOnly: zeroBalanceTokens,
    allTokens,
    fetchMeta: lastFetchMeta,
    isPending: isInitialLoad,
    isFetching: isLoadingTokens,
    error: tokensQueryError,
    refetchTokens,
    refetchFresh,
    patchTokens,
  } = useWalletTokens({
    connection,
    publicKey,
    walletAddress,
    activeRpcUrl,
    rpcLabel: selectedEndpoint?.provider ?? "RPC",
    enabled: isWalletReady && isSolTrade,
  });

  const allTokensCount = isRhChain
    ? rhWalletTokens.tokens.length
    : allTokens.length;
  const fetchError = isRhChain
    ? rhWalletTokens.error instanceof Error
      ? rhWalletTokens.error.message
      : rhWalletTokens.error
        ? String(rhWalletTokens.error)
        : ""
    : tokensQueryError instanceof Error
      ? tokensQueryError.message
      : tokensQueryError
        ? String(tokensQueryError)
        : lastFetchMeta?.error ?? "";
  const isInitialLoadTokens = isRhChain
    ? rhWalletTokens.isLoading && rhWalletTokens.tokens.length === 0
    : isInitialLoad;
  const isLoadingTokensList = isRhChain
    ? rhWalletTokens.isFetching || rhWalletTokens.isLoading
    : isLoadingTokens;

  const autoSelectRanAfterFetchRef = useRef(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [sellPointsEarned, setSellPointsEarned] = useState<number | null>(null);
  const [closePointsEarned, setClosePointsEarned] = useState<number | null>(
    null,
  );
  const [error, setError] = useState<string>("");
  const [selectedToken, setSelectedToken] = useState<string>("");
  const [showDustOnly, setShowDustOnly] = useState<boolean>(false);
  const [showZeroBalance, setShowZeroBalance] = useState<boolean>(false);
  const [showRpcPanel, setShowRpcPanel] = useState<boolean>(false);

  // Balance tracking
  const [balanceBefore, setBalanceBefore] = useState<number>(0);
  const [balanceAfter, setBalanceAfter] = useState<number>(0);

  // SOL price in USD
  const [solPriceUsd, setSolPriceUsd] = useState<number>(145); // Default fallback

  // Quote state (Raptor via /api/solanatracker/quote)
  const [autoQuote, setAutoQuote] = useState<boolean>(true);
  const [quotes, setQuotes] = useState<Record<string, QuoteData>>({});
  const [isGettingQuotes, setIsGettingQuotes] = useState<boolean>(false);
  const [lastQuoteTime, setLastQuoteTime] = useState<number>(0);
  const [showSettings, setShowSettings] = useState<boolean>(false);

  // Reset selection when chain / RH wallet mode changes (after setters exist)
  const [tradeScopeKey, setTradeScopeKey] = useState(
    () => `${effectiveChain}:${rhMode}`,
  );
  const nextTradeScopeKey = `${effectiveChain}:${rhMode}`;
  if (tradeScopeKey !== nextTradeScopeKey) {
    setTradeScopeKey(nextTradeScopeKey);
    setSelectedTokens([]);
    setQuotes({});
    setError("");
  }

  const feeRates = getAllFeeRates();

  // Quote utilities
  const getQuoteForToken = useCallback(
    (mintAddress: string): QuoteData | null => {
      return quotes[mintAddress] || null;
    },
    [quotes],
  );

  const isQuoteValid = useCallback((quote: QuoteData | null): boolean => {
    if (!quote) return false;
    const age = Date.now() - quote.timestamp;
    return age < 30000; // Valid for 30 seconds
  }, []);

  // Quote fetching functions for different providers
  const fetchSolanaTrackerQuote = useCallback(
    async (inputMint: string, amount: string): Promise<QuoteData | null> => {
      try {
        const query = new URLSearchParams({
          inputMint,
          outputMint: TOKENS.SOL,
          amount,
          slippageBps: prefetchSlippageBps(slippage).toString(),
        });
        const response = await fetch(
          `/api/solanatracker/quote?${query.toString()}`,
        );
        if (!response.ok) throw new Error("Solana Tracker quote failed");

        const data = await response.json();
        const mapped = mapRaptorQuoteToDisplay(data, amount);

        return {
          provider: "solanatracker",
          inputMint,
          outputMint: TOKENS.SOL,
          amount,
          outAmount: mapped.outAmount,
          priceImpact: mapped.priceImpact * 100,
          timestamp: Date.now(),
          route: mapped.route,
        };
      } catch (error) {
        console.error("Solana Tracker quote error:", error);
        return null;
      }
    },
    [slippage],
  );

  // Main quote fetching function (Raptor only)
  const fetchQuoteForToken = useCallback(
    async (token: TokenToSell): Promise<QuoteData | null> => {
      return fetchSolanaTrackerQuote(
        token.mintAddress,
        token.sellAmount.toString(),
      );
    },
    [fetchSolanaTrackerQuote],
  );

  // Batch quote fetching for all selected tokens (Sol / Raptor only)
  const fetchAllQuotes = useCallback(async () => {
    if (!isSolTrade) return;
    // Only fetch for tokens that are not unsellable
    const tokensToQuote = selectedTokens.filter(
      (t) =>
        !selectedZeroBalanceTokens.some((z) => z.mintAddress === t.mintAddress),
    );
    if (tokensToQuote.length === 0 || isGettingQuotes) return;

    setIsGettingQuotes(true);
    setError("");

    try {
      console.log(
        `Fetching Raptor quotes for ${tokensToQuote.length} tokens`,
      );

      // Fetch quotes for all selected tokens in parallel
      const quotePromises = tokensToQuote.map(async (token) => {
        const quote = await fetchQuoteForToken(token);
        return { mintAddress: token.mintAddress, quote };
      });

      const results = await Promise.allSettled(quotePromises);
      const newQuotes: Record<string, QuoteData> = {};
      let successCount = 0;

      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value.quote) {
          newQuotes[result.value.mintAddress] = result.value.quote;
          successCount++;
        }
      });

      setQuotes((prevQuotes) => ({ ...prevQuotes, ...newQuotes }));
      setLastQuoteTime(Date.now());

      console.log(
        `✅ Got ${successCount}/${tokensToQuote.length} Raptor quotes`,
      );

      if (successCount === 0) {
        setError("Failed to get quotes from Raptor. Please try again.");
      }
    } catch (error) {
      console.error("Batch quote error:", error);
      setError("Failed to fetch quotes. Please try again.");
    } finally {
      setIsGettingQuotes(false);
    }
  }, [
    isSolTrade,
    selectedTokens,
    selectedZeroBalanceTokens,
    fetchQuoteForToken,
    isGettingQuotes,
  ]);

  // ===== Auto-quote effect (Sol only) =====
  // 1. Runs immediately whenever token selection changes (or autoQuote toggles on)
  // 2. Refreshes every 5 s as long as the selection stays the same
  const tokensHash = useMemo(
    () =>
      selectedTokens
        .map((t) => t.mintAddress)
        .sort()
        .join(","),
    [selectedTokens],
  );

  // Keep a ref to the latest fetchAllQuotes so interval always has fresh logic but effect doesn't depend on its identity
  const fetchAllQuotesRef = useRef(fetchAllQuotes);
  useEffect(() => {
    fetchAllQuotesRef.current = fetchAllQuotes;
  }, [fetchAllQuotes]);

  useEffect(() => {
    if (!isSolTrade || !autoQuote || selectedTokens.length === 0) return;

    // Fetch immediately on mount / token change
    fetchAllQuotesRef.current();

    // Poll every 5 seconds while the token list is unchanged
    const interval = setInterval(() => {
      if (autoQuote && selectedTokens.length > 0) {
        fetchAllQuotesRef.current();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isSolTrade, autoQuote, tokensHash, selectedTokens.length]);

  const sellPrefetchKey = useMemo(
    () =>
      selectedTokens.map((t) => `${t.mintAddress}:${t.sellAmount}`).join(","),
    [selectedTokens],
  );

  useEffect(() => {
    if (!isSolTrade || !publicKey || !connection) return;
    if (selectedTokens.length === 0) return;
    const pk = publicKey.toBase58();
    const legs = selectedTokens.filter((t) => t.sellAmount > 0);
    const timer = window.setTimeout(() => {
      void Promise.all(
        legs.map((token) =>
          prefetchSwapTransaction({
            userPublicKey: pk,
            inputMint: token.mintAddress,
            outputMint: TOKENS.SOL,
            amount: token.sellAmount,
            slippageBps: prefetchSlippageBps(slippage),
            priorityFeeLamports: priorityFee,
            feeAccount: RAPTOR_DEV_FEE_ACCOUNT,
            feeBps: RAPTOR_DEV_FEE_BPS,
            connection,
          }).catch(() => undefined),
        ),
      );
    }, 400);
    return () => window.clearTimeout(timer);
  }, [
    isSolTrade,
    publicKey,
    connection,
    sellPrefetchKey,
    slippage,
    priorityFee,
    selectedTokens,
  ]);

  // Fetch SOL price using robust multi-API system — handled by useSolPrice

  const handleMetadataUpdate = useCallback(
    (updatedTokens: UserToken[]) => {
      console.log(
        `Updating UI with enriched metadata for ${updatedTokens.length} tokens`,
      );

      patchTokens((data) =>
        patchWalletTokenLists(data, (tokens) =>
          tokens.map((token) => {
            const updated = updatedTokens.find(
              (u) => u.mintAddress === token.mintAddress,
            );
            return updated || token;
          }),
        ),
      );

      setSelectedTokens((prev) =>
        prev.map((token) => {
          const updated = updatedTokens.find(
            (u) => u.mintAddress === token.mintAddress,
          );
          return updated
            ? {
                ...updated,
                sellAmount: token.sellAmount,
                sellPercentage: token.sellPercentage,
              }
            : token;
        }),
      );

      setSelectedZeroBalanceTokens((prev) =>
        prev.map((token) => {
          const updated = updatedTokens.find(
            (u) => u.mintAddress === token.mintAddress,
          );
          return updated || token;
        }),
      );
    },
    [patchTokens],
  );

  const fetchTokens = useCallback(
    async (forceRefresh = false): Promise<void> => {
      if (isRhChain) {
        await rhWalletTokens.refetch();
        return;
      }
      await refetchTokens(forceRefresh);
    },
    [isRhChain, rhWalletTokens, refetchTokens],
  );

  /** Post-trade refresh: bypass the server-side response cache. */
  const fetchTokensFresh = useCallback(async (): Promise<void> => {
    if (isRhChain) {
      await rhWalletTokens.refetchFresh();
      return;
    }
    await refetchFresh();
  }, [isRhChain, rhWalletTokens, refetchFresh]);

  // Handle token selection
  const toggleTokenSelection = (token: UserToken) => {
    setSelectedTokens((prev) => {
      const isSelected = prev.some((t) =>
        isRhChain
          ? walletsMatch(t.mintAddress, token.mintAddress)
          : t.mintAddress === token.mintAddress,
      );
      if (isSelected) {
        return prev.filter((t) => t.mintAddress !== token.mintAddress);
      } else {
        // Check if already at the limit
        if (prev.length >= MAX_TRADE_TOKENS) {
          setError(`Maximum ${MAX_TRADE_TOKENS} tokens per sell`);
          return prev;
        }
        // Convert UserToken to TokenToSell with default 100% sell amount
        const tokenToSell: TokenToSell = {
          ...token,
          sellAmount: token.balance,
          sellPercentage: 100,
        };
        return [...prev, tokenToSell];
      }
    });
  };

  // Handle sell percentage change for a specific token
  const updateTokenSellPercentage = (
    mintAddress: string,
    percentage: number,
  ) => {
    setSelectedTokens((prev) =>
      prev.map((token) => {
        if (token.mintAddress === mintAddress) {
          const sellAmount = Math.floor((token.balance * percentage) / 100);
          return {
            ...token,
            sellPercentage: percentage,
            sellAmount: sellAmount,
          };
        }
        return token;
      }),
    );
  };

  // Handle sell amount change by direct token units input
  const updateTokenSellAmount = (
    mintAddress: string,
    tokenAmountUI: number,
  ) => {
    setSelectedTokens((prev) =>
      prev.map((token) => {
        if (token.mintAddress === mintAddress) {
          const decimals = token.decimals || 0;
          const maxUnits = token.balance;
          const requestedUnits = Math.floor(
            Math.max(0, tokenAmountUI) * Math.pow(10, decimals),
          );
          const clampedUnits = Math.min(Math.max(requestedUnits, 1), maxUnits);
          // Use floor to avoid rounding up to 100% unless it’s truly full amount
          const percentage = Math.max(
            1,
            Math.min(100, Math.floor((clampedUnits / maxUnits) * 100)),
          );
          return {
            ...token,
            sellAmount: clampedUnits,
            sellPercentage: percentage,
          };
        }
        return token;
      }),
    );
  };

  // Handle zero-balance token selection
  const toggleZeroBalanceTokenSelection = (token: UserToken) => {
    setSelectedZeroBalanceTokens((prev) => {
      const isSelected = prev.some((t) => t.mintAddress === token.mintAddress);
      if (isSelected) {
        return prev.filter((t) => t.mintAddress !== token.mintAddress);
      } else {
        // Check if already at the limit
        if (prev.length >= 22) {
          setError("Maximum 22 tokens can be selected for closing");
          return prev;
        }
        return [...prev, token];
      }
    });
  };

  // Select all tokens
  const selectAllTokens = () => {
    const tokensToSelect = (showDustOnly ? filteredUserTokens : displayUserTokens)
      .filter((token) => !zeroBalanceMintSet.has(token.mintAddress));
    const tokensToSell: TokenToSell[] = tokensToSelect.map((token) => ({
      ...token,
      sellAmount: token.balance,
      sellPercentage: 100,
    }));

    if (tokensToSell.length > MAX_TRADE_TOKENS) {
      setSelectedTokens(capTradeTokens(tokensToSell));
      setError(`Selection limited to first ${MAX_TRADE_TOKENS} tokens`);
    } else {
      setSelectedTokens(tokensToSell);
    }
  };

  // Select all zero-balance tokens
  const selectAllZeroBalanceTokens = () => {
    if (zeroBalanceTokens.length > 22) {
      setSelectedZeroBalanceTokens(zeroBalanceTokens.slice(0, 22));
      setError(
        "Selection limited to first 22 tokens (Solana transaction limit)",
      );
    } else {
      setSelectedZeroBalanceTokens([...zeroBalanceTokens]);
    }
  };

  // Clear selection
  const clearSelection = () => {
    setSelectedTokens([]);
  };

  // Clear zero-balance selection
  const clearZeroBalanceSelection = () => {
    setSelectedZeroBalanceTokens([]);
  };

  // Refresh all token prices from Jupiter portfolio
  const refreshAllPrices = useCallback(async () => {
    if (!publicKey || !walletAddress || !connection || swappableTokens.length === 0) return;

    patchTokens((data) =>
      patchWalletTokenLists(data, (tokens) =>
        tokens.map((token) => ({ ...token, isLoadingPrice: true })),
      ),
    );

    try {
      console.log("Refreshing token prices from Jupiter portfolio...");
      const refreshed = await refreshWalletTokensData(
        connection,
        publicKey,
        walletAddress,
      );
      patchTokens(() => refreshed);

      setSelectedTokens((prev) =>
        prev.map((selectedToken) => {
          const updatedToken = refreshed.sellable.find(
            (t) => t.mintAddress === selectedToken.mintAddress,
          );
          if (updatedToken) {
            return {
              ...updatedToken,
              sellAmount: selectedToken.sellAmount,
              sellPercentage: selectedToken.sellPercentage,
            };
          }
          return selectedToken;
        }),
      );

      console.log("Jupiter portfolio price refresh completed");
    } catch (error) {
      console.error("Error refreshing portfolio prices:", error);
      setError("Failed to refresh token prices");

      patchTokens((data) =>
        patchWalletTokenLists(data, (tokens) =>
          tokens.map((token) => ({ ...token, isLoadingPrice: false })),
        ),
      );
    }
  }, [
    publicKey,
    walletAddress,
    connection,
    swappableTokens.length,
    patchTokens,
  ]);

  // Refresh individual token price from Jupiter portfolio
  const refreshTokenPrice = useCallback(
    async (token: UserToken) => {
      if (!publicKey || !walletAddress || !connection) return;

      patchTokens((data) =>
        patchWalletTokenLists(data, (tokens) =>
          tokens.map((t) =>
            t.mintAddress === token.mintAddress
              ? { ...t, isLoadingPrice: true }
              : t,
          ),
        ),
      );

      try {
        const refreshed = await refreshWalletTokensData(
          connection,
          publicKey,
          walletAddress,
        );
        patchTokens(() => refreshed);

        const updatedToken = refreshed.allTokens.find(
          (t) => t.mintAddress === token.mintAddress,
        );

        if (updatedToken) {
          setSelectedTokens((prev) =>
            prev.map((t) =>
              t.mintAddress === token.mintAddress
                ? {
                    ...t,
                    usdValue: updatedToken.usdValue,
                    uiAmount: updatedToken.uiAmount,
                    isLoadingPrice: false,
                  }
                : t,
            ),
          );
        }
      } catch (error) {
        console.error("Error refreshing token price:", error);
        patchTokens((data) =>
          patchWalletTokenLists(data, (tokens) =>
            tokens.map((t) =>
              t.mintAddress === token.mintAddress
                ? { ...t, isLoadingPrice: false }
                : t,
            ),
          ),
        );
      }
    },
    [publicKey, walletAddress, connection, patchTokens],
  );

  const resolveSellSlippageBps = useCallback(async (): Promise<number> => {
    if (isRhChain) {
      const ethUsd = await fetchEthUsdSpot();
      const impacts = await Promise.all(
        selectedTokens.map(async (t) => {
          const pct = t.sellPercentage || 100;
          try {
            if (useRhParentPath) {
              const sim = await simulateRhParentSellLeg({
                publicClient: rhWallet.getPublicClient(),
                account: tradeFromAddress as Address,
                tokenAddress: t.mintAddress,
                percent: pct,
                quote: rhQuoteCurrency,
                ethUsd,
                tokenDecimals: t.decimals,
              });
              return sim.priceImpactPct;
            }
            if (!tradeFromAddress) return null;
            const bal = (await rhWallet.getPublicClient().readContract({
              address: t.mintAddress as Address,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [tradeFromAddress as Address],
            })) as bigint;
            const amountRaw = (
              (bal * BigInt(Math.floor(pct * 100))) /
              BigInt(10_000)
            ).toString();
            const sim = await simulateRhBoundSellLeg({
              from: tradeFromAddress,
              tokenAddress: t.mintAddress,
              percent: pct,
              quote: rhQuoteCurrency,
              slippageBps: prefetchSlippageBps(slippage),
              ethUsd,
              amountRaw,
            });
            return sim.priceImpactPct;
          } catch {
            return null;
          }
        }),
      );
      return resolveTradeSlippageBps(slippage, worstImpactPct(impacts));
    }
    const fromQuotes = selectedTokens.map((t) => {
      const q = quotes[t.mintAddress];
      return q && isQuoteValid(q) ? q.priceImpact : null;
    });
    const worst = worstImpactPct(fromQuotes);
    if (worst != null) return resolveTradeSlippageBps(slippage, worst);
    const fetched = await Promise.all(
      selectedTokens
        .filter((t) => t.sellAmount > 0)
        .map((t) => fetchQuoteForToken(t)),
    );
    return resolveTradeSlippageBps(
      slippage,
      worstImpactPct(fetched.map((q) => q?.priceImpact)),
    );
  }, [
    isRhChain,
    selectedTokens,
    useRhParentPath,
    rhWallet,
    tradeFromAddress,
    rhQuoteCurrency,
    slippage,
    quotes,
    isQuoteValid,
    fetchQuoteForToken,
  ]);

  const runConfirmedRhSell = useCallback(async () => {
    if (!tradeFromAddress || selectedTokens.length === 0) return;
    if (useRhParentPath && rhBatchExecutor) {
      const latest = permit2Readiness.data ?? (await permit2Readiness.refetch()).data;
      if (!latest || latest.some((item) => item.status !== "ready")) {
        setPermit2SetupOpen(true);
        return;
      }
    }
    setIsLoading(true);
    setGmgnConfirmBusy(true);
    setError("");
    try {
      if (
        rhQuoteCurrency === "WETH" &&
        selectedTokens.some(
          (t) => t.mintAddress.toLowerCase() === RH_WETH.toLowerCase(),
        )
      ) {
        throw new Error("Cannot sell WETH into WETH");
      }
      const legs = selectedTokens.map((t) => ({
        tokenAddress: t.mintAddress,
        percent: t.sellPercentage || 100,
        symbol: t.symbol,
      }));
      const slippageBps = await resolveSellSlippageBps();
      let results: Awaited<ReturnType<typeof executeGmgnBulkSell>>["results"];
      let success: boolean;
      if (useRhParentPath) {
        const wc = await rhWallet.getWalletClient();
        ({ results, success } = await executeRhParentKyberSell({
          publicClient: rhWallet.getPublicClient(),
          walletClient: wc,
          account: tradeFromAddress as Address,
          legs,
          slippageBps,
          quote: rhQuoteCurrency,
        }));
      } else {
        ({ results, success } = await executeGmgnBulkSell({
          chain: effectiveChain,
          from: tradeFromAddress,
          outputToken:
            effectiveChain === "robinhood" && rhQuoteCurrency === "USDG"
              ? GMGN_RH_USDG
              : effectiveChain === "robinhood" && rhQuoteCurrency === "WETH"
                ? GMGN_RH_WETH
                : gmgnNativeToken(effectiveChain),
          legs,
          slippageBps,
        }));
      }
      const ok = results.filter((r) => r.success);
      const fail = results.filter((r) => !r.success);
      if (ok.length > 0) {
        try {
          if (effectiveChain === "robinhood") {
            // Enriched record: token amount sold + USD estimate (from the
            // pre-sell holdings value) so PnL cycles can close.
            const ethUsd =
              rhQuoteCurrency === "USDG"
                ? 0
                : await fetchEthUsdSpot().catch(() => 0);
            const usdPerUnit = rhQuoteUsdPerUnit(rhQuoteCurrency, ethUsd);
            const built = ok.map((r) => {
              const sel = selectedTokens.find(
                (t) =>
                  t.mintAddress.toLowerCase() === r.tokenAddress.toLowerCase(),
              );
              const pct = sel?.sellPercentage || 100;
              const soldTokenAmount =
                sel && sel.uiAmount > 0 ? (sel.uiAmount * pct) / 100 : undefined;
              const tokenPriceUsd =
                sel && sel.usdValue > 0 && sel.uiAmount > 0
                  ? sel.usdValue / sel.uiAmount
                  : undefined;
              const receivedQuote = r.estOut
                ? rawAmountToHuman(
                    r.estOut,
                    rhQuoteCurrency === "USDG" ? 6 : 18,
                  )
                : undefined;
              return buildRhSellToken({
                mintAddress: r.tokenAddress,
                symbol: r.symbol ?? sel?.symbol,
                soldTokenAmount,
                tokenPriceUsd,
                receivedQuote,
                usdPerUnit,
              });
            });
            const totalUsd = built.reduce((s, b) => s + b.usdValue, 0);
            await trackOperation({
              walletAddress: tradeFromAddress,
              operationType: "sell",
              chain: effectiveChain,
              tokens: built.map((b) => b.token),
              successCount: ok.length,
              failureCount: fail.length,
              totalTokens: results.length,
              totalUsdValue: totalUsd > 0 ? totalUsd : undefined,
              solPriceUsd: usdPerUnit > 0 ? usdPerUnit : undefined,
              feesPaid: 0,
              signatures: ok
                .map((r) => r.orderId || r.hash)
                .filter((id): id is string => Boolean(id)),
              slippage: slippageBps / 100,
            });
          } else {
            await trackOperation({
              walletAddress: tradeFromAddress,
              operationType: "sell",
              chain: effectiveChain,
              tokens: ok.map((r) => ({
                mintAddress: r.tokenAddress,
                symbol: r.symbol,
              })),
              successCount: ok.length,
              failureCount: fail.length,
              totalTokens: results.length,
              feesPaid: 0,
              signatures: ok
                .map((r) => r.orderId || r.hash)
                .filter((id): id is string => Boolean(id)),
              slippage: slippageBps / 100,
            });
          }
        } catch (trackError) {
          console.error("Failed to track RH sell:", trackError);
        }
      }
      showOutcome({
        success,
        operation: "sell",
        isSimulation: false,
        tokenSymbol:
          ok.length === 1 ? ok[0]?.symbol : `${ok.length} tokens`,
        amountUnit: isRhChain ? rhQuoteCurrency : "SOL",
        error: success
          ? undefined
          : fail[0]?.error ||
            (useRhParentPath ? "Parent Kyber sell failed" : "GMGN sell failed"),
      });
      if (success) {
        setSelectedTokens([]);
        void rhWalletTokens.refetch();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
      setGmgnConfirmBusy(false);
      setGmgnConfirmOpen(false);
    }
  }, [
    tradeFromAddress,
    useRhParentPath,
    rhBatchExecutor,
    permit2Readiness,
    rhWallet,
    selectedTokens,
    effectiveChain,
    isRhChain,
    rhQuoteCurrency,
    resolveSellSlippageBps,
    showOutcome,
    rhWalletTokens,
    trackOperation,
  ]);

  const runGmgnBulkSell = runConfirmedRhSell;

  const previewRhSellLegs = useCallback(async (): Promise<GmgnConfirmLeg[]> => {
    const ethUsd = await fetchEthUsdSpot();
    const legs: GmgnConfirmLeg[] = [];
    for (const t of selectedTokens) {
      const pct = t.sellPercentage || 100;
      let fromUsd: number | null = null;
      let toUsd: number | null = null;
      let priceImpactPct: number | null = null;
      let estOut: string | undefined;
      try {
        if (useRhParentPath) {
          const sim = await simulateRhParentSellLeg({
            publicClient: rhWallet.getPublicClient(),
            account: tradeFromAddress as Address,
            tokenAddress: t.mintAddress,
            percent: pct,
            quote: rhQuoteCurrency,
            ethUsd,
            tokenDecimals: t.decimals,
          });
          fromUsd = sim.fromUsd;
          toUsd = sim.toUsd;
          priceImpactPct = sim.priceImpactPct;
          estOut = sim.amountOutRaw ?? undefined;
        } else if (tradeFromAddress) {
          const bal = (await rhWallet.getPublicClient().readContract({
            address: t.mintAddress as Address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [tradeFromAddress as Address],
          })) as bigint;
          const amountRaw = (
            (bal * BigInt(Math.floor(pct * 100))) /
            BigInt(10_000)
          ).toString();
          const sim = await simulateRhBoundSellLeg({
            from: tradeFromAddress,
            tokenAddress: t.mintAddress,
            percent: pct,
            quote: rhQuoteCurrency,
            slippageBps: prefetchSlippageBps(slippage),
            ethUsd,
            amountRaw,
          });
          fromUsd = sim.fromUsd;
          toUsd = sim.toUsd;
          priceImpactPct = sim.priceImpactPct;
          estOut = sim.amountOutRaw ?? undefined;
        }
      } catch {
        /* sim optional */
      }
      legs.push({
        tokenAddress: t.mintAddress,
        symbol: t.symbol,
        amountLabel: `${pct}% → ${rhQuoteCurrency}${
          useRhParentPath ? " · Kyber / Rabby" : ""
        }`,
        side: "sell",
        estOut,
        fromUsd,
        toUsd,
        priceImpactPct,
      });
    }
    return legs;
  }, [
    selectedTokens,
    useRhParentPath,
    rhWallet,
    tradeFromAddress,
    rhQuoteCurrency,
    slippage,
  ]);

  // Handle bulk sell with better error handling
  const handleBulkSell = useCallback(async () => {
    if (selectedTokens.length === 0 && selectedZeroBalanceTokens.length === 0) {
      setError("Please select at least one token");
      return;
    }
    if (selectedTokens.length > MAX_TRADE_TOKENS) {
      setError(`Maximum ${MAX_TRADE_TOKENS} tokens per sell`);
      return;
    }

    // Robinhood: Parent Kyber / Bound GMGN only — never Sol Jupiter/Raptor.
    if (isRhChain) {
      if (!useRhParentPath && !useGmgnPath) {
        setError("Robinhood sell requires Parent (Rabby) or Bound wallet mode");
        return;
      }
      if (!tradeFromAddress) {
        setError(
          useRhParentPath
            ? "Connect Rabby (parent wallet)"
            : "GMGN-bound EVM wallet missing for Robinhood",
        );
        return;
      }
      if (selectedTokens.length === 0) {
        setError(
          useRhParentPath
            ? "Select tokens to sell via Kyber / Rabby"
            : "Select tokens to sell via GMGN",
        );
        return;
      }
      setIsLoading(true);
      setError("");
      try {
        const legs = await previewRhSellLegs();
        autoConfirmFiredRef.current = false;
        setGmgnConfirmLegs(legs);
        setGmgnConfirmOpen(true);
        if (tradeAutoConfirm && legs.length > 0) {
          autoConfirmFiredRef.current = true;
          void runConfirmedRhSell();
        }
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // Sol: optional GMGN bound path
    if (useGmgnPath) {
      if (!tradeFromAddress) {
        setError("Connect the GMGN-bound Sol wallet or turn off Use GMGN");
        return;
      }
      if (!solGmgnSynced) {
        setError("Connected wallet is not the GMGN-bound Sol address");
        return;
      }
      if (selectedTokens.length === 0) {
        setError("Select tokens to sell via GMGN");
        return;
      }
      setGmgnConfirmLegs(
        selectedTokens.map((t) => ({
          tokenAddress: t.mintAddress,
          symbol: t.symbol,
          amountLabel: `${t.sellPercentage || 100}% → SOL`,
          side: "sell" as const,
        })),
      );
      autoConfirmFiredRef.current = false;
      setGmgnConfirmOpen(true);
      if (tradeAutoConfirm && selectedTokens.length > 0) {
        autoConfirmFiredRef.current = true;
        void runConfirmedRhSell();
      }
      return;
    }

    if (!connected || !publicKey || !signAllTransactions) {
      setError("Please connect your wallet first");
      return;
    }

    if (!isSolTrade) {
      setError("Solana sell is not available on Robinhood network");
      return;
    }

    if (!connection) {
      setError("RPC connection not ready");
      return;
    }

    setIsLoading(true);
    setError("");
    setSellPointsEarned(null);
    setClosePointsEarned(null);

    try {
      // Get balance before operation (non-blocking — sell continues if RPC fails)
      try {
        const balanceBeforeOp = await connection.getBalance(publicKey);
        setBalanceBefore(balanceBeforeOp / LAMPORTS_PER_SOL);
      } catch (balanceErr) {
        console.warn("Could not fetch balance before sell:", balanceErr);
      }

      const slippageBps = await resolveSellSlippageBps();
      const request: BulkSellRequest = {
        tokens: selectedTokens,
        unsellableTokens:
          selectedZeroBalanceTokens.length > 0
            ? selectedZeroBalanceTokens
            : undefined,
        slippage: slippageBps,
        priorityFee,
      };

      const sellResult = await executeBulkSellAlt(
        request,
        publicKey.toString(),
        connection,
        signAllTransactions,
      );

      // Get balance after operation (non-blocking)
      try {
        const balanceAfterOp = await connection.getBalance(publicKey);
        setBalanceAfter(balanceAfterOp / LAMPORTS_PER_SOL);
      } catch (balanceErr) {
        console.warn("Could not fetch balance after sell:", balanceErr);
      }

      if (
        sellResult &&
        (sellResult.successfulSwaps.length > 0 ||
          sellResult.failedSwaps.length > 0 ||
          sellResult.successfulCloses.length > 0 ||
          sellResult.failedCloses.length > 0)
      ) {
        const alreadyClosed = new Set(sellResult.successfulCloses);
        const closeable = selectedTokens.filter(
          (t) =>
            t.sellPercentage >= 100 &&
            sellResult.successfulSwaps.some(
              (s) => s.mintAddress === t.mintAddress,
            ) &&
            !alreadyClosed.has(t.mintAddress),
        );
        setPendingCloseableTokens(closeable);

        showOutcome({
          success: sellResult.success,
          operation: "sell",
          isSimulation: false,
          tokenSymbol:
            sellResult.successfulSwaps.length === 1
              ? selectedTokens.find(
                  (t) =>
                    t.mintAddress ===
                    sellResult.successfulSwaps[0]?.mintAddress,
                )?.symbol
              : `${sellResult.successfulSwaps.length} tokens`,
          solAmount: sellResult.totalReceived,
          amountUnit: "SOL",
          error: sellResult.success
            ? undefined
            : sellResult.failedSwaps[0]?.error || "Sell failed",
          closeableAccounts: sellResult.success
            ? closeable.map((t) => ({
                mintAddress: t.mintAddress,
                symbol: t.symbol,
              }))
            : undefined,
        });
      }

      // Track the sell operation
      if (sellResult) {
        // Track sell operations (swaps)
        if (
          sellResult.successfulSwaps.length > 0 ||
          sellResult.failedSwaps.length > 0
        ) {
          // Track sell operation securely via server route for points
          try {
            const trackResult = await trackSell(
              publicKey.toString(),
              sellResult.successfulSwaps.length,
              {
                failureCount: sellResult.failedSwaps.length,
                solAmount: sellResult.totalReceived,
                tokenMints: sellResult.successfulSwaps.map(
                  (s) => s.mintAddress,
                ),
                signatures: sellResult.signatures,
              },
            );
            console.log(
              `🎉 Earned ${trackResult.pointsEarned} points from sell operation!`,
            );
            setSellPointsEarned(trackResult.pointsEarned);
          } catch (trackError) {
            console.error(
              "Failed to track sell operation for points:",
              trackError,
            );
          }

          // Track operation for PnL and history via React Query
          try {
            // Fetch current token prices and SOL price for accurate tracking
            const tokenMints = selectedTokens.map((t) => t.mintAddress);
            const [tokenPrices, currentSolPrice] = await Promise.all([
              fetchTokenPricesForTracking(tokenMints),
              getSolPriceUSD(),
            ]);

            // Calculate individual SOL amounts based on token USD values and proportions
            const totalUsdValueSold = selectedTokens.reduce((sum, token) => {
              return sum + (token.usdValue * token.sellPercentage) / 100;
            }, 0);

            const totalSolReceived = sellResult.totalReceived || 0;

            // Prepare enhanced token data with current prices, amounts, and individual SOL amounts
            const enhancedTokenData = selectedTokens
              .filter((token) =>
                sellResult.successfulSwaps.some(
                  (s) => s.mintAddress === token.mintAddress,
                ),
              )
              .map((token) => {
                // Calculate proportional SOL amount based on this token's USD value relative to total
                const tokenUsdValue =
                  (token.usdValue * token.sellPercentage) / 100;
                const solAmountForThisToken =
                  totalUsdValueSold > 0
                    ? (tokenUsdValue / totalUsdValueSold) * totalSolReceived
                    : totalSolReceived / sellResult.successfulSwaps.length; // Fallback to equal split

                return {
                  mintAddress: token.mintAddress,
                  symbol: token.symbol,
                  name: token.name,
                  logoURI: token.logoURI,
                  priceUsd: tokenPrices[token.mintAddress] || 0,
                  tokenAmount: token.sellAmount, // Amount of tokens being sold
                  solAmount: solAmountForThisToken, // Individual SOL amount for this token
                };
              });

            const sellErrors =
              sellResult.failedSwaps.length > 0
                ? sellResult.failedSwaps.map((f) => f.error)
                : undefined;

            // Track via centralized React Query system
            await trackOperation({
              walletAddress: publicKey.toString(),
              operationType: "sell",
              chain: effectiveChain,
              tokens: enhancedTokenData.map((token) => ({
                ...token,
                solPrice: currentSolPrice,
              })),
              successCount: sellResult.successfulSwaps.length,
              failureCount: sellResult.failedSwaps.length,
              totalTokens:
                sellResult.successfulSwaps.length +
                sellResult.failedSwaps.length,
              solAmount: sellResult.totalReceived || 0, // Keep total for backward compatibility
              feesPaid: 0, // We don't track this locally yet
              solPriceUsd: currentSolPrice,
              totalUsdValue: currentSolPrice
                ? (sellResult.totalReceived || 0) * currentSolPrice
                : undefined,
              signatures: sellResult.signatures,
              slippage: slippageBps / 100,
              priorityFee,
              errors: sellErrors,
            });

            // ✅ NEW: Auto-trigger share modal for successful sells
            if (sellResult.successfulSwaps.length > 0 && totalSolReceived > 0) {
              // For bulk sells, we'll trigger share for the most significant trade
              const mostSignificantToken = enhancedTokenData.reduce(
                (prev, current) =>
                  current.solAmount > prev.solAmount ? current : prev,
              );

              if (mostSignificantToken) {
                // Calculate P&L percentage (we don't have buy data here, so we'll estimate)
                // This is a simplified approach - in a real scenario you'd want to track buy history
                const estimatedBuyValue = mostSignificantToken.solAmount * 0.8; // Assume 25% profit for demo
                const pnlPercentage = pnlShareService.calculatePnLPercentage(
                  estimatedBuyValue,
                  mostSignificantToken.solAmount,
                );

                if (Math.abs(pnlPercentage) >= 5) {
                  // Only trigger for trades with >= 5% P&L
                  setTimeout(async () => {
                    try {
                      await autoTriggerShare({
                        coinName:
                          mostSignificantToken.symbol ||
                          mostSignificantToken.name ||
                          "Token",
                        profitPercentage: pnlPercentage,
                        tokenAddress: mostSignificantToken.mintAddress,
                        solAmountBought: estimatedBuyValue,
                        solAmountSold: mostSignificantToken.solAmount,
                      });
                    } catch (error) {
                      console.error(
                        "Error auto-triggering share for bulk sell:",
                        error,
                      );
                    }
                  }, 1000);
                }
              }
            }
          } catch (trackError) {
            console.error(
              "Failed to track sell operation for history/PnL:",
              trackError,
            );
          }
        }

        // Track close operations
        if (
          sellResult.successfulCloses.length > 0 ||
          sellResult.failedCloses.length > 0
        ) {
          const allClosedTokens = [
            ...selectedTokens.filter(
              (token) =>
                sellResult.successfulCloses.includes(token.mintAddress) ||
                sellResult.failedCloses.some(
                  (f) => f.mintAddress === token.mintAddress,
                ),
            ),
            ...selectedZeroBalanceTokens,
          ];

          // Track close operation securely via server route for points
          try {
            const trackResult = await trackClose(
              publicKey.toString(),
              sellResult.successfulCloses.length,
              {
                failureCount: sellResult.failedCloses.length,
                tokenMints: sellResult.successfulCloses,
                signatures: sellResult.signatures,
                solAmount: sellResult.successfulCloses.length * 0.00203928,
              },
            );
            console.log(
              `🎉 Earned ${trackResult.pointsEarned} points from close operation!`,
            );
            setClosePointsEarned(trackResult.pointsEarned);
          } catch (trackError) {
            console.error(
              "Failed to track close operation for points:",
              trackError,
            );
          }

          // Track operation for PnL and history via React Query
          try {
            // Get SOL price for tracking (close operations don't need token prices)
            const currentSolPrice = await getSolPriceUSD();

            const closeTokenData = allClosedTokens.map((token) => ({
              mintAddress: token.mintAddress,
              symbol: token.symbol,
              name: token.name,
              logoURI: token.logoURI,
            }));

            const closeErrors =
              sellResult.failedCloses.length > 0
                ? sellResult.failedCloses.map((f) => f.error)
                : undefined;

            // Track via centralized React Query system
            await trackOperation({
              walletAddress: publicKey.toString(),
              operationType: "close",
              chain: effectiveChain,
              tokens: closeTokenData.map((token) => ({
                ...token,
                solPrice: currentSolPrice,
              })),
              successCount: sellResult.successfulCloses.length,
              failureCount: sellResult.failedCloses.length,
              totalTokens:
                sellResult.successfulCloses.length +
                sellResult.failedCloses.length,
              feesPaid: 0, // We don't track this locally yet
              solPriceUsd: currentSolPrice,
              signatures: sellResult.signatures,
              errors: closeErrors,
            });
          } catch (trackError) {
            console.error(
              "Failed to track close operation for history/PnL:",
              trackError,
            );
          }
        }
      }

      if (sellResult.success || sellResult.successfulCloses.length > 0) {
        setSelectedTokens([]);
        setSelectedZeroBalanceTokens([]);
        triggerPostTradeRefresh({
          refreshWalletTokens: () => fetchTokensFresh(),
        });
      }
    } catch (err) {
      console.error("Bulk operation error:", err);

      let message = "An unknown error occurred. Please try again.";
      if (err instanceof Error) {
        if (
          err.message.includes("ChunkLoadError") ||
          err.message.includes("Loading chunk")
        ) {
          message =
            "Network error occurred. Please refresh the page and try again.";
        } else {
          message = err.message;
        }
      }
      setError(message);
      showOutcome({
        success: false,
        operation: "sell",
        isSimulation: false,
        error: message,
      });
    } finally {
      setIsLoading(false);
    }
  }, [
    connected,
    publicKey,
    signAllTransactions,
    connection,
    selectedTokens,
    selectedZeroBalanceTokens,
    resolveSellSlippageBps,
    slippage,
    priorityFee,
    fetchTokensFresh,
    autoTriggerShare,
    triggerPostTradeRefresh,
    showOutcome,
    trackOperation,
    useGmgnPath,
    useRhParentPath,
    tradeFromAddress,
    effectiveChain,
    isRhChain,
    isSolTrade,
    solGmgnSynced,
    rhQuoteCurrency,
    rhWallet.getPublicClient(),
    runConfirmedRhSell,
    previewRhSellLegs,
    tradeAutoConfirm,
  ]);

  useEffect(() => {
    if (!gmgnConfirmOpen || !isRhChain || gmgnConfirmBusy) return;
    let cancelled = false;
    const tick = async () => {
      setGmgnQuoteRefreshing(true);
      try {
        const legs = await previewRhSellLegs();
        if (!cancelled) setGmgnConfirmLegs(legs);
      } catch {
        /* keep last */
      } finally {
        if (!cancelled) setGmgnQuoteRefreshing(false);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [gmgnConfirmOpen, isRhChain, gmgnConfirmBusy, previewRhSellLegs]);

  useEffect(() => {
    if (!gmgnConfirmOpen || !tradeAutoConfirm || gmgnConfirmBusy) return;
    if (gmgnConfirmLegs.length === 0) return;
    if (autoConfirmFiredRef.current) return;
    autoConfirmFiredRef.current = true;
    void runConfirmedRhSell();
  }, [
    gmgnConfirmOpen,
    tradeAutoConfirm,
    gmgnConfirmBusy,
    gmgnConfirmLegs,
    runConfirmedRhSell,
  ]);

  /** Close emptied ATAs offered on the post-sell success modal. */
  const handlePostSellCloseAccounts = useCallback(async () => {
    if (
      !connected ||
      !publicKey ||
      !signAllTransactions ||
      !connection ||
      pendingCloseableTokens.length === 0
    ) {
      return;
    }

    setIsClosingAccounts(true);
    try {
      const closeOnlyResult = await executeBulkSellAlt(
        {
          tokens: [],
          unsellableTokens: pendingCloseableTokens,
          slippage: prefetchSlippageBps(slippage),
          priorityFee,
        },
        publicKey.toString(),
        connection,
        signAllTransactions,
      );

      const closeConfirmed = closeOnlyResult.signatures.length > 0;
      setPendingCloseableTokens([]);

      if (closeConfirmed) {
        try {
          await trackClose(
            publicKey.toString(),
            closeOnlyResult.successfulCloses.length,
            {
              failureCount: closeOnlyResult.failedCloses.length,
              tokenMints: closeOnlyResult.successfulCloses,
              signatures: closeOnlyResult.signatures,
              solAmount: closeOnlyResult.successfulCloses.length * 0.00203928,
            },
          );
        } catch (trackError) {
          console.error("Failed to track post-sell close:", trackError);
        }

        triggerPostTradeRefresh({
          refreshWalletTokens: () => fetchTokensFresh(),
        });

        showOutcome({
          success: closeOnlyResult.failedCloses.length === 0,
          operation: "close",
          isSimulation: false,
          tokenSymbol:
            closeOnlyResult.successfulCloses.length === 1
              ? `${closeOnlyResult.successfulCloses[0].slice(0, 4)}…`
              : `${closeOnlyResult.successfulCloses.length} accounts`,
          error:
            closeOnlyResult.failedCloses.length > 0
              ? closeOnlyResult.failedCloses[0]?.error || "Close failed"
              : undefined,
        });
      } else {
        showOutcome({
          success: false,
          operation: "close",
          isSimulation: false,
          error:
            closeOnlyResult.failedCloses[0]?.error ||
            "No accounts closed",
        });
      }
    } catch (err) {
      console.error("Post-sell close error:", err);
      showOutcome({
        success: false,
        operation: "close",
        isSimulation: false,
        error: err instanceof Error ? err.message : "Close failed",
      });
    } finally {
      setIsClosingAccounts(false);
    }
  }, [
    connected,
    publicKey,
    signAllTransactions,
    connection,
    pendingCloseableTokens,
    slippage,
    priorityFee,
    fetchTokensFresh,
    triggerPostTradeRefresh,
    showOutcome,
  ]);

  // Handle close-only (burn) operation without selling any tokens
  const handleCloseOnly = useCallback(async () => {
    if (!connected || !publicKey || !signAllTransactions) {
      setError("Please connect your wallet first");
      return;
    }

    if (selectedTokens.length === 0 && selectedZeroBalanceTokens.length === 0) {
      setError("Please select at least one token");
      return;
    }

    if (!connection) {
      setError("RPC connection not ready");
      return;
    }

    const hasBalance = selectedTokens.some((t) => (t.balance ?? 0) > 0);
    if (hasBalance) {
      const count = selectedTokens.length + selectedZeroBalanceTokens.length;
      const ok = window.confirm(
        `Directly close ${count} token account${count !== 1 ? "s" : ""} without selling?\n\n` +
          `Remaining balance will be BURNED (not swapped to SOL). ` +
          `You may reclaim ~0.002 SOL rent per closed account.`,
      );
      if (!ok) return;
    }

    setIsLoading(true);
    setError("");
    setClosePointsEarned(null);

    try {
      const request: BulkSellRequest = {
        tokens: [], // no swaps, only closes
        unsellableTokens: [...selectedTokens, ...selectedZeroBalanceTokens],
        slippage: prefetchSlippageBps(slippage),
        priorityFee,
      };

      const closeOnlyResult = await executeBulkSellAlt(
        request,
        publicKey.toString(),
        connection,
        signAllTransactions,
      );

      const closeData = {
        successful: closeOnlyResult.successfulCloses,
        failed: closeOnlyResult.failedCloses,
        signatures: closeOnlyResult.signatures,
      };

      const closeConfirmed = closeData.signatures.length > 0;

      if (closeConfirmed) {
        showOutcome({
          success: closeData.failed.length === 0,
          operation: "close",
          isSimulation: false,
          tokenSymbol:
            closeData.successful.length === 1
              ? `${closeData.successful[0].slice(0, 4)}…`
              : `${closeData.successful.length} accounts`,
          error:
            closeData.failed.length > 0
              ? closeData.failed[0]?.error || "Close failed"
              : undefined,
        });
      } else if (closeData.failed.length > 0) {
        showOutcome({
          success: false,
          operation: "close",
          isSimulation: false,
          error: closeData.failed[0]?.error || "Close failed",
        });
      } else {
        setError("No accounts to close");
      }

      // Points tracking
      if (closeConfirmed) {
        try {
          const trackResult = await trackClose(
            publicKey.toString(),
            closeData.successful.length,
            {
              failureCount: closeData.failed.length,
              tokenMints: closeData.successful,
              signatures: closeData.signatures,
              solAmount: closeData.successful.length * 0.00203928,
            },
          );
          console.log(
            `🎉 Earned ${trackResult.pointsEarned} points from close operation!`,
          );
          setClosePointsEarned(trackResult.pointsEarned);
        } catch (trackError) {
          console.error(
            "Failed to track close operation for points:",
            trackError,
          );
        }
      }

      // History / PnL tracking
      if (closeConfirmed) {
        try {
          const currentSolPrice = await getSolPriceUSD();
          const closeTokenData = [
            ...selectedTokens,
            ...selectedZeroBalanceTokens,
          ].map((token) => ({
            mintAddress: token.mintAddress,
            symbol: token.symbol,
            name: token.name,
            logoURI: token.logoURI,
          }));

          const closeErrors =
            closeData.failed.length > 0
              ? closeData.failed.map((f) => f.error)
              : undefined;

          await trackOperation({
            walletAddress: publicKey.toString(),
            operationType: "close",
            chain: effectiveChain,
            tokens: closeTokenData.map((t) => ({
              ...t,
              solPrice: currentSolPrice,
            })),
            successCount: closeData.successful.length,
            failureCount: closeData.failed.length,
            totalTokens: closeData.successful.length + closeData.failed.length,
            feesPaid: 0,
            solPriceUsd: currentSolPrice,
            signatures: closeData.signatures,
            errors: closeErrors,
          });
        } catch (trackError) {
          console.error(
            "Failed to track close operation for history/PnL:",
            trackError,
          );
        }
      }

      // Refresh token list and clear selection
      if (closeConfirmed && closeData.successful.length > 0) {
        setSelectedTokens([]);
        setSelectedZeroBalanceTokens([]);
        triggerPostTradeRefresh({
          refreshWalletTokens: () => fetchTokensFresh(),
        });
      }
    } catch (err) {
      console.error("Close-only operation error:", err);
      const message =
        err instanceof Error
          ? err.message
          : "An unknown error occurred. Please try again.";
      setError(message);
      showOutcome({
        success: false,
        operation: "close",
        isSimulation: false,
        error: message,
      });
    } finally {
      setIsLoading(false);
    }
  }, [
    connected,
    publicKey,
    signAllTransactions,
    connection,
    selectedTokens,
    selectedZeroBalanceTokens,
    slippage,
    priorityFee,
    fetchTokensFresh,
    trackOperation,
    triggerPostTradeRefresh,
    showOutcome,
    effectiveChain,
  ]);

  useEffect(() => {
    autoSelectRanAfterFetchRef.current = false;
  }, [walletAddress]);

  useEffect(() => {
    if (!autoSelectBest || !walletAddress || !isWalletReady || !showRpcPanel) {
      return;
    }

    if (autoSelectRanAfterFetchRef.current) {
      return;
    }

    autoSelectRanAfterFetchRef.current = true;
    void autoSelectBestEndpoint(walletAddress);
  }, [
    autoSelectBest,
    walletAddress,
    isWalletReady,
    showRpcPanel,
    autoSelectBestEndpoint,
  ]);

  const lastFetchErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!fetchError || !walletAddress || !autoSelectBest) return;
    if (lastFetchErrorRef.current === fetchError) return;
    lastFetchErrorRef.current = fetchError;
    void autoSelectBestEndpoint(walletAddress, true);
  }, [fetchError, walletAddress, autoSelectBest, autoSelectBestEndpoint]);

  useEffect(() => {
    if (isRhChain) {
      if (!tradeFromAddress) setSelectedTokens([]);
      return;
    }
    if (!isWalletReady) {
      setSelectedTokens([]);
      setSelectedZeroBalanceTokens([]);
    }
  }, [isRhChain, tradeFromAddress, isWalletReady]);

  // Set up metadata update callback
  useEffect(() => {
    setMetadataUpdateCallback(handleMetadataUpdate);
    return () => clearMetadataUpdateCallback();
  }, [handleMetadataUpdate]);

  // Calculate estimated SOL after fees for selected tokens
  const grossUSD = selectedTokens.reduce(
    (total, token) => total + (token.usdValue * token.sellPercentage) / 100,
    0,
  );
  const grossSOL = grossUSD / solPriceUsd; // Convert USD to SOL
  const sellFee = getFeeForOperation("SELL", grossSOL); // 0.5% of SOL received
  // Close fees/rent only for explicit close targets (zero-balance), not 100% sells —
  // sell no longer auto-closes emptied ATAs (use Close for rent reclaim).
  const tokensToClose = selectedZeroBalanceTokens.length;
  const closeFee = getFeeForOperation("CLOSE") * tokensToClose;
  const rentRecovery = tokensToClose * 0.00203928;
  const estimatedSOL = grossSOL - sellFee - closeFee + rentRecovery;

  // Calculate total reload estimation based on showDustOnly filter
  const dustTokenList = useMemo(
    () => [...dustTokens, ...zeroValueTokens],
    [dustTokens, zeroValueTokens],
  );

  const allBalancedTokens = useMemo(
    () =>
      [...userTokens, ...dustTokens, ...zeroValueTokens].filter(
        (token) => !token.isNFT && token.uiAmount > MIN_BALANCE_UI,
      ),
    [userTokens, dustTokens, zeroValueTokens],
  );

  const tokensForCalculation = showDustOnly ? dustTokenList : allBalancedTokens;

  const totalGrossUSD = tokensForCalculation.reduce(
    (total, token) => total + token.usdValue,
    0,
  );
  // Include zero-value tokens in calculation (they contribute to rent recovery)
  const totalZeroTokens = showDustOnly
    ? zeroValueTokens.length
    : zeroBalanceTokens.length;
  const totalGrossSOL = totalGrossUSD / solPriceUsd;
  const totalSellFee = getFeeForOperation("SELL", totalGrossSOL);
  // Rent reclaim is a separate Close step; estimate sell proceeds only here.
  const totalCloseFee = getFeeForOperation("CLOSE") * totalZeroTokens;
  const totalRentRecovery = totalZeroTokens * 0.00203928;
  const totalReloadEstimate =
    totalGrossSOL - totalSellFee - totalCloseFee + totalRentRecovery;

  // Handle token selection for chart display
  const handleSelectToken = useCallback((mintAddress: string) => {
    // Show chart for the selected token
    setSelectedToken(mintAddress);
  }, []);

  const zeroBalanceMintSet = useMemo(
    () => new Set(zeroValueTokens.map((t) => t.mintAddress)),
    [zeroValueTokens],
  );

  const emptyAccountTokens = useMemo(
    () =>
      zeroBalanceTokens.filter((token) => token.uiAmount <= MIN_BALANCE_UI),
    [zeroBalanceTokens],
  );

  const displayUserTokens = useMemo(() => {
    if (isRhChain) {
      return rhWalletTokens.tokens;
    }
    if (showDustOnly) {
      return dustTokenList;
    }
    if (showZeroBalance) {
      return [...allBalancedTokens, ...emptyAccountTokens];
    }
    return allBalancedTokens;
  }, [
    isRhChain,
    rhWalletTokens.tokens,
    showDustOnly,
    showZeroBalance,
    dustTokenList,
    allBalancedTokens,
    emptyAccountTokens,
  ]);

  const filteredUserTokens = displayUserTokens;

  /** RH: sum of holdings USD for header (no Sol fee/rent math). */
  const rhHoldingsUsdTotal = useMemo(() => {
    if (!isRhChain) return 0;
    return rhWalletTokens.tokens.reduce((s, t) => s + (t.usdValue || 0), 0);
  }, [isRhChain, rhWalletTokens.tokens]);

  const incompleteRpcBanner = useMemo(() => {
    if (diagnostics.length === 0 || !selectedEndpoint) return null;
    const current = diagnostics.find((d) => d.index === selectedEndpointIndex);
    const best = [...diagnostics]
      .filter((d) => d.indexHealthy)
      .sort((a, b) => b.rawAccountCount - a.rawAccountCount)[0];

    if (current && !current.indexHealthy) {
      const hint = current.indexError
        ? current.indexError
        : "Current RPC cannot index token accounts";
      if (best) {
        return `${hint} — switch to ${best.provider} (${best.rawAccountCount} accounts).`;
      }
      return `${hint} — add an index-capable RPC to RPC_URL in .env.`;
    }

    if (
      current &&
      best &&
      current.index !== best.index &&
      current.rawAccountCount === 0 &&
      best.rawAccountCount > 0
    ) {
      return `Current RPC may be incomplete — switch to ${best.provider} (${best.rawAccountCount} accounts).`;
    }
    return null;
  }, [diagnostics, selectedEndpoint, selectedEndpointIndex]);

  const handleTestAllRpcs = useCallback(async () => {
    if (!publicKey) return;
    await runDiagnostics(publicKey.toString());
  }, [publicKey, runDiagnostics]);

  const handleRpcSelect = useCallback(
    (index: number) => {
      setSelectedEndpointIndex(index);
    },
    [setSelectedEndpointIndex],
  );

  // Toggle dust filter
  const toggleDustFilter = () => {
    setShowDustOnly((prev) => !prev);
    // Clear selection when toggling filter to avoid confusion
    setSelectedTokens([]);
  };

  return (
    <div className="bg-gray-900 rounded-2xl shadow-lg border border-gray-700 p-8 space-y-8 max-w-6xl mx-auto">
      <GmgnTradeConfirmModal
        open={gmgnConfirmOpen && (isDevUser || isRhChain)}
        chain={effectiveChain}
        from={tradeFromAddress || ""}
        legs={gmgnConfirmLegs}
        busy={gmgnConfirmBusy}
        sequentialSignHint={
          useRhParentPath && !getRhBatchExecutorAddress()
        }
        feeHint={
          useRhParentPath && getRhBatchExecutorAddress()
            ? RH_PLATFORM_FEE_LABEL
            : undefined
        }
        volatile={
          isRhChain &&
          quoteIsVolatile(gmgnConfirmLegs.map((l) => l.priceImpactPct))
        }
        quoteRefreshing={gmgnQuoteRefreshing}
        autoConfirm={tradeAutoConfirm}
        onAutoConfirmChange={(on) => {
          setTradeAutoConfirm(on);
          writeTradeAutoConfirm(on);
        }}
        onCancel={() => {
          autoConfirmFiredRef.current = false;
          setGmgnConfirmOpen(false);
        }}
        onConfirm={() => void runConfirmedRhSell()}
      />
      {tradeFromAddress ? (
        <RhPermit2SetupSheet
          open={permit2SetupOpen}
          onClose={() => setPermit2SetupOpen(false)}
          publicClient={rhWallet.getPublicClient()}
          getWalletClient={rhWallet.getWalletClient}
          account={tradeFromAddress as Address}
          spender={rhBatchExecutor}
          tokens={permit2SetupTokens}
          readiness={permit2Readiness.data}
          loading={permit2Readiness.isLoading || permit2Readiness.isFetching}
          error={permit2Readiness.isError}
          onRefresh={async () => (await permit2Readiness.refetch()).data}
        />
      ) : null}
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex justify-between items-center w-full">
          <h2 className="text-3xl font-bold text-white">
            Sell Bulk & Reload{" "}
            {effectiveChain === "robinhood"
              ? rhQuoteCurrency
              : "your solana"}
          </h2>
          <div className="shrink-0">
            {effectiveChain === "sol" ? <UniversalWalletButton /> : null}
          </div>
        </div>
      </div>

      {useRhParentPath ? (
        <RhPermit2StatusBanner
          executorConfigured={Boolean(rhBatchExecutor)}
          readiness={permit2Readiness.data}
          loading={permit2Readiness.isLoading || permit2Readiness.isFetching}
          error={permit2Readiness.isError}
          onSetup={() => setPermit2SetupOpen(true)}
        />
      ) : null}

      {isDevUser && effectiveChain === "sol" && solGmgnSynced ? (
        <label className="flex items-center gap-2 text-xs text-gray-300">
          <input
            type="checkbox"
            checked={useGmgnOnSol}
            onChange={(e) => setUseGmgnOnSol(e.target.checked)}
          />
          Use GMGN
          <span className="text-emerald-400">GMGN synced</span>
        </label>
      ) : null}

      {isRhChain ? (
        <div className="rounded-xl border border-gray-700 bg-gray-800/50 px-4 py-3 text-sm text-gray-300 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span>Sell to:</span>
            {(["ETH", "USDG", "WETH"] as const).map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setRhQuoteCurrency(q)}
                className={`px-2 py-0.5 rounded font-mono text-xs ${
                  rhQuoteCurrency === q
                    ? "bg-white text-black"
                    : "bg-gray-700 text-gray-300 hover:text-white"
                }`}
              >
                {q}
              </button>
            ))}
          </div>
          <div>
            Mode:{" "}
            <span className="text-white font-medium">
              {rhMode === "parent" ? "Parent (Rabby / Kyber)" : "Bound (GMGN)"}
            </span>
          </div>
          <div>
            Active:{" "}
            <span className="font-mono text-white break-all">
              {tradeFromAddress || "—"}
            </span>
          </div>
          {rhMode === "bound" && !boundWallets.evm ? (
            <span className="text-amber-400">
              No bound EVM wallet from GMGN API key / env
            </span>
          ) : null}
        </div>
      ) : null}

      {isDevUser && (rosterSellRecsQuery.data?.length ?? 0) > 0 ? (
        <div className="space-y-2">
          <div className="text-xs uppercase tracking-wide text-gray-400">
            Roster digger ({effectiveChain})
          </div>
          <div className="flex flex-wrap gap-2">
            {rosterSellRecsQuery.data!.map((addr) => (
              <button
                key={addr}
                type="button"
                onClick={() => {
                  const held =
                    displayUserTokens.find((t) => t.mintAddress === addr) ??
                    (isRhChain
                      ? {
                          mintAddress: addr,
                          balance: 0,
                          decimals: 18,
                          symbol: addr.slice(0, 4),
                          name: addr,
                          uiAmount: 0,
                          usdValue: 0,
                        }
                      : null);
                  if (held) toggleTokenSelection(held);
                }}
                className="rounded-lg bg-gray-800 px-2 py-1 font-mono text-xs text-gray-200 hover:bg-gray-700"
              >
                {addr.slice(0, 6)}…{addr.slice(-4)}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-8">
        {/* Token Chart Section */}
        {selectedToken && (
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <label className="block text-sm font-semibold text-gray-200 uppercase tracking-wide">
                  Token Chart
                </label>
                <span className="text-xs font-mono text-gray-400">
                  {selectedToken}
                </span>
              </div>
              {/* DLMM-style chart: stable, lazy iframe + loading state + open-on-GMGN */}
              <GmgnKlineChart
                tokenMint={selectedToken}
                chain={effectiveChain}
                height={400}
                interval="1D"
                className="rounded-xl border-gray-600"
              />
            </div>
        )}

        {isSolTrade && connected ? (
          <RpcPanel
            expanded={showRpcPanel}
            onToggle={() => setShowRpcPanel((prev) => !prev)}
            endpoints={endpoints}
            selectedEndpointIndex={selectedEndpointIndex}
            onSelectEndpoint={handleRpcSelect}
            autoSelectBest={autoSelectBest}
            onAutoSelectBestChange={setAutoSelectBest}
            onTestAll={handleTestAllRpcs}
            isRunningDiagnostics={isRunningDiagnostics}
            diagnostics={diagnostics}
            lastFetchMeta={lastFetchMeta}
            incompleteRpcBanner={incompleteRpcBanner}
          />
        ) : null}

        {/* Token Selection Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h3 className="text-xl font-light text-white mb-1">
              {isRhChain ? (
                <>
                  You have{" "}
                  {rhHoldingsUsdTotal > 0 ? (
                    <span className="font-bold">
                      ~$
                      {rhHoldingsUsdTotal.toLocaleString(undefined, {
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  ) : (
                    <span className="font-bold">holdings</span>
                  )}{" "}
                  to sell → {rhQuoteCurrency}
                </>
              ) : (
                <>
                  You have{" "}
                  {(showDustOnly
                    ? dustTokenList.length > 0
                    : userTokens.length > 0) &&
                    totalReloadEstimate > 0 && (
                      <span className="font-bold">
                        ~ {totalReloadEstimate.toFixed(3)} SOL
                      </span>
                    )}{" "}
                  to reload 🚀
                </>
              )}
            </h3>
            <p className="text-gray-400 text-sm">
              {selectedTokens.length} of {filteredUserTokens.length}{" "}
              {isRhChain
                ? "tokens"
                : showDustOnly
                  ? "dust"
                  : "valuable"}{" "}
              tokens selected (max {MAX_TRADE_TOKENS} to sell)
            </p>
          </div>
          <div className="flex items-center space-x-3">
            <button
              onClick={() => {
                if (isRhChain) {
                  void fetchTokens(true);
                  return;
                }
                void refreshAllPrices();
              }}
              disabled={
                isLoadingTokensList ||
                (isRhChain
                  ? filteredUserTokens.length === 0 && !tradeFromAddress
                  : swappableTokens.length === 0)
              }
              className="p-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={isRhChain ? "Refresh holdings" : "Refresh Prices"}
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
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
            {!isRhChain ? (
              <>
                <button
                  onClick={() => setShowZeroBalance((prev) => !prev)}
                  className={`px-4 py-2 rounded-lg transition-colors text-sm ${
                    showZeroBalance
                      ? "bg-blue-600 hover:bg-blue-500 text-white"
                      : "bg-gray-600 hover:bg-gray-500 text-white"
                  }`}
                >
                  {showZeroBalance ? "Hide zero balance" : "Show zero balance"}
                </button>
                <button
                  onClick={toggleDustFilter}
                  className={`px-4 py-2 rounded-lg transition-colors text-sm flex items-center space-x-2 ${
                    showDustOnly
                      ? "bg-gray-600 hover:bg-gray-500 text-white"
                      : "bg-yellow-600 hover:bg-yellow-500 text-white"
                  }`}
                >
                  <span>{showDustOnly ? "Show all" : "Dust only"}</span>
                </button>
              </>
            ) : null}
            <button
              onClick={selectAllTokens}
              disabled={filteredUserTokens.length === 0}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors text-sm"
            >
              Select All
            </button>
            <button
              onClick={clearSelection}
              disabled={selectedTokens.length === 0}
              className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors text-sm"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="flex justify-between items-center">
          <h3 className="text-md font-semibold text-white mb-1">
            Your Tokens
            {isRhChain && rhWalletTokens.source ? (
              <span className="ml-2 text-xs font-normal text-gray-500 uppercase">
                via {rhWalletTokens.source}
              </span>
            ) : null}
          </h3>
          <p className="text-xs text-gray-400 flex items-center">
            <svg
              className="w-4 h-4 mr-1"
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                clipRule="evenodd"
              />
            </svg>
            Hover over a token and click on the{" "}
            <svg
              className="w-4 h-4 mx-1 text-gray-300"
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
            </svg>{" "}
            icon to view price charts
          </p>
        </div>

        {/* Token List */}
        {isInitialLoadTokens &&
        (isRhChain ? Boolean(tradeFromAddress) : isWalletReady) ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-gray-400 border-t-white rounded-full animate-spin"></div>
            </div>
            <h3 className="text-lg font-semibold text-gray-300 mb-2">
              Checking all tokens on your wallet...
            </h3>
            <TokenSkeleton count={3} variant="progressive" />
          </div>
        ) : isLoadingTokensList ? (
          <>
            <TokenSkeleton count={3} variant="progressive" />
          </>
        ) : fetchError ? (
          <div className="text-center py-12">
            <h3 className="text-lg font-semibold text-gray-300 mb-2">
              Failed to load tokens
            </h3>
            <p className="text-gray-400 mb-4">{fetchError}</p>
            <div className="flex justify-center gap-3">
              <button
                onClick={() => void fetchTokens(true)}
                className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors"
              >
                Refresh Tokens
              </button>
              {!isRhChain ? (
                <button
                  type="button"
                  onClick={() => setShowRpcPanel(true)}
                  className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors"
                >
                  Check RPC
                </button>
              ) : null}
            </div>
          </div>
        ) : isRhChain && filteredUserTokens.length === 0 ? (
          <div className="text-center py-12">
            <h3 className="text-lg font-semibold text-gray-300 mb-2">
              No ERC-20 holdings found
            </h3>
            <p className="text-gray-400 mb-4">
              {tradeFromAddress
                ? "Blockscout / GMGN returned no tokens for this wallet."
                : "Connect Parent (Rabby) or Bound wallet."}
            </p>
            <button
              onClick={() => void fetchTokens(true)}
              disabled={!tradeFromAddress}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors disabled:opacity-50"
            >
              Refresh holdings
            </button>
          </div>
        ) : !isRhChain &&
          allTokensCount === 0 &&
          allBalancedTokens.length === 0 &&
          zeroBalanceTokens.length === 0 ? (
          <div className="text-center py-12">
            <h3 className="text-lg font-semibold text-gray-300 mb-2">
              RPC returned no token accounts
            </h3>
            <p className="text-gray-400 mb-4">
              Try another RPC endpoint or run diagnostics below.
            </p>
            <button
              onClick={() => {
                setShowRpcPanel(true);
                void handleTestAllRpcs();
              }}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors"
            >
              Test RPCs
            </button>
          </div>
        ) : !isRhChain &&
          allBalancedTokens.length === 0 &&
          emptyAccountTokens.length > 0 &&
          !showZeroBalance ? (
          <div className="text-center py-12">
            <h3 className="text-lg font-semibold text-gray-300 mb-2">
              No sellable tokens
            </h3>
            <p className="text-gray-400 mb-4">
              {emptyAccountTokens.length} close-only account
              {emptyAccountTokens.length === 1 ? "" : "s"} below.
            </p>
            <button
              onClick={() => setShowZeroBalance(true)}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors"
            >
              Show zero balance tokens
            </button>
          </div>
        ) : !isRhChain &&
          allBalancedTokens.length === 0 &&
          emptyAccountTokens.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center">
              <svg
                className="w-8 h-8 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-300 mb-2">
              No tokens found
            </h3>
            <p className="text-gray-400 mb-4">
              You don&apos;t have any tokens to sell
            </p>
            <button
              onClick={() => void fetchTokens(true)}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors"
            >
              Refresh Tokens
            </button>
          </div>
        ) : filteredUserTokens.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 bg-gray-700 rounded-full flex items-center justify-center">
              <svg
                className="w-8 h-8 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-gray-300 mb-2">
              No dust tokens found
            </h3>
            <p className="text-gray-400 mb-4">
              You don&apos;t have any tokens worth less than $1
            </p>
            <button
              onClick={toggleDustFilter}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors"
            >
              Show All Tokens
            </button>
          </div>
        ) : (
          <>
            {filteredUserTokens.filter(
              (t) => !zeroBalanceMintSet.has(t.mintAddress),
            ).length > 0 ? (
            <HoldingsTokenList
              mode="select"
              tokens={filteredUserTokens.filter(
                (t) => !zeroBalanceMintSet.has(t.mintAddress),
              )}
              isSelected={(token) =>
                selectedTokens.some((t) =>
                  isRhChain
                    ? walletsMatch(t.mintAddress, token.mintAddress)
                    : t.mintAddress === token.mintAddress,
                )
              }
              selectedToken={(token) =>
                selectedTokens.find((t) =>
                  isRhChain
                    ? walletsMatch(t.mintAddress, token.mintAddress)
                    : t.mintAddress === token.mintAddress,
                )
              }
              onToggle={toggleTokenSelection}
              onSelectChart={handleSelectToken}
              onRefreshPrice={refreshTokenPrice}
              onUpdateSellPercentage={updateTokenSellPercentage}
              onUpdateSellAmount={updateTokenSellAmount}
            />
            ) : null}
            {filteredUserTokens.some((t) =>
              zeroBalanceMintSet.has(t.mintAddress),
            ) ? (
              <div className="mt-2 grid max-h-48 overflow-y-auto border border-gray-600 rounded-xl">
                {filteredUserTokens
                  .filter((t) => zeroBalanceMintSet.has(t.mintAddress))
                  .map((token) => {
                    const isSelected = selectedZeroBalanceTokens.some(
                      (t) => t.mintAddress === token.mintAddress,
                    );
                    return (
                      <div
                        key={token.mintAddress}
                        className={`group p-2 m-1 rounded-xl transition-all duration-200 ${
                          isSelected ? "bg-gray-700" : "bg-gray-900"
                        }`}
                      >
                        <div
                          className="flex items-center justify-between cursor-pointer"
                          onClick={() => toggleZeroBalanceTokenSelection(token)}
                        >
                          <div className="flex items-center space-x-3">
                            <div
                              className={`w-4 h-4 rounded border-2 flex items-center justify-center ${
                                isSelected
                                  ? "bg-blue-500 border-blue-500"
                                  : "border-gray-500"
                              }`}
                            >
                              {isSelected && (
                                <span className="text-white text-xs">✓</span>
                              )}
                            </div>
                            <span className="font-semibold text-gray-300">
                              {token.name || token.symbol || "Unknown"}
                            </span>
                            <span className="text-xs text-gray-500">
                              Close only
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            ) : null}
          </>
        )}

        {/* Zero-Balance Tokens Section — Sol only */}
        {isSolTrade &&
          !showDustOnly &&
          !showZeroBalance &&
          zeroBalanceTokens.length > 0 && (
          <>
            <div className="border-t border-gray-600 pt-8">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <div>
                  <h3 className="text-md font-semibold text-white mb-1">
                    Your useless tokens
                  </h3>
                  <p className="text-gray-400 text-sm">
                    Close accounts to recover rent •{" "}
                    {selectedZeroBalanceTokens.length} of{" "}
                    {zeroBalanceTokens.length} selected
                  </p>
                </div>
                <div className="flex items-center space-x-3">
                  <button
                    onClick={selectAllZeroBalanceTokens}
                    disabled={zeroBalanceTokens.length === 0}
                    className="px-4 py-2 bg-white hover:bg-gray-100 text-black rounded-lg transition-colors text-sm"
                  >
                    Select All
                  </button>
                  <button
                    onClick={clearZeroBalanceSelection}
                    disabled={selectedZeroBalanceTokens.length === 0}
                    className="px-4 py-2 bg-gray-600 hover:bg-gray-500 text-white rounded-lg transition-colors text-sm"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="grid max-h-96 overflow-y-auto border border-gray-600 rounded-xl">
                {zeroBalanceTokens.map((token) => {
                  const isSelected = selectedZeroBalanceTokens.some(
                    (t) => t.mintAddress === token.mintAddress,
                  );
                  return (
                    <div
                      key={token.mintAddress}
                      className={`group p-2 m-1 rounded-xl transition-all duration-200 ${
                        isSelected ? "bg-gray-700" : "bg-gray-900"
                      }`}
                    >
                      <div
                        className="flex items-center justify-between cursor-pointer"
                        onClick={() => toggleZeroBalanceTokenSelection(token)}
                      >
                        <div className="flex items-center space-x-3">
                          {/* Checkbox */}
                          <div className="flex items-center justify-center">
                            <div
                              className={`w-4 h-4 sm:w-4 sm:h-4 rounded border-2 flex items-center justify-center transition-colors ${
                                isSelected
                                  ? "bg-blue-500 border-blue-500"
                                  : "border-gray-500 hover:border-gray-400"
                              }`}
                            >
                              {isSelected && (
                                <svg
                                  className="w-3 h-3 text-white"
                                  viewBox="0 0 20 20"
                                  fill="currentColor"
                                >
                                  <path
                                    fillRule="evenodd"
                                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                    clipRule="evenodd"
                                  />
                                </svg>
                              )}
                            </div>
                          </div>

                          {/* Token Icon */}
                          <div
                            className={`w-4 h-4 sm:w-8 sm:h-8 rounded-full flex items-center justify-center text-white font-bold ${
                              isSelected ? "bg-white text-black" : "bg-gray-600"
                            }`}
                          >
                            <span>{token.symbol?.charAt(0) || "T"}</span>
                          </div>

                          {/* Token Name */}
                          <div className="font-semibold text-gray-300">
                            {token.name || token.symbol || "Unknown"}
                          </div>

                          {/* Chart Icon */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSelectToken(token.mintAddress);
                            }}
                            className="ml-2 p-1 bg-gray-600 rounded hover:bg-gray-500 transition-colors"
                            title="View Chart"
                          >
                            <svg
                              className="w-3 h-3 text-gray-300"
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
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Settings and Summary */}
        {(selectedTokens.length > 0 ||
          selectedZeroBalanceTokens.length > 0) && (
          <>
            {/* Collapsible Settings Section */}
            <div className="bg-gray-800 border border-gray-600 rounded-xl">
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="w-full p-4 flex items-center justify-between text-left hover:bg-gray-700 transition-colors rounded-xl"
              >
                <div>
                  <h3 className="text-sm font-semibold text-white mb-1">
                    Trading Settings & Quotes
                  </h3>
                </div>
                <svg
                  className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${
                    showSettings ? "rotate-180" : ""
                  }`}
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

              {showSettings && (
                <div className="px-4 pb-4 space-y-6">
                  {/* Settings Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Slippage */}
                    <div className="space-y-3">
                      <label
                        htmlFor="slippage"
                        className="block text-sm font-semibold text-gray-200 uppercase tracking-wide"
                      >
                        Slippage Tolerance
                      </label>
                      <select
                        id="slippage"
                        value={slippage}
                        onChange={(e) => setSlippage(Number(e.target.value))}
                        className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-xl text-white focus:bg-gray-600 focus:border-gray-400 transition-all duration-200"
                        disabled={isLoading}
                      >
                        {TRADE_SLIPPAGE_OPTIONS.map((option) => (
                          <option
                            key={option.value}
                            value={option.value}
                            className="bg-gray-700"
                          >
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-400">
                        Auto uses quote impact + 20 bps, capped at 1.5%. Impact above
                        that must be cut or set manually.
                      </p>
                      {useRhParentPath && getRhBatchExecutorAddress() ? (
                        <p className="text-xs text-gray-500">
                          {RH_PLATFORM_FEE_LABEL}
                        </p>
                      ) : null}
                    </div>

                    {/* Priority Fee — Sol Jupiter path only */}
                    {isSolTrade ? (
                      <div className="space-y-3">
                        <label
                          htmlFor="priorityFee"
                          className="block text-sm font-semibold text-gray-200 uppercase tracking-wide"
                        >
                          Priority Fee
                        </label>
                        <select
                          id="priorityFee"
                          value={priorityFee}
                          onChange={(e) =>
                            setPriorityFee(Number(e.target.value))
                          }
                          className="w-full px-4 py-3 bg-gray-700 border border-gray-600 rounded-xl text-white focus:bg-gray-600 focus:border-gray-400 transition-all duration-200"
                          disabled={isLoading}
                        >
                          {PRIORITY_FEE_OPTIONS.map((option) => (
                            <option
                              key={option.value}
                              value={option.value}
                              className="bg-gray-700"
                            >
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : null}

                    {/* Dev-only: confirmation transport toggle (Sol only) */}
                    {isSolTrade ? (
                      <ConfirmTransportSelect disabled={isLoading} />
                    ) : null}
                  </div>

                  {/* Quote Controls — Sol / Raptor only */}
                  {isSolTrade ? (
                  <div className="border-t border-gray-600 pt-4">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
                      <div>
                        <h4 className="text-md font-semibold text-white mb-1">
                          Raptor Quotes
                        </h4>
                        <p className="text-gray-400 text-sm">
                          {Object.keys(quotes).length} quote
                          {Object.keys(quotes).length !== 1 ? "s" : ""} loaded
                          {lastQuoteTime > 0 && (
                            <span className="ml-2">
                              • Last updated{" "}
                              {Math.floor((Date.now() - lastQuoteTime) / 1000)}s
                              ago
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center space-x-3">
                        {/* Auto-quote toggle */}
                        <label className="flex items-center space-x-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={autoQuote}
                            onChange={(e) => setAutoQuote(e.target.checked)}
                            className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 focus:ring-2"
                          />
                          <span className="text-sm text-gray-300">
                            Auto-quote (5s)
                          </span>
                        </label>

                        {/* Manual quote button */}
                        <button
                          onClick={fetchAllQuotes}
                          disabled={
                            isGettingQuotes || selectedTokens.length === 0
                          }
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm flex items-center space-x-2"
                        >
                          {isGettingQuotes ? (
                            <>
                              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                              <span>Getting Quotes...</span>
                            </>
                          ) : (
                            <>
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
                                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                />
                              </svg>
                              <span>Get Quotes</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Quote Summary */}
                    {Object.keys(quotes).length > 0 && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                        <div className="text-center p-3 bg-gray-700 rounded-lg">
                          <div className="font-medium text-white">
                            Total SOL Output
                          </div>
                          <div className="text-green-400 font-bold text-lg">
                            {selectedTokens
                              .reduce((total, token) => {
                                const quote = getQuoteForToken(
                                  token.mintAddress,
                                );
                                if (quote && isQuoteValid(quote)) {
                                  return (
                                    total + parseFloat(quote.outAmount) / 1e9
                                  ); // Convert lamports to SOL
                                }
                                return total;
                              }, 0)
                              .toFixed(6)}{" "}
                            SOL
                          </div>
                        </div>
                        <div className="text-center p-3 bg-gray-700 rounded-lg">
                          <div className="font-medium text-white">
                            Avg Price Impact
                          </div>
                          <div className="text-yellow-400 font-bold text-lg">
                            {selectedTokens.length > 0
                              ? (
                                  selectedTokens.reduce((total, token) => {
                                    const quote = getQuoteForToken(
                                      token.mintAddress,
                                    );
                                    if (quote && isQuoteValid(quote)) {
                                      return total + quote.priceImpact;
                                    }
                                    return total;
                                  }, 0) /
                                  selectedTokens.filter((token) => {
                                    const quote = getQuoteForToken(
                                      token.mintAddress,
                                    );
                                    return quote && isQuoteValid(quote);
                                  }).length
                                ).toFixed(2)
                              : "0.00"}
                            %
                          </div>
                        </div>
                        <div className="text-center p-3 bg-gray-700 rounded-lg">
                          <div className="font-medium text-white">
                            Valid Quotes
                          </div>
                          <div className="text-blue-400 font-bold text-lg">
                            {
                              selectedTokens.filter((token) => {
                                const quote = getQuoteForToken(
                                  token.mintAddress,
                                );
                                return quote && isQuoteValid(quote);
                              }).length
                            }
                            /{selectedTokens.length}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  ) : (
                    <p className="text-xs text-gray-500 border-t border-gray-600 pt-3">
                      Robinhood: Kyber (Parent) / GMGN (Bound) — no Solana Raptor
                      quotes.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col md:flex-row gap-4">
              {/* Sell — only when sellable tokens selected */}
              {selectedTokens.length > 0 && (
                <button
                  onClick={() => void handleBulkSell()}
                  disabled={
                    isLoading || (isRhChain && !tradeFromAddress)
                  }
                  className={`${
                    isRhChain || selectedZeroBalanceTokens.length === 0
                      ? "w-full"
                      : "md:w-3/4 w-full"
                  } py-4 px-6 rounded-xl font-semibold text-sm transition-all duration-200 ${
                    isLoading || (isRhChain && !tradeFromAddress)
                      ? "bg-gray-600 text-gray-400 cursor-not-allowed"
                      : "bg-white hover:bg-gray-100 text-black shadow-lg hover:shadow-xl"
                  }`}
                >
                  {isLoading ? (
                    <div className="flex items-center justify-center space-x-3">
                      <div className="w-5 h-5 border-2 border-gray-400 border-t-black rounded-full animate-spin"></div>
                      <span>Processing...</span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center space-x-2">
                      <span>
                        {(() => {
                          if (isRhChain) {
                            const usd = selectedTokens.reduce(
                              (s, t) =>
                                s + (t.usdValue * (t.sellPercentage || 100)) / 100,
                              0,
                            );
                            const n = selectedTokens.length;
                            const label =
                              n === 1
                                ? selectedTokens[0].symbol || "token"
                                : `${n} tokens`;
                            const via = useRhParentPath
                              ? `Kyber → ${rhQuoteCurrency}`
                              : `GMGN → ${rhQuoteCurrency}`;
                            return usd > 0
                              ? `Sell ${label} (~$${usd.toLocaleString(undefined, { maximumFractionDigits: 2 })}) ${via}`
                              : `Sell ${label} ${via}`;
                          }
                          const totalSolOutput = selectedTokens.reduce(
                            (total, token) => {
                              const quote = getQuoteForToken(
                                token.mintAddress,
                              );
                              if (quote && isQuoteValid(quote)) {
                                return (
                                  total + parseFloat(quote.outAmount) / 1e9
                                );
                              }
                              return total;
                            },
                            0,
                          );

                          // Close only runs for selected zero-balance accounts (not after 100% sells).
                          const willCloseZeroBalance =
                            selectedZeroBalanceTokens.length > 0;

                          const tokenText =
                            selectedTokens.length === 1
                              ? "token"
                              : `${selectedTokens.length} tokens`;

                          if (willCloseZeroBalance) {
                            return totalSolOutput > 0
                              ? `Sell & close dust for ${totalSolOutput.toFixed(4)} Sol`
                              : `Sell & close dust`;
                          }
                          if (selectedTokens.length === 1) {
                            const symbol =
                              selectedTokens[0].symbol || "token";
                            return totalSolOutput > 0
                              ? `Sell ${symbol} for ${totalSolOutput.toFixed(4)} Sol`
                              : `Sell ${symbol}`;
                          }
                          return totalSolOutput > 0
                            ? `Sell ${tokenText} for ${totalSolOutput.toFixed(4)} Sol`
                            : `Sell ${tokenText}`;
                        })()}
                      </span>
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
                          d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v2a2 2 0 002 2z"
                        />
                      </svg>
                    </div>
                  )}
                </button>
              )}

              {/* Direct close without sell — Sol ATA rent reclaim only */}
              {isSolTrade &&
                (selectedTokens.length > 0 ||
                  selectedZeroBalanceTokens.length > 0) && (
                <button
                  onClick={handleCloseOnly}
                  disabled={isLoading}
                  className={`${selectedTokens.length === 0 ? "w-full" : "md:w-1/4 w-full"} py-4 px-6 rounded-xl font-semibold text-sm transition-all duration-200 ${
                    isLoading
                      ? "bg-gray-600 text-gray-400 cursor-not-allowed"
                      : "bg-yellow-600 hover:bg-yellow-500 text-white shadow-lg hover:shadow-xl"
                  }`}
                  title="Close token accounts without selling — remaining balance is burned"
                >
                  {isLoading ? (
                    <div className="flex items-center justify-center space-x-3">
                      <div className="w-5 h-5 border-2 border-yellow-300 border-t-white rounded-full animate-spin"></div>
                      <span>Processing...</span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center space-x-2">
                      <span>
                        Directly Close{" "}
                        {selectedTokens.length +
                          selectedZeroBalanceTokens.length}{" "}
                        Token
                        {selectedTokens.length +
                          selectedZeroBalanceTokens.length !==
                        1
                          ? "s"
                          : ""}
                      </span>
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
                    </div>
                  )}
                </button>
              )}
            </div>
          </>
        )}

        {/* Error Display */}
        {error && (
          <div className="bg-gradient-to-r from-red-900/50 to-red-800/50 border border-red-500/50 text-red-200 px-4 py-3 rounded-xl backdrop-blur-sm animate-slide-up">
            <div className="flex items-start space-x-3">
              <svg
                className="w-5 h-5 mt-0.5 text-red-400"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
              <p className="text-sm">{error}</p>
            </div>
          </div>
        )}

        {/* Trade outcome modal */}
        <TradeOutcomeModal
          {...outcomeModalProps}
          onClose={() => {
            setPendingCloseableTokens([]);
            hideOutcome();
          }}
          onCloseAccounts={handlePostSellCloseAccounts}
          isClosingAccounts={isClosingAccounts}
        />

        {/* ✅ NEW: Add PnL Share Modal */}
        <PnLShareModal
          isOpen={isShareModalOpen}
          onClose={hideShareModal}
          shareData={shareData}
          onCopySuccess={() =>
            console.log("Tweet text copied from BulkTokenSeller!")
          }
        />
      </div>
    </div>
  );
}
