"use client";
import React, { useEffect, useRef, useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { useIsClient } from "@/hooks/useIsClient";
import { TokenLabel } from "@/utils/mcap-tracker";
import ChartBuyModal from "@/components/ChartBuyModal";
import { useConnection, useWallet } from "@/components/WalletProvider";
import GmgnChartEmbed from "@/components/signals/shared/GmgnChartEmbed";
import RowTradePanel, {
  RowGmgnChart,
} from "@/components/signals/shared/RowTradePanel";
import { useSolRowHoldings } from "@/hooks/useSolRowHoldings";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { isWalletUserRejection } from "@/utils/wallet-rejection";
import { rowMarketSwap } from "@/utils/row-market-swap";
import {
  priorityFeeFromSolInput,
  priorityFeeReserveLamports,
} from "@/utils/priority-fee";
import { floatingChartSolBuyLeg } from "@/utils/tracker-base-asset";
import TokenSearchLink from "@/components/signals/shared/TokenSearchLink";
import DlmmChartActions from "@/components/dlmm/DlmmChartActions";
import GlobalWatchlistButton from "@/components/GlobalWatchlistButton";
import { RUG_LIST_QUERY_KEY } from "@/hooks/useRugList";
import { useQueryClient } from "@tanstack/react-query";
import { useTradingSignals, SignalItem } from "@/hooks/useTradingSignals";
import { formatAppDateTime } from "@/utils/datetime";
import {
  formatSignalsListOptionLabel,
  formatSignalsListOptionTitle,
  readSignalsListStrategyId,
  writeSignalsListStrategyId,
  type SignalsListPickerOption,
} from "@/utils/signals-strategy-id";
import { useAppNetwork } from "@/contexts/AppNetworkContext";

/** ponytail: replace react-draggable — pointer drag on handle selector only */
function FreeDrag({
  defaultPosition,
  onStart,
  onStop,
  handle,
  children,
}: {
  defaultPosition: { x: number; y: number }
  onStart?: () => void
  onStop?: (_e: PointerEvent, data: { x: number; y: number }) => void
  handle: string
  children: React.ReactElement<{ style?: React.CSSProperties }>
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const posRef = useRef(defaultPosition)
  const [pos, setPos] = useState(defaultPosition)
  const drag = useRef<{ ox: number; oy: number; px: number; py: number } | null>(null)
  const onStartRef = useRef(onStart)
  const onStopRef = useRef(onStop)
  onStartRef.current = onStart
  onStopRef.current = onStop

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element
      if (!target.closest(handle)) return
      if (target.closest('button, a, input, select, textarea, label')) return
      e.preventDefault()
      onStartRef.current?.()
      const p = posRef.current
      drag.current = { ox: e.clientX, oy: e.clientY, px: p.x, py: p.y }
      el.setPointerCapture(e.pointerId)
    }
    const onMove = (e: PointerEvent) => {
      if (!drag.current) return
      const next = {
        x: drag.current.px + (e.clientX - drag.current.ox),
        y: drag.current.py + (e.clientY - drag.current.oy),
      }
      posRef.current = next
      setPos(next)
    }
    const onUp = (e: PointerEvent) => {
      if (!drag.current) return
      const next = {
        x: drag.current.px + (e.clientX - drag.current.ox),
        y: drag.current.py + (e.clientY - drag.current.oy),
      }
      drag.current = null
      posRef.current = next
      setPos(next)
      onStopRef.current?.(e, next)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [handle])

  const zIndex = children.props.style?.zIndex

  return (
    <div
      ref={wrapRef}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: typeof zIndex === 'number' ? zIndex : undefined,
      }}
    >
      {children}
    </div>
  )
}

// Removed local types SignalItem and SignalsResponse as they are now imported

type FloatingChart = {
  id: string;
  tokenAddress: string;
  tokenSymbol?: string;
  position: { x: number; y: number };
  zIndex: number;
  isLoading: boolean;
  isInGrid: boolean;
  isDraggable: boolean;
  gridOrder: number;
  label?: TokenLabel | null;
};

const numberFmt = (n?: number) => {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(n);
};

const percentFmt = (p?: number) => {
  if (p === undefined || p === null || Number.isNaN(p)) return "—";
  return `${p.toFixed(2)}%`;
};

const dateFmt = (iso?: string | null) => formatAppDateTime(iso);

const peakFmt = (growth?: number | null, seenAt?: string | null) => {
  if (growth == null || !Number.isFinite(growth) || growth <= 0) return "—";
  const pct = percentFmt(growth);
  const when = seenAt ? dateFmt(seenAt) : null;
  if (!when || when === "—") return pct;
  // Compact: "+142% @ 12:06" — take time portion when full datetime is long
  const timePart = when.includes(" ") ? when.split(" ").slice(-1)[0] : when;
  return `${pct} @ ${timePart}`;
};

const labelBadge = (label?: string | null) => {
  if (!label || label === "valid") return null;
  const base = "px-1.5 py-0.5 rounded text-xs font-medium uppercase";
  if (label === "rugged") {
    return <span className={`${base} bg-red-100 text-red-700`}>rug</span>;
  }
  if (label === "potential") {
    return (
      <span className={`${base} bg-amber-100 text-amber-800`}>potential</span>
    );
  }
  return null;
};

const mlShadowFmt = (
  pWinner?: number | null,
  predicted?: "winner" | "loser" | null,
) => {
  if (pWinner == null || !Number.isFinite(pWinner)) {
    return <span className="text-gray-400">—</span>;
  }
  return (
    <span className="text-xs text-gray-600" title="Pattern ML shadow (display only)">
      {pWinner.toFixed(2)} {predicted ?? ""}
      <span className="ml-1 text-xs uppercase opacity-60">shadow</span>
    </span>
  );
};

function loadChartsFromStorage(): FloatingChart[] {
  try {
    const saved = localStorage.getItem("tradingSignals_floatingCharts");
    if (!saved) return [];

    const parsedCharts = JSON.parse(saved);
    return parsedCharts.map((chart: FloatingChart) => ({
      ...chart,
      isLoading: true,
    }));
  } catch (error) {
    console.warn("Failed to load charts from localStorage:", error);
    return [];
  }
}

function getInitialChartsState(): {
  charts: FloatingChart[];
  nextZIndex: number;
} {
  if (typeof window === "undefined") {
    return { charts: [], nextZIndex: 200 };
  }
  const savedCharts = loadChartsFromStorage();
  if (savedCharts.length === 0) {
    return { charts: [], nextZIndex: 200 };
  }
  const maxZIndex = Math.max(...savedCharts.map((chart) => chart.zIndex), 199);
  return { charts: savedCharts, nextZIndex: maxZIndex + 1 };
}

export default function SignalsTab() {
  const queryClient = useQueryClient();
  const { network } = useAppNetwork();
  const isRhNetwork = network === "robinhood";
  const rowHoldings = useSolRowHoldings(!isRhNetwork);
  const { publicKey, connected, signTransaction } = useWallet();
  const { connection } = useConnection();
  const walletAddress = connected && publicKey ? publicKey.toBase58() : null;
  const { walletBalance: walletBalanceSol, refreshBalances } = useWalletBalances({
    walletAddress,
    enabled: Boolean(walletAddress) && !isRhNetwork,
  });
  const isClient = useIsClient();
  const initialCharts = getInitialChartsState();
  const [limit, setLimit] = useState(50);
  const [recencyMinutes, setRecencyMinutes] = useState(240);
  const [minGrowth, setMinGrowth] = useState(0);
  const [includeStuck, setIncludeStuck] = useState(false);
  const [maxAgeMinutes, setMaxAgeMinutes] = useState(48 * 60);
  const [strategyId, setStrategyId] = useState(() =>
    readSignalsListStrategyId(network),
  );
  const [strategyNetwork, setStrategyNetwork] = useState(network);
  if (strategyNetwork !== network) {
    setStrategyNetwork(network);
    setStrategyId(readSignalsListStrategyId(network));
  }

  const {
    data: apiResponse,
    isLoading: loading,
    error: queryError,
    refetch,
  } = useTradingSignals({
    limit,
    recencyMinutes,
    minGrowth,
    includeStuck,
    maxAgeMinutes,
    strategy: strategyId,
    chain: network,
  });

  const error = queryError ? queryError.message : "";
  const signals = apiResponse?.signals || [];
  const stats = apiResponse?.stats || {};
  const strategyOptions: SignalsListPickerOption[] =
    apiResponse?.strategies ?? [];
  const pickerOptions =
    strategyOptions.length === 0
      ? [
          {
            strategyId,
            name: strategyId,
            domain: "signals" as const,
            avgPnlPct: null,
            totalPnlPct: null,
            n: 0,
          },
        ]
      : strategyOptions.some((option) => option.strategyId === strategyId)
        ? strategyOptions
        : [
            {
              strategyId,
              name: strategyId,
              domain: "signals" as const,
              avgPnlPct: null,
              totalPnlPct: null,
              n: 0,
            },
            ...strategyOptions,
          ];

  // Multiple floating charts state
  const [floatingCharts, setFloatingCharts] = useState<FloatingChart[]>(
    initialCharts.charts,
  );
  const [nextZIndex, setNextZIndex] = useState(initialCharts.nextZIndex);

  const [chartModalTokenAddress, setChartModalTokenAddress] = useState<
    string | null
  >(null);
  const [chartMint, setChartMint] = useState<string | null>(null);
  const [tradePanel, setTradePanel] = useState<{
    mint: string;
    side: "buy" | "sell";
  } | null>(null);
  /** Empty string = auto high, capped at 0.003 SOL. A number is an exact tip. */
  const [buyFeesSol, setBuyFeesSol] = useState("");
  const [buySolOverride, setBuySolOverride] = useState<number | null>(null);
  const [floatingBuyStates, setFloatingBuyStates] = useState<
    Record<string, { loading?: boolean; error?: string; status?: string }>
  >({});
  const autoBuySol =
    connected && walletBalanceSol && walletBalanceSol > 0
      ? Number((walletBalanceSol * 0.03).toFixed(4))
      : 0;
  const buySolAmount = buySolOverride ?? autoBuySol;

  const openRowTrade = (mint: string, side: "buy" | "sell") => {
    if (isRhNetwork) {
      setChartModalTokenAddress(mint);
      return;
    }
    setChartMint(mint);
    setTradePanel((prev) =>
      prev?.mint === mint && prev.side === side ? null : { mint, side },
    );
  };

  const patchFloatingBuy = (
    tokenAddress: string,
    patch: { loading?: boolean; error?: string; status?: string },
  ) => {
    setFloatingBuyStates((prev) => ({ ...prev, [tokenAddress]: patch }));
  };

  /** Floating-chart Buy: toolbar SOL amount, no amount modal. Matching trading key signs on the server; any other wallet still confirms once. */
  const handleFloatingChartBuy = async (tokenAddress: string) => {
    if (isRhNetwork) return;
    if (!connected || !publicKey || !signTransaction) {
      patchFloatingBuy(tokenAddress, {
        loading: false,
        error: "Connect a Solana wallet first",
      });
      return;
    }
    if (!connection) {
      patchFloatingBuy(tokenAddress, {
        loading: false,
        error: "RPC connection is not ready",
      });
      return;
    }
    if (!Number.isFinite(buySolAmount) || buySolAmount <= 0) {
      patchFloatingBuy(tokenAddress, {
        loading: false,
        error: "Set buy amount",
      });
      return;
    }

    patchFloatingBuy(tokenAddress, { loading: true, status: "Quoting…" });
    try {
      const priorityFeeLamports = priorityFeeFromSolInput(
        buyFeesSol.trim() === "" ? "" : Number(buyFeesSol),
      );
      const feeSol =
        priorityFeeReserveLamports(priorityFeeLamports) / LAMPORTS_PER_SOL;
      if ((walletBalanceSol ?? 0) < buySolAmount + feeSol) {
        throw new Error(
          `Not enough SOL. Need ${(buySolAmount + feeSol).toFixed(4)} including fees, have ${(walletBalanceSol ?? 0).toFixed(4)}.`,
        );
      }
      const leg = floatingChartSolBuyLeg(tokenAddress, buySolAmount);
      if (leg.amountRaw <= 0) {
        throw new Error("Amount is too small");
      }
      const result = await rowMarketSwap(
        {
          connection,
          userPublicKey: publicKey.toBase58(),
          signTransaction: (tx) => signTransaction(tx),
          inputMint: leg.inputMint,
          outputMint: leg.outputMint,
          amount: leg.amountRaw,
          priorityFeeLamports,
        },
        (message) =>
          patchFloatingBuy(tokenAddress, { loading: true, status: message }),
      );
      patchFloatingBuy(tokenAddress, {
        loading: false,
        status: `Sent · impact ${result.impactPct.toFixed(2)}%`,
      });
      await refreshBalances(true);
      void rowHoldings.refetchFresh();
      window.setTimeout(() => {
        setFloatingBuyStates((prev) => {
          const next = { ...prev };
          delete next[tokenAddress];
          return next;
        });
      }, 2500);
    } catch (err) {
      if (isWalletUserRejection(err)) {
        patchFloatingBuy(tokenAddress, {
          loading: false,
          status: "Wallet cancelled",
        });
        return;
      }
      patchFloatingBuy(tokenAddress, {
        loading: false,
        error: err instanceof Error ? err.message : "Buy failed",
      });
    }
  };

  // localStorage helpers for chart persistence
  const saveChartsToStorage = (charts: FloatingChart[]) => {
    try {
      const chartsToSave = charts.map((chart) => ({
        id: chart.id,
        tokenAddress: chart.tokenAddress,
        tokenSymbol: chart.tokenSymbol,
        position: chart.position,
        zIndex: chart.zIndex,
        isInGrid: chart.isInGrid,
        isDraggable: chart.isDraggable,
        gridOrder: chart.gridOrder,
        label: chart.label,
      }));
      localStorage.setItem(
        "tradingSignals_floatingCharts",
        JSON.stringify(chartsToSave),
      );
    } catch (error) {
      console.warn("Failed to save charts to localStorage:", error);
    }
  };

  // Persist charts to localStorage whenever floatingCharts changes
  useEffect(() => {
    if (isClient && floatingCharts.length >= 0) {
      saveChartsToStorage(floatingCharts);
    }
  }, [floatingCharts, isClient]);

  const decisionBadge = (d?: SignalItem["decision"]) => {
    const base = "px-2 py-0.5 rounded text-xs font-medium";
    switch (d) {
      case "enter":
        return (
          <span className={`${base} bg-green-100 text-green-700`}>enter</span>
        );
      case "hold":
        return (
          <span className={`${base} bg-yellow-100 text-yellow-700`}>hold</span>
        );
      case "exit":
        return <span className={`${base} bg-red-100 text-red-700`}>exit</span>;
      case "skip":
        return (
          <span className={`${base} bg-gray-100 text-gray-700`}>skip</span>
        );
      default:
        return <span className={`${base} bg-gray-100 text-gray-700`}>n/a</span>;
    }
  };

  const handleOpenChart = (tokenAddress: string, tokenSymbol?: string) => {
    // Check if chart is already open
    const existingChart = floatingCharts.find(
      (chart) => chart.tokenAddress === tokenAddress,
    );
    if (existingChart) {
      // Bring to front by updating z-index
      setFloatingCharts((prev) =>
        prev.map((chart) =>
          chart.id === existingChart.id
            ? { ...chart, zIndex: nextZIndex }
            : chart,
        ),
      );
      setNextZIndex((prev) => prev + 1);
      return;
    }

    // Calculate position for new chart in grid area
    const gridCharts = floatingCharts.filter((chart) => chart.isInGrid);
    const gridPosition = {
      x: 10 + gridCharts.length * 410, // Horizontal stacking
      y: 40,
    };

    // Create new floating chart
    const newChart: FloatingChart = {
      id: `chart-${tokenAddress}-${Date.now()}`,
      tokenAddress,
      tokenSymbol,
      position: gridPosition,
      zIndex: nextZIndex,
      isLoading: true,
      isInGrid: true,
      isDraggable: false,
      gridOrder: gridCharts.length,
      label: null,
    };

    setFloatingCharts((prev) => [...prev, newChart]);
    setNextZIndex((prev) => prev + 1);
  };

  // Label management
  const handleUpdateLabel = async (
    chartId: string,
    tokenAddress: string,
    label: TokenLabel | null,
  ) => {
    try {
      const response = await fetch("/api/mcap-tracking/label", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tokenAddress,
          label,
        }),
      });

      const result = await response.json();

      if (result.success) {
        // Update the chart's label in state
        setFloatingCharts((prev) =>
          prev.map((chart) =>
            chart.id === chartId ? { ...chart, label } : chart,
          ),
        );
        void queryClient.invalidateQueries({ queryKey: RUG_LIST_QUERY_KEY });
      } else {
        console.error("Failed to update label:", result.error);
        alert(`Failed to update label: ${result.error}`);
      }
    } catch (error) {
      console.error("Error updating label:", error);
      alert("Error updating label. Please try again.");
    }
  };

  const getLabelColor = (label?: TokenLabel | null) => {
    switch (label) {
      case "valid":
        return "bg-green-100 text-green-800 border-green-300";
      case "traded_live":
        return "bg-blue-100 text-blue-800 border-blue-300";
      case "potential":
        return "bg-yellow-100 text-yellow-800 border-yellow-300";
      case "rugged":
        return "bg-red-100 text-red-800 border-red-300";
      default:
        return "bg-gray-100 text-gray-600 border-gray-300";
    }
  };

  const getLabelDisplayText = (label?: TokenLabel | null) => {
    return label || "No Label";
  };

  const handleCloseChart = (chartId: string) => {
    setFloatingCharts((prev) => prev.filter((chart) => chart.id !== chartId));
  };

  const handleChartLoad = (chartId: string) => {
    setFloatingCharts((prev) =>
      prev.map((chart) =>
        chart.id === chartId ? { ...chart, isLoading: false } : chart,
      ),
    );
  };

  const handleChartError = (chartId: string) => {
    console.error("Chart failed to load for chart:", chartId);
    setFloatingCharts((prev) =>
      prev.map((chart) =>
        chart.id === chartId ? { ...chart, isLoading: false } : chart,
      ),
    );
  };

  const handleReorderCharts = (
    draggedChartId: string,
    targetChartId: string,
  ) => {
    setFloatingCharts((prev) => {
      const draggedChart = prev.find((chart) => chart.id === draggedChartId);
      const targetChart = prev.find((chart) => chart.id === targetChartId);

      if (!draggedChart || !targetChart) return prev;

      const draggedOrder = draggedChart.gridOrder;
      const targetOrder = targetChart.gridOrder;

      return prev.map((chart) => {
        if (chart.id === draggedChartId) {
          return { ...chart, gridOrder: targetOrder };
        } else if (chart.id === targetChartId) {
          return { ...chart, gridOrder: draggedOrder };
        }
        return chart;
      });
    });
  };

  const handleDragStart = (chartId: string) => {
    // Enable dragging when user starts to drag
    setFloatingCharts((prev) =>
      prev.map((chart) =>
        chart.id === chartId ? { ...chart, isDraggable: true } : chart,
      ),
    );
  };

  const handleDragStop = (chartId: string, data: any) => {
    // Define grid area boundaries (Top horizontal area)
    // Height is min 320px + padding. Let's say top 360px is the grid area.
    const GRID_HEIGHT = 360;

    const isInGridArea = data.y >= 0 && data.y <= GRID_HEIGHT;

    setFloatingCharts((prev) =>
      prev.map((chart) => {
        if (chart.id === chartId) {
          let newPosition = { x: data.x, y: data.y };
          let newIsInGrid = isInGridArea;

          // If moved into grid area, snap to grid position
          if (isInGridArea && !chart.isInGrid) {
            const gridCharts = prev.filter(
              (c) => c.isInGrid && c.id !== chartId,
            );
            newPosition = {
              x: 10 + gridCharts.length * 410, // Horizontal stacking
              y: 40, // Fixed top margin inside grid
            };
            newIsInGrid = true;
          }
          // If moved out of grid area, ensure it's marked as not in grid
          else if (!isInGridArea && chart.isInGrid) {
            newIsInGrid = false;
          }

          return {
            ...chart,
            position: newPosition,
            isInGrid: newIsInGrid,
            isDraggable: true,
          };
        }
        return chart;
      }),
    );
  };

  const floatingBuyControl = (tokenAddress: string) => {
    const state = floatingBuyStates[tokenAddress];
    return (
      <div
        className="flex items-center gap-2"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span
          className="text-sm text-gray-600"
          data-testid="floating-chart-buy-amount"
        >
          {buySolAmount} SOL
        </span>
        <button
          type="button"
          data-testid="floating-chart-buy"
          disabled={isRhNetwork || Boolean(state?.loading)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void handleFloatingChartBuy(tokenAddress);
          }}
          className="px-3 py-1 rounded text-sm font-medium bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white cursor-pointer"
          title={
            isRhNetwork
              ? "Solana wallet only"
              : state?.error ||
                state?.status ||
                `${buySolAmount} SOL · one wallet confirm`
          }
        >
          {state?.loading ? "Buying…" : "Buy"}
        </button>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {!isClient ? (
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded mb-4"></div>
          <div className="h-64 bg-gray-200 rounded"></div>
        </div>
      ) : (
        <>
          <div className="flex items-end flex-wrap gap-3 z-[-1]">
            <div>
              <label className="block text-sm font-medium">Strategy</label>
              <select
                value={strategyId}
                data-testid="signals-strategy-select"
                onChange={(e) => {
                  const next = e.target.value;
                  writeSignalsListStrategyId(next);
                  setStrategyId(next);
                }}
                className="mt-1 w-[36rem] max-w-full rounded border px-2 py-1 bg-black text-white"
              >
                {pickerOptions.map((option) => (
                  <option
                    key={option.strategyId}
                    value={option.strategyId}
                    title={formatSignalsListOptionTitle(option)}
                  >
                    {formatSignalsListOptionLabel(option)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium">
                Buy Amount (SOL)
              </label>
              <input
                type="number"
                min={0}
                max={10}
                step={0.0001}
                value={buySolAmount}
                onChange={(e) => setBuySolOverride(Number(e.target.value))}
                data-testid="signals-buy-amount"
                className="mt-1 w-32 rounded border px-2 py-1 bg-black text-white"
              />
              <div className="mt-1 flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() =>
                    setBuySolOverride(
                      Number(((walletBalanceSol ?? 0) * 0.05).toFixed(4)),
                    )
                  }
                  className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-700"
                >
                  5%
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setBuySolOverride(
                      Number(((walletBalanceSol ?? 0) * 0.25).toFixed(4)),
                    )
                  }
                  className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-700"
                >
                  25%
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setBuySolOverride(
                      Number(((walletBalanceSol ?? 0) * 0.9).toFixed(4)),
                    )
                  }
                  className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-700"
                >
                  90%
                </button>
              </div>
              {connected && !isRhNetwork && (
                <div className="mt-1 text-xs text-gray-400">
                  Wallet: {(walletBalanceSol ?? 0).toFixed(4)} SOL
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium">Fees (SOL)</label>
              <input
                type="number"
                min={0}
                max={0.003}
                step={0.0001}
                value={buyFeesSol}
                placeholder="auto"
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    setBuyFeesSol("");
                    return;
                  }
                  const n = Number(raw);
                  if (!Number.isFinite(n)) return;
                  if (n < 0) {
                    setBuyFeesSol("");
                    return;
                  }
                  setBuyFeesSol(n > 0.003 ? "0.003" : raw);
                }}
                data-testid="signals-buy-fees"
                className="mt-1 w-28 rounded border px-2 py-1 bg-black text-white"
              />
              <div className="mt-1 text-xs text-gray-400">
                auto high · max 0.003
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium">Limit</label>
              <input
                type="number"
                min={1}
                max={200}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className="mt-1 w-24 rounded border px-2 py-1 bg-black text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Recency (min)</label>
              <input
                type="number"
                min={0}
                value={recencyMinutes}
                onChange={(e) => setRecencyMinutes(Number(e.target.value))}
                className="mt-1 w-28 rounded border px-2 py-1 bg-black text-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium">
                Min Growth (%)
              </label>
              <input
                type="number"
                min={0}
                value={minGrowth}
                onChange={(e) => setMinGrowth(Number(e.target.value))}
                className="mt-1 w-32 rounded border px-2 py-1 bg-black text-white"
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="includeStuck"
                type="checkbox"
                checked={includeStuck}
                onChange={(e) => setIncludeStuck(e.target.checked)}
              />
              <label htmlFor="includeStuck" className="text-sm font-medium">
                Include Stuck
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium">Max Age (min)</label>
              <input
                type="number"
                min={0}
                value={maxAgeMinutes}
                onChange={(e) => setMaxAgeMinutes(Number(e.target.value))}
                className="mt-1 w-32 rounded border px-2 py-1 bg-black text-white"
              />
            </div>
            <button
              onClick={() => refetch()}
              className="ml-auto rounded bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700"
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {error && (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-4">
            {/* Chart Grid Area - Top horizontal scroll */}
            <div
              className="w-full bg-black rounded-lg relative overflow-x-auto"
              style={{ minHeight: "320px" }}
            >
              <div className="absolute top-2 left-2 text-xs text-gray-500 font-medium z-10">
                Chart Area
              </div>

              {/* Non-draggable charts inside grid */}
              <div className="pt-8 flex flex-row space-x-4 p-2">
                {floatingCharts
                  .filter((chart) => chart.isInGrid && !chart.isDraggable)
                  .sort((a, b) => a.gridOrder - b.gridOrder)
                  .map((chart) => (
                    <div
                      key={chart.id}
                      className="flex-shrink-0 bg-white border-2 border-gray-300 rounded-lg shadow-2xl"
                      style={{
                        width: "400px",
                        height: "260px",
                      }}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", chart.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const draggedChartId =
                          e.dataTransfer.getData("text/plain");
                        if (draggedChartId !== chart.id) {
                          handleReorderCharts(draggedChartId, chart.id);
                        }
                      }}
                    >
                      {/* Header with close button and buy controls */}
                      <div className="flex justify-between items-center p-3 border-b border-gray-200 bg-gray-50 rounded-t-lg drag-handle cursor-move">
                        <div className="flex items-center gap-3">
                          <span className="font-semibold text-gray-800">
                            {chart.tokenSymbol || "UNKNOWN"}
                          </span>
                          <div className="flex items-center gap-2">
                            {floatingBuyControl(chart.tokenAddress)}
                            <GlobalWatchlistButton
                              tokenAddress={chart.tokenAddress}
                              tokenSymbol={chart.tokenSymbol}
                            />
                          </div>
                        </div>
                        <button
                          onClick={() => handleCloseChart(chart.id)}
                          className="text-gray-500 hover:text-gray-700 text-xl font-bold"
                        >
                          ×
                        </button>
                      </div>

                      <GmgnChartEmbed
                        tokenAddress={chart.tokenAddress}
                        interval="5"
                        chain={network === "robinhood" ? "robinhood" : "sol"}
                        className="w-full h-full rounded-b-lg"
                        height="calc(100% - 60px)"
                        title={`GMGN Chart - ${chart.tokenAddress}`}
                      />
                    </div>
                  ))}

                {floatingCharts.filter((chart) => chart.isInGrid).length ===
                  0 && (
                  <div className="flex items-center justify-center w-full h-64 text-gray-400 text-sm">
                    Charts will appear here when opened
                  </div>
                )}
              </div>
            </div>

            {/* Table Area - Full width */}
            {tradePanel &&
              !isRhNetwork &&
              !signals.some((s) => s.token_address === tradePanel.mint) && (
                <RowTradePanel
                  tokenAddress={tradePanel.mint}
                  tokenSymbol={
                    floatingCharts.find(
                      (chart) => chart.tokenAddress === tradePanel.mint,
                    )?.tokenSymbol || "Token"
                  }
                  side={tradePanel.side}
                  usdtUi={rowHoldings.usdtUi}
                  usdtReady={rowHoldings.usdtReady}
                  holding={(() => {
                    const held = rowHoldings.heldTokenByMint.get(
                      tradePanel.mint.toLowerCase(),
                    );
                    return held
                      ? {
                          balanceRaw: held.balance,
                          uiAmount: held.uiAmount,
                          decimals: held.decimals,
                        }
                      : null;
                  })()}
                  onClose={() => setTradePanel(null)}
                  onSettled={() => {
                    void rowHoldings.refetchFresh();
                  }}
                />
              )}
            <div className="w-full overflow-x-auto z-[100] relative">
              <table className="min-w-full border-collapse">
                <thead>
                  <tr className="text-left text-sm">
                    <th className="border-b p-2">Token</th>
                    <th className="border-b p-2">Address</th>
                    <th className="border-b p-2">Growth %</th>
                    <th className="border-b p-2">Score</th>
                    <th className="border-b p-2">ML</th>
                    <th className="border-b p-2">Decision</th>
                    <th className="border-b p-2">Rationale</th>
                    <th className="border-b p-2">First Seen</th>
                    <th className="border-b p-2">Last Updated</th>
                    <th className="border-b p-2">80%</th>
                    <th className="border-b p-2">120%</th>
                    <th className="border-b p-2">200%</th>
                    <th className="border-b p-2">-40%</th>
                    <th className="border-b p-2">-80%</th>
                    <th className="border-b p-2">Peak</th>
                    <th className="border-b p-2">Stuck</th>
                    <th className="border-b p-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.length === 0 && !loading ? (
                    <tr>
                      <td className="p-4 text-center text-sm" colSpan={17}>
                        No signals
                      </td>
                    </tr>
                  ) : (
                    signals.map((s) => {
                      const held = rowHoldings.heldTokenByMint.get(
                        s.token_address.toLowerCase(),
                      );
                      const chartOpen = chartMint === s.token_address;
                      const tradeOpen = tradePanel?.mint === s.token_address;
                      return (
                      <React.Fragment
                        key={`${s.token_address}-${s.last_updated_at || s.first_seen_at || "0"}`}
                      >
                      <tr className="text-sm">
                        <td className="border-b p-2 relative">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="font-medium text-blue-700 hover:underline"
                              onClick={() => {
                                if (isRhNetwork) {
                                  setChartModalTokenAddress(s.token_address);
                                  return;
                                }
                                setChartMint((prev) =>
                                  prev === s.token_address
                                    ? null
                                    : s.token_address,
                                );
                              }}
                            >
                              {s.token_symbol || "UNKNOWN"}
                            </button>
                            {(s.alsoMatches ?? []).map((match) => (
                              <span
                                key={match.strategyId}
                                data-testid="signal-also-match"
                                className="px-1.5 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-800"
                              >
                                {match.name}
                              </span>
                            ))}
                            <TokenSearchLink address={s.token_address} />
                            {labelBadge(s.label)}
                            <button
                              onClick={() =>
                                handleOpenChart(s.token_address, s.token_symbol)
                              }
                              className="text-blue-600 hover:text-blue-800 p-1"
                              title="View Chart"
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
                                  d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                                />
                              </svg>
                            </button>
                          </div>
                        </td>
                        <td className="border-b p-2">
                          <code className="text-xs">{s.token_address}</code>
                        </td>
                        <td className="border-b p-2">
                          {percentFmt(s.mcap_growth_percent)}
                        </td>
                        <td className="border-b p-2">{numberFmt(s.score)}</td>
                        <td className="border-b p-2">
                          {mlShadowFmt(
                            s.ml_pattern_p_winner,
                            s.ml_pattern_predicted,
                          )}
                        </td>
                        <td className="border-b p-2">
                          {decisionBadge(s.decision)}
                        </td>
                        <td className="border-b p-2 max-w-xs">
                          <div className="truncate" title={s.rationale || ""}>
                            {s.rationale || ""}
                          </div>
                        </td>
                        <td className="border-b p-2">
                          {dateFmt(s.first_seen_at)}
                        </td>
                        <td className="border-b p-2">
                          {dateFmt(s.last_updated_at)}
                        </td>
                        <td className="border-b p-2">
                          {dateFmt(s.when_reach_80pct)}
                        </td>
                        <td className="border-b p-2">
                          {dateFmt(s.when_reach_120pct)}
                        </td>
                        <td className="border-b p-2">
                          {dateFmt(s.when_reach_200pct)}
                        </td>
                        <td className="border-b p-2 text-red-600">
                          {dateFmt(s.when_drop_40pct)}
                        </td>
                        <td className="border-b p-2 text-red-700">
                          {dateFmt(s.when_drop_80pct)}
                        </td>
                        <td className="border-b p-2 text-emerald-700">
                          {peakFmt(s.peak_growth_percent, s.peak_seen_at)}
                        </td>
                        <td className="border-b p-2">
                          {s.is_tracking_stuck ? "Yes" : "No"}
                        </td>
                        <td className="border-b p-2 flex gap-2 flex-wrap items-center">
                          <button
                            onClick={() => {
                              if (isRhNetwork) {
                                setChartModalTokenAddress(s.token_address);
                                return;
                              }
                              setChartMint((prev) =>
                                prev === s.token_address
                                  ? null
                                  : s.token_address,
                              );
                            }}
                            className={`px-3 py-1 text-white text-xs rounded font-medium transition-colors ${
                              chartOpen && !isRhNetwork
                                ? "bg-green-700"
                                : "bg-green-600 hover:bg-green-700"
                            }`}
                            title="Show GMGN chart"
                          >
                            {chartOpen && !isRhNetwork ? "Hide chart" : "Chart"}
                          </button>
                          <button
                            onClick={() => openRowTrade(s.token_address, "buy")}
                            className={`px-3 py-1 text-white text-xs rounded font-medium ${
                              tradeOpen && tradePanel?.side === "buy"
                                ? "bg-blue-700"
                                : "bg-blue-600 hover:bg-blue-700"
                            }`}
                            title="Buy with amount slider"
                          >
                            Buy
                          </button>
                          {!isRhNetwork && held && held.balance > 0 && (
                            <button
                              onClick={() =>
                                openRowTrade(s.token_address, "sell")
                              }
                              className={`px-3 py-1 text-white text-xs rounded font-medium ${
                                tradeOpen && tradePanel?.side === "sell"
                                  ? "bg-amber-700"
                                  : "bg-amber-600 hover:bg-amber-700"
                              }`}
                              title="Sell with percent slider"
                            >
                              Sell
                            </button>
                          )}
                          <DlmmChartActions
                            tokenAddress={s.token_address}
                            tokenSymbol={s.token_symbol}
                            source="signals"
                          />
                        </td>
                      </tr>
                      {(chartOpen || tradeOpen) && !isRhNetwork && (
                        <tr>
                          <td colSpan={17} className="border-b p-2 bg-gray-950">
                            {chartOpen && (
                              <RowGmgnChart tokenAddress={s.token_address} />
                            )}
                            {tradeOpen && tradePanel && (
                              <RowTradePanel
                                tokenAddress={s.token_address}
                                tokenSymbol={s.token_symbol || "UNKNOWN"}
                                side={tradePanel.side}
                                usdtUi={rowHoldings.usdtUi}
                                usdtReady={rowHoldings.usdtReady}
                                holding={
                                  held
                                    ? {
                                        balanceRaw: held.balance,
                                        uiAmount: held.uiAmount,
                                        decimals: held.decimals,
                                      }
                                    : null
                                }
                                onClose={() => setTradePanel(null)}
                                onSettled={() => {
                                  void rowHoldings.refetchFresh();
                                }}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      {/* Floating Charts - Only draggable charts that are outside grid */}
      {floatingCharts
        .filter((chart) => chart.isDraggable && !chart.isInGrid)
        .map((chart) => (
          <FreeDrag
            key={chart.id}
            defaultPosition={chart.position}
            onStart={() => handleDragStart(chart.id)}
            onStop={(_e, data) => handleDragStop(chart.id, data)}
            handle=".drag-handle"
          >
            <div
              className="bg-white border-2 border-gray-300 rounded-lg shadow-2xl"
              style={{
                width: "480px",
                height: "320px",
                zIndex: chart.zIndex,
              }}
            >
              {/* Header with close button and buy controls */}
              <div className="flex justify-between items-center p-3 border-b border-gray-200 bg-gray-50 rounded-t-lg drag-handle cursor-move">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-gray-800">
                    {chart.tokenSymbol || "UNKNOWN"}
                  </span>

                  {/* Label Dropdown */}
                  <div className="flex items-center gap-2">
                    <select
                      value={chart.label || ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        const label: TokenLabel | null =
                          value === "" ? null : (value as TokenLabel);
                        handleUpdateLabel(chart.id, chart.tokenAddress, label);
                      }}
                      className={`px-2 py-1 text-xs rounded border ${getLabelColor(chart.label)} cursor-pointer`}
                      onClick={(e) => e.stopPropagation()} // Prevent drag when clicking dropdown
                    >
                      <option value="">No Label</option>
                      <option value="valid">Valid</option>
                      <option value="traded_live">Traded Live</option>
                      <option value="potential">Potential</option>
                      <option value="rugged">Rugged</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-2">
                    {floatingBuyControl(chart.tokenAddress)}
                    <GlobalWatchlistButton
                      tokenAddress={chart.tokenAddress}
                      tokenSymbol={chart.tokenSymbol}
                    />
                  </div>
                </div>
                <button
                  onClick={() => handleCloseChart(chart.id)}
                  className="text-gray-500 hover:text-gray-700 text-xl font-bold"
                >
                  ×
                </button>
              </div>

              <GmgnChartEmbed
                tokenAddress={chart.tokenAddress}
                interval="5"
                chain={network === "robinhood" ? "robinhood" : "sol"}
                className="w-full h-full rounded-b-lg"
                height="calc(100% - 60px)"
                title={`GMGN Chart - ${chart.tokenAddress}`}
              />
            </div>
          </FreeDrag>
        ))}{" "}
      {/* Chart Buy Modal */}
      {chartModalTokenAddress && (
        <ChartBuyModal
          tokenAddress={chartModalTokenAddress}
          onClose={() => setChartModalTokenAddress(null)}
          onNavigate={(direction) => {
            if (!signals.length) return;
            const currentIndex = signals.findIndex(
              (s) => s.token_address === chartModalTokenAddress,
            );
            if (currentIndex === -1) return;

            const nextIndex =
              direction === "next" ? currentIndex + 1 : currentIndex - 1;
            if (nextIndex >= 0 && nextIndex < signals.length) {
              setChartModalTokenAddress(signals[nextIndex].token_address);
            }
          }}
          hasPrev={
            signals.findIndex(
              (s) => s.token_address === chartModalTokenAddress,
            ) > 0
          }
          hasNext={
            signals.findIndex(
              (s) => s.token_address === chartModalTokenAddress,
            ) <
            signals.length - 1
          }
        />
      )}
    </div>
  );
}
