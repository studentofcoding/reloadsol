"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet, useConnection } from "@/components/WalletProvider";
import { useIsClient } from "@/hooks/useIsClient";
import { useWalletBalances } from "@/hooks/useWalletBalances";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { executeBulkBuy } from "@/utils/jupiter";
import { trackBuy } from "@/utils/operations-api";
import type { BulkBuyRequest } from "@/types";
import { TokenLabel } from "@/utils/mcap-tracker";
import ChartBuyModal from "@/components/ChartBuyModal";
import GmgnChartEmbed from "@/components/signals/shared/GmgnChartEmbed";
import TokenSearchLink from "@/components/signals/shared/TokenSearchLink";
import DlmmChartActions from "@/components/dlmm/DlmmChartActions";
import GlobalWatchlistButton from "@/components/GlobalWatchlistButton";
import { RUG_LIST_QUERY_KEY } from "@/hooks/useRugList";
import { useQueryClient } from "@tanstack/react-query";
import { useTradingSignals, SignalItem } from "@/hooks/useTradingSignals";
import { formatAppDateTime } from "@/utils/datetime";
import {
  readSignalsStrategyTemplate,
  writeSignalsStrategyTemplate,
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
  const { connected, publicKey, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const isClient = useIsClient();
  const walletAddress = connected && publicKey ? publicKey.toString() : null;
  const initialCharts = getInitialChartsState();
  const [limit, setLimit] = useState(50);
  const [recencyMinutes, setRecencyMinutes] = useState(240);
  const [minGrowth, setMinGrowth] = useState(0);
  const [includeStuck, setIncludeStuck] = useState(false);
  const [maxAgeMinutes, setMaxAgeMinutes] = useState(48 * 60);
  const [strategy, setStrategy] = useState<"default" | "sell_over_100">(
    readSignalsStrategyTemplate,
  );

  useEffect(() => {
    writeSignalsStrategyTemplate(strategy);
  }, [strategy]);

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
    strategy,
    chain: network,
  });

  const error = queryError ? queryError.message : "";
  const signals = apiResponse?.signals || [];
  const stats = apiResponse?.stats || {};

  // Multiple floating charts state
  const [floatingCharts, setFloatingCharts] = useState<FloatingChart[]>(
    initialCharts.charts,
  );
  const [nextZIndex, setNextZIndex] = useState(initialCharts.nextZIndex);

  // Buy configuration state
  const [buyConfig, setBuyConfig] = useState({
    solAmount: 0,
    fees: 0.001,
  });
  const [hasAutoSetSolAmount, setHasAutoSetSolAmount] =
    useState<boolean>(false);
  const [chartModalTokenAddress, setChartModalTokenAddress] = useState<
    string | null
  >(null);
  const [buyStates, setBuyStates] = useState<
    Record<string, { loading?: boolean; error?: string; status?: string }>
  >({});

  const { walletBalance: walletBalanceSol } = useWalletBalances({
    connection,
    publicKey,
    walletAddress,
    enabled: connected && !!publicKey,
  });

  if (connected && walletBalanceSol && walletBalanceSol > 0 && !hasAutoSetSolAmount) {
    const threePercent = Number((walletBalanceSol * 0.03).toFixed(4));
    setBuyConfig((prev) =>
      prev.solAmount === threePercent ? prev : { ...prev, solAmount: threePercent },
    );
    setHasAutoSetSolAmount(true);
  }

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

  // Default Buy Amount handled during render via walletBalanceSol

  // Fetch signals handled by React Query hook

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

  // Chart popup handlers
  const handleFastBuy = useCallback(
    async (tokenAddress: string, tokenSymbol?: string) => {
      if (network === "robinhood") {
        setChartModalTokenAddress(tokenAddress);
        return;
      }
      if (!connected || !publicKey || !signAllTransactions) {
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: "Connect wallet" },
        }));
        return;
      }
      if (!connection) {
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: "RPC not ready" },
        }));
        return;
      }
      const solAmount = buyConfig.solAmount;
      if (!solAmount || solAmount <= 0) {
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: "Set buy amount" },
        }));
        return;
      }

      setBuyStates((prev) => ({
        ...prev,
        [tokenAddress]: { loading: true, status: "Buying…" },
      }));

      try {
        const priorityFee = Math.round(buyConfig.fees * LAMPORTS_PER_SOL);
        const balanceBeforeOp = await connection.getBalance(publicKey);
        const balanceBeforeSOL = balanceBeforeOp / LAMPORTS_PER_SOL;
        const requiredAmount = solAmount + priorityFee / LAMPORTS_PER_SOL;
        if (balanceBeforeSOL < requiredAmount) {
          throw new Error(
            `Need ${requiredAmount.toFixed(4)} SOL, have ${balanceBeforeSOL.toFixed(4)}`,
          );
        }

        const request: BulkBuyRequest = {
          solAmount,
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

        if (!buyResult.success || buyResult.successfulPurchases.length === 0) {
          throw new Error(
            buyResult.failedPurchases[0]?.error || "Buy failed",
          );
        }

        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, status: "Done" },
        }));
        setTimeout(() => {
          setBuyStates((prev) => {
            const next = { ...prev };
            delete next[tokenAddress];
            return next;
          });
        }, 2500);

        trackBuy(publicKey.toString(), buyResult.successfulPurchases.length, {
          failureCount: buyResult.failedPurchases.length,
          solAmount,
          tokenMints: [tokenAddress],
          signatures: buyResult.signatures,
        }).catch(console.error);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: { loading: false, error: msg },
        }));
        console.error(`Fast buy failed for ${tokenSymbol ?? tokenAddress}:`, e);
      }
    },
    [
      buyConfig.fees,
      buyConfig.solAmount,
      connected,
      connection,
      network,
      publicKey,
      signAllTransactions,
    ],
  );

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

  // Buy functionality removed (moved to ChartBuyModal)

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
                value={strategy}
                onChange={(e) =>
                  setStrategy(e.target.value as "default" | "sell_over_100")
                }
                className="mt-1 w-40 rounded border px-2 py-1 bg-black text-white"
              >
                <option value="default">Default</option>
                <option value="sell_over_100">Sell Over 100%</option>
              </select>
            </div>

            {/* Buy Configuration */}
            <div>
              <label className="block text-sm font-medium">
                Buy Amount (SOL)
              </label>
              <input
                type="number"
                min={0.01}
                max={10}
                step={0.01}
                value={buyConfig.solAmount}
                onChange={(e) =>
                  setBuyConfig((prev) => ({
                    ...prev,
                    solAmount: Number(e.target.value),
                  }))
                }
                className="mt-1 w-32 rounded border px-2 py-1 bg-black text-white"
              />
              {/* Templates based on wallet SOL amount */}
              <div className="mt-1 flex gap-2 text-xs">
                <button
                  type="button"
                  onClick={() =>
                    setBuyConfig((prev) => ({
                      ...prev,
                      solAmount: Number(((walletBalanceSol ?? 0) * 0.05).toFixed(4)),
                    }))
                  }
                  className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-700"
                >
                  5%
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setBuyConfig((prev) => ({
                      ...prev,
                      solAmount: Number(((walletBalanceSol ?? 0) * 0.25).toFixed(4)),
                    }))
                  }
                  className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-700"
                >
                  25%
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setBuyConfig((prev) => ({
                      ...prev,
                      solAmount: Number(((walletBalanceSol ?? 0) * 0.9).toFixed(4)),
                    }))
                  }
                  className="px-2 py-1 rounded border border-gray-600 text-gray-200 hover:bg-gray-700"
                >
                  90%
                </button>
              </div>
              {connected && (
                <div className="mt-1 text-xs text-gray-400">
                  Wallet: {(walletBalanceSol ?? 0).toFixed(4)} SOL
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium">Fees (SOL)</label>
              <input
                type="number"
                min={0.001}
                max={1}
                step={0.001}
                value={buyConfig.fees}
                onChange={(e) =>
                  setBuyConfig((prev) => ({
                    ...prev,
                    fees: Number(e.target.value),
                  }))
                }
                className="mt-1 w-28 rounded border px-2 py-1 bg-black text-white"
              />
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
                            <span className="text-sm text-gray-600">
                              {buyConfig.solAmount} SOL
                            </span>
                            <button
                              onClick={() =>
                                void handleFastBuy(chart.tokenAddress, chart.tokenSymbol)
                              }
                              disabled={buyStates[chart.tokenAddress]?.loading}
                              className="px-3 py-1 rounded text-sm font-medium bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white cursor-pointer"
                              title={buyStates[chart.tokenAddress]?.error || "Fast buy"}
                            >
                              {buyStates[chart.tokenAddress]?.loading
                                ? "Buying…"
                                : buyStates[chart.tokenAddress]?.status || "Buy"}
                            </button>
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
                    signals.map((s) => (
                      <tr
                        key={`${s.token_address}-${s.last_updated_at || s.first_seen_at || "0"}`}
                        className="text-sm"
                      >
                        <td className="border-b p-2 relative">
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              className="font-medium text-blue-700 hover:underline"
                              onClick={() =>
                                setChartModalTokenAddress(s.token_address)
                              }
                            >
                              {s.token_symbol || "UNKNOWN"}
                            </button>
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
                            onClick={() =>
                              setChartModalTokenAddress(s.token_address)
                            }
                            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded font-medium transition-colors"
                            title="Open Chart & Buy"
                          >
                            Chart/Buy
                          </button>
                          <button
                            onClick={() =>
                              void handleFastBuy(s.token_address, s.token_symbol)
                            }
                            disabled={buyStates[s.token_address]?.loading}
                            className="px-3 py-1 rounded text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                            title={
                              buyStates[s.token_address]?.error ||
                              `Fast buy ${buyConfig.solAmount} SOL`
                            }
                          >
                            {buyStates[s.token_address]?.loading
                              ? "Buying…"
                              : buyStates[s.token_address]?.status || "Buy"}
                          </button>
                          <DlmmChartActions
                            tokenAddress={s.token_address}
                            tokenSymbol={s.token_symbol}
                            source="signals"
                          />
                        </td>
                      </tr>
                    ))
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
                    <span className="text-sm text-gray-600">
                      {buyConfig.solAmount} SOL
                    </span>
                    <button
                      onClick={() =>
                        void handleFastBuy(chart.tokenAddress, chart.tokenSymbol)
                      }
                      disabled={buyStates[chart.tokenAddress]?.loading}
                      className="px-3 py-1 rounded text-sm font-medium bg-green-500 hover:bg-green-600 disabled:opacity-50 text-white cursor-pointer"
                      title={buyStates[chart.tokenAddress]?.error || "Fast buy"}
                    >
                      {buyStates[chart.tokenAddress]?.loading
                        ? "Buying…"
                        : buyStates[chart.tokenAddress]?.status || "Buy"}
                    </button>
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
