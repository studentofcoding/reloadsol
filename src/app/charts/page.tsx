"use client";

import React, {
  useMemo,
  useState,
  useEffect,
  Suspense,
  useCallback,
} from "react";
import { useSearchParams, usePathname, useRouter } from "next/navigation";
import { useWallet, useConnection } from "@/components/WalletProvider";
import { executeBulkBuy } from "@/utils/jupiter";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { trackBuy } from "@/utils/operations-api";
import { useTradingData } from "@/components/TradingDataProvider";
import { getSolPriceUSD } from "@/utils/solana";
import { fetchTokenPricesForTracking } from "@/utils/trading-tracker";
import { BulkBuyRequest } from "@/types";
import {
  DndContext,
  DragEndEvent,
  useDraggable,
  useDroppable,
  DragOverlay,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { calculateWeightedDistribution } from "@/utils/position-sizing";
import html2canvas from "html2canvas";

// --- Types & Constants ---

type SectionType = "watching" | "potential" | "rugged";

interface SignalData {
  token_address: string;
  label: string;
  market_cap: number;
  price: number;
  initial_price: number;
  token_symbol?: string;
  result?: any;
  image_reference?: string;
}

const SECTIONS: { id: SectionType; title: string; color: string }[] = [
  { id: "watching", title: "Unlabeled / Watching", color: "border-gray-600" },
  { id: "potential", title: "Potential", color: "border-green-600" },
  { id: "rugged", title: "Rugged", color: "border-red-600" },
];

function parseAddresses(param: string | null): string[] {
  if (!param) return [];
  return param
    .split(/[|,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- Screen Capture Helper ---
async function captureElementWithScreenShare(
  elementId: string,
): Promise<string> {
  try {
    // Prompt user to select the current tab
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "browser",
      } as any,
      audio: false,
    });

    const video = document.createElement("video");
    video.style.position = "fixed";
    video.style.top = "-10000px";
    video.style.left = "-10000px";
    document.body.appendChild(video);

    video.srcObject = stream;
    await video.play();

    // Wait for video to stabilize
    await new Promise((resolve) => setTimeout(resolve, 500));

    const element = document.getElementById(elementId);
    if (!element) {
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
      throw new Error("Element not found");
    }

    const rect = element.getBoundingClientRect();

    const canvas = document.createElement("canvas");
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      stream.getTracks().forEach((t) => t.stop());
      video.remove();
      throw new Error("Canvas context failed");
    }

    // Calculate scaling (Video dimensions vs Viewport dimensions)
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const vW = settings.width || video.videoWidth;
    const vH = settings.height || video.videoHeight;
    const clientW = window.innerWidth;
    const clientH = window.innerHeight;

    const scaleX = vW / clientW;
    const scaleY = vH / clientH;

    ctx.drawImage(
      video,
      rect.left * scaleX,
      rect.top * scaleY,
      rect.width * scaleX,
      rect.height * scaleY,
      0,
      0,
      rect.width,
      rect.height,
    );

    stream.getTracks().forEach((t) => t.stop());
    video.remove();

    return canvas.toDataURL("image/png");
  } catch (err) {
    console.error("Screen capture error:", err);
    throw err;
  }
}

// --- Draggable Card Component ---

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
    interval,
    isDraggingGlobal,
    buyState,
    onBuy,
    onEnd,
    onRemove,
    onMove,
    showMoveButtons,
  }: any) => {
    return (
      <DraggableCard
        id={addr}
        onRemove={onRemove ? () => onRemove(addr) : undefined}
      >
        <div className="flex-1">
          <div className="text-sm font-medium text-white mb-1">
            {symbol || addr.slice(0, 8) + "..."}
            <a
              href={`/chart/${addr}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 text-xs text-blue-400 hover:underline"
            >
              Open
            </a>
          </div>

          <div className="relative h-[200px] w-full bg-black">
            <iframe
              src={`https://www.gmgn.cc/kline/sol/${addr}?interval=${interval}`}
              title={`Chart ${addr}`}
              className={`w-full h-full ${isDraggingGlobal ? "pointer-events-none" : ""}`}
              frameBorder={0}
              allowFullScreen
            />
          </div>

          <div className="mt-2 flex gap-2">
            <button
              className={`flex-1 px-2 py-1 text-xs rounded text-white font-medium ${
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
              className="px-2 py-1 text-xs rounded text-white font-medium bg-purple-600 hover:bg-purple-500"
              onClick={() => onEnd(addr)}
              title="End Tracking (Save Result)"
            >
              End
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

function PreviewModal({ isOpen, onClose, onSave, onRetake, data }: any) {
  if (!isOpen || !data) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-6 max-w-2xl w-full shadow-2xl">
        <h2 className="text-xl font-bold mb-4 text-white">Confirm Result</h2>

        <div className="mb-4 bg-gray-900 rounded-lg overflow-hidden border border-gray-700 flex justify-center bg-[#1f2937]">
          {data.imageBase64 ? (
            <img
              src={data.imageBase64}
              alt="Result"
              className="max-w-full max-h-[50vh] object-contain"
            />
          ) : (
            <div className="p-10 text-gray-500">No Image Captured</div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-700/50 p-3 rounded">
            <div className="text-gray-400 text-xs">Initial</div>
            <div className="text-white font-mono">
              ${data.result.initial_price?.toFixed(6)}
            </div>
          </div>
          <div className="bg-gray-700/50 p-3 rounded">
            <div className="text-gray-400 text-xs">Final</div>
            <div className="text-white font-mono">
              ${data.result.final_price?.toFixed(6)}
            </div>
          </div>
          <div
            className={`p-3 rounded border ${data.result.pnl_percentage >= 0 ? "bg-green-900/20 border-green-800" : "bg-red-900/20 border-red-800"}`}
          >
            <div className="text-gray-400 text-xs">PnL</div>
            <div
              className={`font-bold font-mono ${data.result.pnl_percentage >= 0 ? "text-green-400" : "text-red-400"}`}
            >
              {data.result.pnl_percentage > 0 ? "+" : ""}
              {data.result.pnl_percentage}%
            </div>
          </div>
        </div>

        <div className="flex justify-between gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-medium transition-colors"
          >
            Cancel
          </button>
          <div className="flex gap-3">
            <button
              onClick={onRetake}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded-lg font-medium transition-colors"
            >
              Retake (Screen Share)
            </button>
            <button
              onClick={onSave}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
            >
              Approve & Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Main Content Component ---

function ChartsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const urlAddresses = useMemo(
    () => parseAddresses(searchParams.get("addresses")),
    [searchParams],
  );
  const interval = searchParams.get("interval") || "5";

  // State
  const [columns, setColumns] = useState<Record<SectionType, string[]>>({
    watching: [],
    potential: [],
    rugged: [],
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
  const { trackOperation } = useTradingData();
  const [buyAmount, setBuyAmount] = useState("0.1");
  const [buyStates, setBuyStates] = useState<
    Record<string, { loading: boolean; status?: string; error?: string }>
  >({});

  // State for Potential Bulk Buy
  const [potentialSolAmount, setPotentialSolAmount] = useState<string>("1.0");
  const [isBuyingPotential, setIsBuyingPotential] = useState(false);

  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [previewData, setPreviewData] = useState<{
    tokenAddress: string;
    result: any;
    imageBase64: string;
  } | null>(null);

  // 1. Fetch initial data from API

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        // Fetch all labeled tokens from server
        const res = await fetch("/api/signals");
        const json = await res.json();

        if (!json.success) throw new Error(json.error);

        const dbTokens: any[] = json.data || [];

        // Categorize DB tokens
        const newCols: Record<SectionType, string[]> = {
          watching: [],
          potential: [],
          rugged: [],
        };
        const mcaps: Record<string, number> = {};
        const signalsMap: Record<string, SignalData> = {};

        const seen = new Set<string>();

        dbTokens.forEach((t) => {
          const label = (t.label || "watching") as SectionType;
          if (newCols[label]) {
            newCols[label].push(t.token_address);
            seen.add(t.token_address);
            if (t.mcap) mcaps[t.token_address] = t.mcap;
            signalsMap[t.token_address] = t;
          }
        });

        // Merge URL tokens (treat as watching if not in DB)
        urlAddresses.forEach((addr) => {
          if (!seen.has(addr)) {
            newCols.watching.push(addr);
            seen.add(addr);
            // Optionally: we could auto-save these to DB as 'watching'
            // but let's wait for user interaction to persist
          }
        });

        if (mounted) {
          setColumns(newCols);
          setTokenMcaps(mcaps);
          setSignals(signalsMap);
          setIsLoaded(true);
        }
      } catch (e) {
        console.error("Failed to load tokens", e);
        if (mounted) setStatus("Failed to load saved tokens");
      }
    }

    init();

    return () => {
      mounted = false;
    };
  }, [urlAddresses.join(",")]); // Re-run if URL params change (e.g. navigation)

  const handleBuyPotential = async () => {
    const potentialTokens = columns.potential;
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

    setIsBuyingPotential(true);
    setStatus("Calculating weighted distribution...");

    try {
      // 1. Refresh MCaps for potential tokens to ensure accuracy
      // (Using stored mcaps for now, ideally we fetch fresh ones)
      // We can use fetchTokenPricesForTracking if it returns mcap, but it returns price.
      // For now, rely on what we have + maybe re-fetch if needed.
      // Let's assume stored mcaps are relatively fresh or fallback to default weighting if missing.

      const weightingInput = potentialTokens.map((addr) => ({
        address: addr,
        marketCap: tokenMcaps[addr] || 0, // Default to 0 (lowest weight) if missing
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
            // Track it
            trackBuy(publicKey.toString(), 1, {
              failureCount: 0,
              solAmount: item.solAmount,
              tokenMints: [item.address],
              signatures: result.signatures,
            });
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
  }, [columns]);

  // Move token helper
  const moveToken = async (
    tokenAddress: string,
    targetSection: SectionType,
  ) => {
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
      await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tokenAddress, label: targetSection }),
      });
    } catch (e) {
      console.error("Failed to save move", e);
      setStatus("Failed to save change to server");
    }
  };

  // Handle Drag End
  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as SectionType; // The column ID

    moveToken(activeId, overId);
  };

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
        setBuyStates((prev) => ({
          ...prev,
          [tokenAddress]: {
            loading: false,
            error: err instanceof Error ? err.message : "Failed",
          },
        }));
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
    ],
  );

  const handleEndTracking = useCallback(
    async (tokenAddress: string) => {
      const cardElement = document.getElementById(`card-${tokenAddress}`);
      if (!cardElement) return;

      // Use cursor to indicate loading without triggering re-render
      document.body.style.cursor = "wait";

      try {
        // Capture screenshot (ignoring iframe content due to CORS)
        const canvas = await html2canvas(cardElement, {
          useCORS: true,
          allowTaint: true,
          backgroundColor: "#1f2937",
          ignoreElements: (element) => element.tagName === "IFRAME",
        });
        const imageBase64 = canvas.toDataURL("image/png");

        // Calculate PnL
        const signal = signals[tokenAddress];
        const initialPrice = signal?.initial_price || 0;

        // Fetch fresh price
        const prices = await fetchTokenPricesForTracking([tokenAddress]);
        const currentPrice = prices[tokenAddress] || 0;

        const pnl =
          initialPrice > 0
            ? ((currentPrice - initialPrice) / initialPrice) * 100
            : 0;

        const result = {
          end_time: new Date().toISOString(),
          initial_price: initialPrice,
          final_price: currentPrice,
          pnl_percentage: parseFloat(pnl.toFixed(2)),
        };

        setPreviewData({
          tokenAddress,
          result,
          imageBase64,
        });
        setPreviewModalOpen(true);
      } catch (e) {
        console.error("End tracking failed", e);
        setStatus("Failed to save result");
      } finally {
        document.body.style.cursor = "default";
      }
    },
    [signals],
  );

  const handleRetakeCapture = async () => {
    if (!previewData?.tokenAddress) return;

    try {
      setStatus("Select 'This Tab' to capture...");
      const imageBase64 = await captureElementWithScreenShare(
        `card-${previewData.tokenAddress}`,
      );
      setPreviewData((prev) => (prev ? { ...prev, imageBase64 } : null));
      setStatus("Capture updated!");
      setTimeout(() => setStatus(""), 2000);
    } catch (e) {
      console.error("Retake failed", e);
      setStatus("Capture cancelled or failed");
    }
  };

  const handleSaveResult = async () => {
    if (!previewData) return;

    setStatus("Saving result...");
    try {
      await fetch("/api/signals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenAddress: previewData.tokenAddress,
          result: previewData.result,
          imageReference: previewData.imageBase64,
        }),
      });

      setStatus("Tracking ended & saved!");
      setPreviewModalOpen(false);
      setPreviewData(null);
      setTimeout(() => setStatus(""), 3000);
    } catch (e) {
      console.error("Save failed", e);
      setStatus("Failed to save result");
    }
  };

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
      await fetch(`/api/signals?tokenAddress=${tokenAddress}`, {
        method: "DELETE",
      });
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
          body: JSON.stringify({ tokenAddress: addr, label: "watching" }),
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
  const onEnd = useCallback(
    (id: string) => handleEndTracking(id),
    [handleEndTracking],
  );
  const onRemove = useCallback((id: string) => handleRemove(id), []);
  const onMove = useCallback(
    (id: string, target: SectionType) => moveToken(id, target),
    [moveToken],
  );

  const renderCard = useCallback(
    (addr: string) => (
      <ChartItem
        key={addr}
        addr={addr}
        symbol={symbols[addr]}
        interval={interval}
        isDraggingGlobal={isDraggingGlobal}
        buyState={buyStates[addr]}
        onBuy={onBuy}
        onEnd={onEnd}
        onRemove={onRemove}
        onMove={onMove}
        showMoveButtons={columns.watching.includes(addr)}
      />
    ),
    [
      symbols,
      interval,
      isDraggingGlobal,
      buyStates,
      columns.watching,
      onBuy,
      onEnd,
      onRemove,
      onMove,
    ],
  );

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Chart Tracker</h1>

          <div className="flex items-center gap-4">
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
            {status}
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
                items={columns[section.id]}
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

        <PreviewModal
          isOpen={previewModalOpen}
          data={previewData}
          onClose={() => setPreviewModalOpen(false)}
          onRetake={handleRetakeCapture}
          onSave={handleSaveResult}
        />
      </div>
    </div>
  );
}

export default function MultiChartsPage() {
  return (
    <Suspense fallback={<div className="p-4 text-center">Loading...</div>}>
      <ChartsContent />
    </Suspense>
  );
}
