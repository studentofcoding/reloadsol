"use client";

import React, {
  useMemo,
  useState,
  useEffect,
  Suspense,
  useCallback,
  useRef,
} from "react";
import { useBoardInit } from "@/hooks/useBoardInit";
import TokenSearchLink from "@/components/signals/shared/TokenSearchLink";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { useWallet, useConnection } from "@/components/WalletProvider";
import {
  executeBulkBuy,
  getSwapQuote,
} from "@/utils/jupiter";
import { executeClientSwap } from "@/utils/swap-executor";
import { TOKENS } from "@/utils/solana";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { trackBuy } from "@/utils/operations-api";
import { useTradingData } from "@/components/TradingDataProvider";
import { getSolPriceUSD } from "@/utils/solana";
import { fetchTokenPricesForTracking } from "@/utils/trading-tracker";
import { trackSimBuy, trackSimClose } from "@/utils/trade-tracking";
import { buildEntryMcapFeatures } from "@/strategies/outcome-features";
import { useSignalsStrategy } from "@/hooks/useSignalsStrategy";
import TradeOutcomeModal, { useTradeOutcome } from "@/components/TradeOutcomeModal";
import { BulkBuyRequest } from "@/types";
import {
  DndContext,
  DragEndEvent,
  useDraggable,
  useDroppable,
  DragOverlay,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ChartCaptureModal } from "@/components/ChartCaptureModal";
import { useChartCapture } from "@/hooks/useChartCapture";
import { calculateWeightedDistribution } from "@/utils/position-sizing";
import { useMCapTracker, FilterOptions } from "@/hooks/useMCapTracker";
import GmgnChartEmbed from "@/components/signals/shared/GmgnChartEmbed";
import DlmmChartActions from "@/components/dlmm/DlmmChartActions";
import GlobalWatchlistButton from "@/components/GlobalWatchlistButton";
import { useRugList } from "@/hooks/useRugList";
import { parseAddresses } from "@/components/signals/shared/parseAddresses";

type SectionType = "watching" | "potential" | "rugged" | "mcap_tracker";

interface SignalData {
  token_address: string;
  label: string;
  market_cap: number;
  price: number;
  initial_price: number;
  token_symbol?: string;
  result?: any;
  image_reference?: string;
  source?: string;
}

const SECTIONS: { id: SectionType; title: string; color: string }[] = [
  { id: "mcap_tracker", title: "Discovery (MCap)", color: "border-purple-600" },
  { id: "watching", title: "Unlabeled / Watching", color: "border-gray-600" },
  { id: "potential", title: "Potential", color: "border-green-600" },
  { id: "rugged", title: "Rugged", color: "border-red-600" },
];

const DEFAULT_MCAP_FILTERS: FilterOptions = {
  search: "",
  sortBy: "first_seen_at",
  sortOrder: "desc",
  minGrowth: "",
  maxGrowth: "",
  minMcap: "1000",
  maxMcap: "100000",
  excludeZeroPnl: false,
  timeFilter: "24h",
  performanceFilter: "all",
};

// --- Types & Constants ---

function DraggableCard({
  id,
  children,
  onRemove,
}: {
  id: string;
  children: React.ReactNode;
  onRemove?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id,
    });

  const style = {
    transform: CSS.Translate.toString(transform),
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      id={`card-${id}`}
      style={style}
      className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700 relative mb-3 shadow-lg"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 bg-gray-850">
        <div className="flex items-center gap-2 overflow-hidden w-[90%]">
          {/* Drag Handle */}
          <div
            {...listeners}
            {...attributes}
            className="cursor-move p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
            title="Drag to move"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="9" cy="12" r="1" />
              <circle cx="9" cy="5" r="1" />
              <circle cx="9" cy="19" r="1" />
              <circle cx="15" cy="12" r="1" />
              <circle cx="15" cy="5" r="1" />
              <circle cx="15" cy="19" r="1" />
            </svg>
          </div>
          {children}
        </div>
        {onRemove && (
          <button
            onClick={onRemove}
            className="text-gray-500 hover:text-red-500 ml-2 w-[10%]"
            title="Remove from view"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// --- Droppable Column Component ---

function DroppableColumn({
  id,
  title,
  color,
  items,
  renderItem,
  onBuyAll,
  buyAmount,
  setBuyAmount,
  isBuying,
}: {
  id: SectionType;
  title: string;
  color: string;
  items: string[];
  renderItem: (id: string) => React.ReactNode;
  onBuyAll?: () => void;
  buyAmount?: string;
  setBuyAmount?: (val: string) => void;
  isBuying?: boolean;
}) {
  const { setNodeRef } = useDroppable({ id });

  return (
    <div className="flex-1 min-w-[350px] flex flex-col h-full">
      <h2
        className={`text-lg font-bold mb-3 px-2 border-l-4 ${color} flex justify-between items-center`}
      >
        {title}
        <span className="text-xs font-normal text-gray-400 bg-gray-800 px-2 py-1 rounded-full">
          {items.length}
        </span>
      </h2>
      {onBuyAll && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-green-800 bg-green-900/20 p-2">
          <input
            type="number"
            step="0.1"
            min="0.01"
            className="w-20 rounded border border-gray-600 bg-gray-900 px-2 py-1 text-sm text-white"
            value={buyAmount ?? "1.0"}
            onChange={(e) => setBuyAmount?.(e.target.value)}
            disabled={isBuying}
          />
          <span className="text-xs text-gray-400">SOL</span>
          <button
            type="button"
            onClick={onBuyAll}
            disabled={isBuying || items.length === 0}
            className="ml-auto rounded bg-green-600 px-3 py-1 text-xs font-medium hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isBuying ? "Buying…" : "Buy All (Weighted)"}
          </button>
        </div>
      )}
      <div
        ref={setNodeRef}
        className="flex-1 bg-gray-900/50 rounded-xl p-2 border border-gray-800 overflow-y-auto min-h-[200px]"
      >
        {items.length === 0 ? (
          <div className="h-24 flex items-center justify-center text-gray-600 text-sm border-2 border-dashed border-gray-800 rounded-lg">
            Drop here
          </div>
        ) : (
          items.map((item) => <div key={item}>{renderItem(item)}</div>)
        )}
      </div>
    </div>
  );
}

// --- Chart Item Component (Memoized) ---

const ChartItem = React.memo(
  ({
    addr,
    symbol,
    initialPrice,
    logoUrl,
    interval,
    isDraggingGlobal,
    buyState,
    onBuy,
    onSell,
    onSimulate,
    onSimulateSell,
    onEnd,
    onRemove,
    onMove,
    showMoveButtons,
    isMcapSource,
  }: any) => {
    return (
      <DraggableCard
        id={addr}
        onRemove={onRemove ? () => onRemove(addr) : undefined}
      >
        <div className="flex-1">
          <div className="flex items-center justify-between text-sm font-medium text-white mb-1">
            <div className="flex items-center gap-2">
              {symbol || addr.slice(0, 8) + "..."}
              <TokenSearchLink address={addr} />
              {isMcapSource && (
                <span className="text-[10px] bg-purple-900/50 text-purple-300 px-1 rounded border border-purple-700">
                  MCAP
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <GlobalWatchlistButton
                tokenAddress={addr}
                tokenSymbol={symbol}
                initialPrice={initialPrice}
                logoUrl={logoUrl}
              />
              <a
                href={`/chart/${addr}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-400 hover:underline"
              >
                Open
              </a>
            </div>
          </div>

          <div className="relative h-[200px] w-full bg-black">
            <GmgnChartEmbed
              tokenAddress={addr}
              interval={interval}
              className={`w-full h-full ${isDraggingGlobal ? "pointer-events-none" : ""}`}
              height="200px"
            />
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              className={`px-2 py-1 text-xs rounded text-white font-medium ${
                buyState?.loading
                  ? "bg-yellow-600 cursor-wait"
                  : buyState?.status === "Success!"
                    ? "bg-green-600"
                    : buyState?.error
                      ? "bg-red-600"
                      : "bg-blue-600 hover:bg-blue-500"
              }`}
              onClick={() => onBuy(addr)}
              disabled={buyState?.loading}
              title={buyState?.error || "Instant Buy"}
            >
              {buyState?.loading
                ? "Buying..."
                : buyState?.status || (buyState?.error ? "Failed" : `Buy`)}
            </button>
            <button
              className="px-2 py-1 text-xs rounded text-white font-medium bg-red-600 hover:bg-red-500"
              onClick={() => onSell(addr)}
              title="Sell All (Instant)"
            >
              Sell
            </button>
            <button
              className="px-2 py-1 text-xs rounded text-white font-medium bg-indigo-600 hover:bg-indigo-500"
              onClick={() => onSimulate(addr)}
              title="Simulate Buy"
            >
              Sim Buy
            </button>
            <button
              className="px-2 py-1 text-xs rounded text-white font-medium bg-orange-600 hover:bg-orange-500"
              onClick={() => onSimulateSell(addr)}
              title="Simulate Sell"
            >
              Sim Sell
            </button>
          </div>

          <div className="mt-2 flex justify-end">
            <DlmmChartActions
              tokenAddress={addr}
              tokenSymbol={symbol}
              source="board"
            />
          </div>

          <div className="mt-2">
            <button
              className="w-full px-2 py-1 text-xs rounded text-white font-medium bg-purple-600 hover:bg-purple-500"
              onClick={() => onEnd(addr)}
              title="End Tracking (Save Result)"
            >
              End Tracking
            </button>
          </div>

          {showMoveButtons && (
            <div className="mt-2 flex gap-2 pt-2 border-t border-gray-700">
              <button
                className="flex-1 px-2 py-1 text-xs rounded text-white font-medium bg-green-700 hover:bg-green-600 border border-green-600"
                onClick={() => onMove(addr, "potential")}
              >
                Potential
              </button>
              <button
                className="flex-1 px-2 py-1 text-xs rounded text-white font-medium bg-red-900/50 hover:bg-red-900 border border-red-800 text-red-200"
                onClick={() => onMove(addr, "rugged")}
              >
                Rugged
              </button>
            </div>
          )}
        </div>
      </DraggableCard>
    );
  },
);
ChartItem.displayName = "ChartItem";

// --- Main Content Component ---

function ChartsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { network } = useAppNetwork();
  const { addressSet: rugAddressSet } = useRugList();
  const urlAddresses = useMemo(
    () => parseAddresses(searchParams.get("addresses")),
    [searchParams],
  );
  const interval = searchParams.get("interval") || "5";

  // State
  const [columns, setColumns] = useState<Record<SectionType, string[]>>({
    mcap_tracker: [],
    watching: [],
    potential: [],
    rugged: [],
  });
  const [mcapFilters, setMcapFilters] =
    useState<FilterOptions>(DEFAULT_MCAP_FILTERS);

  // Fetch Mcap Data
  const { data: mcapData } = useMCapTracker({
    filters: mcapFilters,
    page: 1,
    limit: 50, // Fetch top 50
  });

  const [symbols, setSymbols] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string>("");
  const [newAddr, setNewAddr] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [isDraggingGlobal, setIsDraggingGlobal] = useState(false);
  const [tokenMcaps, setTokenMcaps] = useState<Record<string, number>>({});
  const [signals, setSignals] = useState<Record<string, SignalData>>({});

  // Instant Buy State
  const { publicKey, signAllTransactions, connected } = useWallet();
  const { connection } = useConnection();
  const { trackOperation, records } = useTradingData();
  const { showOutcome, outcomeModalProps } = useTradeOutcome();
  const { strategyId, template, setTemplate } = useSignalsStrategy();
  const [buyAmount, setBuyAmount] = useState("0.1");
  const [buyStates, setBuyStates] = useState<
    Record<string, { loading: boolean; status?: string; error?: string }>
  >({});

  // State for Potential Bulk Buy
  const [potentialSolAmount, setPotentialSolAmount] = useState<string>("1.0");
  const [isBuyingPotential, setIsBuyingPotential] = useState(false);

  // Use Chart Capture Hook
  const {
    isOpen: captureOpen,
    data: captureData,
    status: captureStatus,
    startCapture,
    retakeCapture,
    saveResult,
    close: closeCapture,
  } = useChartCapture();

  const displayStatus = captureStatus || status;

  const { data: boardInitData, error: boardInitError } = useBoardInit(urlAddresses);
  const initLoadedRef = useRef(false);

  if (boardInitData && !initLoadedRef.current) {
    initLoadedRef.current = true;
    setColumns(boardInitData.columns);
    setTokenMcaps(boardInitData.tokenMcaps);
    setSignals(boardInitData.signals as Record<string, SignalData>);
    setIsLoaded(true);
  }

  const initErrorMessage = boardInitError ? "Failed to load saved tokens" : "";
  const effectiveStatus = displayStatus || initErrorMessage;

  const mergedSignals = useMemo(() => {
    if (!mcapData?.data) return signals;

    const next = { ...signals };
    mcapData.data.forEach((t) => {
      if (
        !next[t.token_address] ||
        next[t.token_address].source === "mcap_tracker"
      ) {
        next[t.token_address] = {
          ...next[t.token_address],
          token_address: t.token_address,
          label: next[t.token_address]?.label || "mcap_tracker",
          market_cap: t.current_mcap,
          price: t.solPerToken.current,
          initial_price:
            next[t.token_address]?.initial_price || t.solPerToken.first,
          token_symbol: t.token_symbol,
          source: next[t.token_address]?.source || "mcap_tracker",
        };
      }
    });
    return next;
  }, [signals, mcapData]);

  const displayColumns = useMemo(() => {
    if (!mcapData?.data) return columns;

    const existingSet = new Set([
      ...columns.watching,
      ...columns.potential,
      ...columns.rugged,
    ]);

    const newMcapIds = mcapData.data
      .filter((t) => !existingSet.has(t.token_address))
      .map((t) => t.token_address);

    const current = columns.mcap_tracker || [];
    if (
      current.length === newMcapIds.length &&
      current.every((id, i) => id === newMcapIds[i])
    ) {
      return columns;
    }

    return {
      ...columns,
      mcap_tracker: newMcapIds,
    };
  }, [columns, mcapData]);

  const handleBuyPotential = async () => {
    const potentialTokens = displayColumns.potential;
    if (potentialTokens.length === 0) {
      alert("No tokens in Potential category");
      return;
    }

    if (!connected || !publicKey || !signAllTransactions) {
      alert("Please connect wallet first");
      return;
    }

    const totalSol = parseFloat(potentialSolAmount);
    if (isNaN(totalSol) || totalSol <= 0) {
      alert("Invalid SOL amount");
      return;
    }

    if (!connection) {
      alert("RPC connection not ready");
      return;
    }

    setIsBuyingPotential(true);
    setStatus("Calculating weighted distribution...");

    try {
      // 1. Refresh MCaps for potential tokens to ensure accuracy
      // Use live data if available in signals map (populated by mcap_tracker or fetched DB data)
      const weightingInput = potentialTokens.map((addr) => ({
        address: addr,
        marketCap: signals[addr]?.market_cap || tokenMcaps[addr] || 0,
      }));

      const distribution = calculateWeightedDistribution(
        totalSol,
        weightingInput,
      );

      console.log("Distribution:", distribution);

      // 2. Execute Bulk Buy
      // We need to construct the bulk buy request.
      // executeBulkBuy takes one amount for ALL tokens usually?
      // Wait, executeBulkBuy in utils/jupiter takes `BulkBuyRequest` which has `solAmount` and `tokenMints`.
      // It splits `solAmount` equally or buys same amount?
      // Let's check `executeBulkBuy` implementation.
      // If it doesn't support varying amounts, we have to loop.

      // Checking executeBulkBuy signature:
      // interface BulkBuyRequest { solAmount: number; tokenMints: string[]; ... }
      // Usually this means "Buy X SOL of each" or "Split X SOL among them"?
      // Let's check `src/utils/jupiter.ts`.

      // If we can't do varying amounts in one go, we iterate.

      let successCount = 0;
      let failCount = 0;

      for (const item of distribution) {
        if (item.solAmount < 0.001) continue; // Skip dust

        setStatus(
          `Buying ${symbols[item.address] || item.address}... (${item.solAmount} SOL)`,
        );

        try {
          const request: BulkBuyRequest = {
            solAmount: item.solAmount,
            tokenMints: [item.address],
            slippage: 200, // 2%
            priorityFee: 30000,
          };

          const result = await executeBulkBuy(
            request,
            publicKey.toString(),
            connection,
            signAllTransactions,
          );

          if (result.success) {
            successCount++;
            trackBuy(publicKey.toString(), 1, {
              failureCount: 0,
              solAmount: item.solAmount,
              tokenMints: [item.address],
              signatures: result.signatures,
            });

            try {
              await trackOperation({
                walletAddress: publicKey.toString(),
                operationType: "buy",
                tokens: [
                  {
                    mintAddress: item.address,
                    symbol: symbols[item.address],
                    solAmount: item.solAmount,
                  },
                ],
                successCount: 1,
                failureCount: 0,
                totalTokens: 1,
                solAmount: item.solAmount,
                feesPaid: 0,
                signatures: result.signatures,
              });
            } catch (trackErr) {
              console.error(`Failed to track buy for ${item.address}`, trackErr);
            }
          } else {
            failCount++;
            console.error(
              `Failed to buy ${item.address}:`,
              result.failedPurchases,
            );
          }
        } catch (e) {
          console.error(`Error buying ${item.address}`, e);
          failCount++;
        }
      }

      setStatus(
        `Bulk buy complete. Success: ${successCount}, Failed: ${failCount}`,
      );
      if (successCount > 0) {
        alert(`Successfully bought ${successCount} potential tokens!`);
      }
    } catch (e: any) {
      console.error("Bulk buy error", e);
      setStatus(`Bulk buy failed: ${e.message}`);
    } finally {
      setIsBuyingPotential(false);
    }
  };

  // 2. Fetch Symbols
  useEffect(() => {
    const allMints = Object.values(columns).flat();
    if (allMints.length === 0) return;

    // Simple dedup and fetch
    const uniqueMints = Array.from(new Set(allMints));
    // Filter out ones we already have
    const toFetch = uniqueMints.filter((m) => !symbols[m]);

    if (toFetch.length === 0) return;

    fetch("/api/jupiter/metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mints: toFetch }),
    })
      .then((res) => res.json())
      .then((json) => {
        const results = json?.results || {};
        setSymbols((prev) => {
          const next = { ...prev };
          Object.entries(results).forEach(([mint, result]: [string, any]) => {
            if (result?.data?.symbol) {
              next[mint] = result.data.symbol;
            }
          });
          return next;
        });
      })
      .catch(console.error);
  }, [columns, symbols]);

  // Move token helper
  const moveToken = useCallback(
    async (tokenAddress: string, targetSection: SectionType) => {
    // Find source column
    let sourceSection: SectionType | undefined;
    for (const [key, items] of Object.entries(columns)) {
      if (items.includes(tokenAddress)) {
        sourceSection = key as SectionType;
        break;
      }
    }

    if (!sourceSection || sourceSection === targetSection) return;

    // Optimistic Update
    setColumns((prev) => {
      const next = { ...prev };
      next[sourceSection!] = prev[sourceSection!].filter(
        (id) => id !== tokenAddress,
      );
      next[targetSection] = [...prev[targetSection], tokenAddress];
      return next;
    });

    // API Update
    try {
      if (targetSection === "mcap_tracker") {
        // Untrack (Delete from DB)
        const qs = new URLSearchParams({ tokenAddress, chain: network });
        await fetch(`/api/signals?${qs}`, { method: "DELETE" });
      } else {
        const signal = signals[tokenAddress];
        await fetch("/api/signals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenAddress,
            label: targetSection,
            chain: network,
            // If it came from mcap_tracker, set source. If existing, preserve source.
            source:
              sourceSection === "mcap_tracker"
                ? "mcap_tracker"
                : signal?.source || "manual",
            tokenSymbol: signal?.token_symbol,
            mcap: signal?.market_cap,
            price: signal?.price,
            initialPrice: signal?.initial_price,
          }),
        });
      }
    } catch (e) {
      console.error("Failed to save move", e);
      setStatus("Failed to save change to server");
    }
  },
    [columns, signals, network],
  );

  // Handle Drag End
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as SectionType; // The column ID

    moveToken(activeId, overId);
  };

  const handleSimulateBuy = useCallback(
    async (tokenAddress: string) => {
    if (!publicKey) {
      alert("Connect wallet to track simulation (wallet used as ID)");
      return;
    }

    const amountSol = parseFloat(buyAmount);
    if (isNaN(amountSol) || amountSol <= 0) return;

    setStatus(`Simulating buy of ${amountSol} SOL...`);

    try {
      const solPrice = await getSolPriceUSD();
      const prices = await fetchTokenPricesForTracking([tokenAddress]);
      const tokenPrice = prices[tokenAddress] || 0;

      if (tokenPrice === 0) {
        setStatus("Failed to get token price for simulation");
        return;
      }

      // Calculate token amount
      const usdValue = amountSol * solPrice;
      const tokenAmount = usdValue / tokenPrice;

      const signal = signals[tokenAddress];

      await trackSimBuy(trackOperation, {
        walletAddress: publicKey.toString(),
        mintAddress: tokenAddress,
        symbol: signal?.token_symbol || "Unknown",
        name: "Manual Simulation",
        solAmount: amountSol,
        tokenAmount,
        priceUsd: tokenPrice,
        botStrategy: strategyId,
        simulationType: "manual",
        entryFeatures: {
          token_symbol: signal?.token_symbol,
          board_label: signal?.label,
          ...buildEntryMcapFeatures(signal?.market_cap),
          close_source: "manual_ui",
          ui_tab: "board",
        },
      });

      showOutcome({
        success: true,
        operation: "buy",
        isSimulation: true,
        tokenSymbol: signal?.token_symbol || "Unknown",
        mintAddress: tokenAddress,
        solAmount: amountSol,
      });
      setStatus("");
    } catch (e) {
      console.error("Simulation failed", e);
      showOutcome({
        success: false,
        operation: "buy",
        isSimulation: true,
        mintAddress: tokenAddress,
        tokenSymbol: signals[tokenAddress]?.token_symbol,
        error: e instanceof Error ? e.message : "Simulation failed",
      });
      setStatus("");
    }
  },
    [publicKey, buyAmount, signals, trackOperation, showOutcome, strategyId],
  );

  const handleSimulateSell = useCallback(
    async (tokenAddress: string) => {
    if (!publicKey) {
      alert("Connect wallet to track simulation");
      return;
    }

    setStatus(`Simulating sell for ${tokenAddress.slice(0, 8)}...`);

    try {
      const signal = signals[tokenAddress];

      const { solReceived } = await trackSimClose({
        walletAddress: publicKey.toString(),
        mintAddress: tokenAddress,
        records,
        trackOperation,
        symbol: signal?.token_symbol || "Unknown",
        name: "Manual Simulation",
      });

      showOutcome({
        success: true,
        operation: "sell",
        isSimulation: true,
        tokenSymbol: signal?.token_symbol || "Unknown",
        mintAddress: tokenAddress,
        solAmount: solReceived,
      });
      setStatus("");
    } catch (e) {
      console.error("Simulation sell failed", e);
      showOutcome({
        success: false,
        operation: "sell",
        isSimulation: true,
        mintAddress: tokenAddress,
        tokenSymbol: signals[tokenAddress]?.token_symbol,
        error: e instanceof Error ? e.message : "Simulation sell failed",
      });
      setStatus("");
    }
  },
    [publicKey, signals, records, trackOperation, showOutcome],
  );

  const handleInstantSell = useCallback(
    async (tokenAddress: string) => {
    if (!connected || !publicKey || !signAllTransactions) {
      alert("Please connect wallet first");
      return;
    }

    if (!connection) {
      setStatus("RPC connection not ready");
      return;
    }

    setStatus(`Selling ${tokenAddress.slice(0, 8)}...`);

    try {
      // 1. Fetch Token Balance
      const accounts = await connection.getParsedTokenAccountsByOwner(
        publicKey,
        {
          mint: new PublicKey(tokenAddress),
        },
      );

      const tokenAccount = accounts.value[0];
      if (!tokenAccount) {
        setStatus("No token balance found");
        return;
      }

      const balance =
        tokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
      const balanceRaw =
        tokenAccount.account.data.parsed.info.tokenAmount.amount;
      const decimals =
        tokenAccount.account.data.parsed.info.tokenAmount.decimals;

      if (!balance || balance <= 0) {
        setStatus("Balance is 0");
        return;
      }

      console.log(`Selling ${balance} tokens (${balanceRaw} raw)`);

      // 2. Get Swap Quote (Token -> SOL)
      const quote = await getSwapQuote(
        tokenAddress,
        TOKENS.SOL,
        parseInt(balanceRaw), // Input amount in smallest unit (lamports/raw)
        200, // 2% slippage
      );

      if (!quote) {
        throw new Error("Failed to get swap quote");
      }

      const swapResult = await executeClientSwap({
        userPublicKey: publicKey.toString(),
        inputMint: quote.inputMint,
        outputMint: quote.outputMint,
        amount: quote.inAmount,
        slippageBps: quote.slippageBps ?? 200,
        priorityFeeLamports: 30000,
        connection,
        signTransaction: async (tx) => {
          const [signed] = await signAllTransactions!([tx]);
          return signed;
        },
      });
      const signature = swapResult.signature;

      // 5. Track Operation
      const solReceived = quote.outAmount
        ? parseInt(quote.outAmount) / LAMPORTS_PER_SOL
        : 0;
      const currentSolPrice = await getSolPriceUSD();

      await trackOperation({
        walletAddress: publicKey.toString(),
        operationType: "sell",
        tokens: [
          {
            mintAddress: tokenAddress,
            symbol: symbols[tokenAddress] || "Unknown",
            tokenAmount: balance,
            solAmount: solReceived,
            solPrice: currentSolPrice,
          },
        ],
        successCount: 1,
        failureCount: 0,
        totalTokens: 1,
        solAmount: solReceived,
        feesPaid: 0.000005, // Estimate
        solPriceUsd: currentSolPrice,
        totalUsdValue: solReceived * currentSolPrice,
        signatures: [signature],
      });

      showOutcome({
        success: true,
        operation: "sell",
        isSimulation: false,
        tokenSymbol: symbols[tokenAddress] || "Unknown",
        mintAddress: tokenAddress,
        solAmount: solReceived,
      });
      setStatus("");
    } catch (e) {
      console.error("Sell failed", e);
      showOutcome({
        success: false,
        operation: "sell",
        isSimulation: false,
        mintAddress: tokenAddress,
        tokenSymbol: symbols[tokenAddress],
        error: e instanceof Error ? e.message : String(e),
      });
      setStatus("");
    }
  },
    [
      connected,
      publicKey,
      signAllTransactions,
      connection,
      symbols,
      trackOperation,
      showOutcome,
    ],
  );

  const handleInstantBuy = useCallback(
    async (tokenAddress: string) => {
      if (!connected || !publicKey || !signAllTransactions) {
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: "Wallet not connected" },
        }));
        return;
      }

      if (!buyAmount || parseFloat(buyAmount) <= 0) {
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: "Invalid amount" },
        }));
        return;
      }

      if (!connection) {
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: "RPC connection not ready" },
        }));
        return;
      }

      setBuyStates((prev) => ({
        ...prev,
        [tokenAddress]: { loading: true, status: "Preparing..." },
      }));

      try {
        const balanceBeforeOp = await connection.getBalance(publicKey);
        const balanceBeforeSOL = balanceBeforeOp / LAMPORTS_PER_SOL;
        const priorityFee = 30000;
        const requiredAmount =
          parseFloat(buyAmount) + priorityFee / LAMPORTS_PER_SOL;

        if (balanceBeforeSOL < requiredAmount) {
          throw new Error(
            `Insufficient balance. Need ${requiredAmount.toFixed(4)} SOL`,
          );
        }

        const request: BulkBuyRequest = {
          solAmount: parseFloat(buyAmount),
          tokenMints: [tokenAddress],
          slippage: 200,
          priorityFee,
        };

        const buyResult = await executeBulkBuy(
          request,
          publicKey.toString(),
          connection,
          signAllTransactions,
        );

        if (buyResult.success) {
          showOutcome({
            success: true,
            operation: "buy",
            isSimulation: false,
            tokenSymbol: symbols[tokenAddress] || "Token",
            mintAddress: tokenAddress,
            solAmount: parseFloat(buyAmount),
          });

          setBuyStates((prev) => ({
            ...prev,
            [tokenAddress]: { loading: false, status: "Success!" },
          }));
          setTimeout(() => {
            setBuyStates((prev) => {
              const next = { ...prev };
              delete next[tokenAddress];
              return next;
            });
          }, 3000);

          trackBuy(publicKey.toString(), buyResult.successfulPurchases.length, {
            failureCount: buyResult.failedPurchases.length,
            solAmount: parseFloat(buyAmount),
            tokenMints: [tokenAddress],
            signatures: buyResult.signatures,
          }).catch(console.error);

          // Track via centralized React Query system
          const [tokenPrices, currentSolPrice] = await Promise.all([
            fetchTokenPricesForTracking([tokenAddress]),
            getSolPriceUSD(),
          ]);

          await trackOperation({
            walletAddress: publicKey.toString(),
            operationType: "buy",
            tokens: [
              {
                mintAddress: tokenAddress,
                symbol: symbols[tokenAddress] || "UNKNOWN",
                name: symbols[tokenAddress] || "Unknown Token",
                priceUsd: tokenPrices[tokenAddress] || 0,
                tokenAmount: 0,
                solAmount: parseFloat(buyAmount),
                solPrice: currentSolPrice,
              },
            ],
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
            slippage: 0.02,
            priorityFee,
            errors:
              buyResult.failedPurchases.length > 0
                ? buyResult.failedPurchases.map((f) => f.error)
                : undefined,
          });
        } else {
          throw new Error(
            buyResult.failedPurchases[0]?.error || "Transaction failed",
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed";
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: {
            loading: false,
            error: message,
          },
        }));
        showOutcome({
          success: false,
          operation: "buy",
          isSimulation: false,
          mintAddress: tokenAddress,
          tokenSymbol: symbols[tokenAddress],
          error: message,
        });
      }
    },
    [
      connected,
      publicKey,
      signAllTransactions,
      connection,
      buyAmount,
      trackOperation,
      symbols,
      showOutcome,
    ],
  );

  const handleEndTracking = useCallback(
    async (tokenAddress: string) => {
      const signal = signals[tokenAddress];
      await startCapture(tokenAddress, {
        initial_price: signal?.initial_price,
        label: signal?.label,
        source: signal?.source,
        token_symbol: signal?.token_symbol,
        market_cap: signal?.market_cap,
        price: signal?.price,
      });
    },
    [signals, startCapture],
  );

  const handleRemove = async (tokenAddress: string) => {
    // Optimistic remove
    let foundSection: SectionType | undefined;
    setColumns((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        const k = key as SectionType;
        if (next[k].includes(tokenAddress)) {
          foundSection = k;
          next[k] = next[k].filter((id) => id !== tokenAddress);
          break;
        }
      }
      return next;
    });

    // API Call to delete label (untrack)
    try {
      const qs = new URLSearchParams({ tokenAddress, chain: network });
      await fetch(`/api/signals?${qs}`, { method: "DELETE" });
    } catch (e) {
      console.error("Failed to delete", e);
    }
  };

  const handleAdd = async () => {
    if (!newAddr) return;
    const parsed = parseAddresses(newAddr);
    if (parsed.length === 0) return;

    // Add to 'watching' locally
    setColumns((prev) => ({
      ...prev,
      watching: [...prev.watching, ...parsed],
    }));
    setNewAddr("");

    // Auto-save to DB as 'watching'
    for (const addr of parsed) {
      try {
        await fetch("/api/signals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tokenAddress: addr,
            label: "watching",
            source: "manual",
            chain: network,
          }),
        });
      } catch (e) {
        console.error(e);
      }
    }
  };

  // Callbacks for ChartItem
  const onBuy = useCallback(
    (id: string) => handleInstantBuy(id),
    [handleInstantBuy],
  );
  const onSell = useCallback(
    (id: string) => handleInstantSell(id),
    [handleInstantSell],
  );
  const onSimulate = useCallback(
    (id: string) => handleSimulateBuy(id),
    [handleSimulateBuy],
  );
  const onSimulateSell = useCallback(
    (id: string) => handleSimulateSell(id),
    [handleSimulateSell],
  );
  const onEnd = useCallback(
    (id: string) => handleEndTracking(id),
    [handleEndTracking],
  );
  const onRemove = useCallback((id: string) => handleRemove(id), []);
  const onMove = useCallback(
    (id: string, target: SectionType) => moveToken(id, target),
    [moveToken],
  );

  const visibleColumnItems = useCallback(
    (sectionId: SectionType): string[] => {
      const items = columns[sectionId];
      if (sectionId === "rugged") {
        const merged = new Set(items);
        rugAddressSet.forEach((addr) => merged.add(addr));
        return Array.from(merged);
      }
      return items.filter((addr) => !rugAddressSet.has(addr));
    },
    [columns, rugAddressSet],
  );

  const renderCard = useCallback(
    (addr: string) => {
      const signal = signals[addr];
      const isMcapSource = signal?.source === "mcap_tracker";

      return (
        <ChartItem
          key={addr}
          addr={addr}
          symbol={symbols[addr] || signal?.token_symbol}
          initialPrice={signal?.price}
          interval={interval}
          isDraggingGlobal={isDraggingGlobal}
          buyState={buyStates[addr]}
          onBuy={onBuy}
          onSell={onSell}
          onSimulate={onSimulate}
          onSimulateSell={onSimulateSell}
          onEnd={onEnd}
          onRemove={onRemove}
          onMove={onMove}
          showMoveButtons={
            columns.watching.includes(addr) ||
            columns.mcap_tracker.includes(addr)
          }
          isMcapSource={isMcapSource}
        />
      );
    },
    [
      signals,
      symbols,
      interval,
      isDraggingGlobal,
      buyStates,
      columns.watching,
      columns.mcap_tracker,
      onBuy,
      onSell,
      onSimulate,
      onSimulateSell,
      onEnd,
      onRemove,
      onMove,
    ],
  );

  return (
    <div className="text-white">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-semibold">Chart board</h2>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 bg-gray-800 p-2 rounded-lg border border-gray-700">
              <span className="text-sm text-gray-400">Strategy:</span>
              <select
                className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-sm"
                value={template}
                onChange={(e) =>
                  setTemplate(e.target.value as "default" | "sell_over_100")
                }
              >
                <option value="default">Default</option>
                <option value="sell_over_100">Sell over 100%</option>
              </select>
            </div>

            <div className="flex items-center gap-2 bg-gray-800 p-2 rounded-lg border border-gray-700">
              <span className="text-sm text-gray-400">Instant Buy:</span>
              <input
                type="number"
                step="0.1"
                min="0.01"
                className="bg-gray-900 border border-gray-600 rounded px-2 py-1 w-20 text-white text-sm"
                value={buyAmount}
                onChange={(e) => setBuyAmount(e.target.value)}
              />
              <span className="text-sm text-gray-400">SOL</span>
            </div>

            <div className="flex gap-2">
              <input
                className="bg-gray-800 border border-gray-700 rounded px-3 py-1 text-sm w-64"
                placeholder="Add token address..."
                value={newAddr}
                onChange={(e) => setNewAddr(e.target.value)}
              />
              <button
                onClick={handleAdd}
                className="bg-blue-600 hover:bg-blue-500 px-3 py-1 rounded text-sm font-medium"
              >
                Add
              </button>
            </div>
          </div>
        </div>

        {status && (
          <div className="bg-red-900/50 text-red-200 p-2 rounded mb-4 text-sm">
            {effectiveStatus}
          </div>
        )}

        <DndContext onDragEnd={handleDragEnd}>
          <div className="flex gap-4 h-[calc(100vh-150px)] overflow-x-auto pb-4">
            {SECTIONS.map((section) => (
              <DroppableColumn
                key={section.id}
                id={section.id}
                title={section.title}
                color={section.color}
                items={visibleColumnItems(section.id)}
                renderItem={renderCard}
                onBuyAll={
                  section.id === "potential" ? handleBuyPotential : undefined
                }
                buyAmount={potentialSolAmount}
                setBuyAmount={setPotentialSolAmount}
                isBuying={isBuyingPotential}
              />
            ))}
          </div>
        </DndContext>

        <ChartCaptureModal
          isOpen={captureOpen}
          data={captureData}
          onClose={closeCapture}
          onRetake={retakeCapture}
          onSave={saveResult}
        />
        <TradeOutcomeModal {...outcomeModalProps} />
      </div>
    </div>
  );
}

export default function BoardTab() {
  return (
    <Suspense fallback={<div className="p-4 text-center">Loading...</div>}>
      <ChartsContent />
    </Suspense>
  );
}
