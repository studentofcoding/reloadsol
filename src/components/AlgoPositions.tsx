"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { OptimizedImage } from "@/components/OptimizedImage";
import type { AlgoPosition } from "@/strategies/algo-positions";
import {
  fetchTokenMetadataBatch,
  type TokenDisplayMeta,
} from "@/utils/token-metadata-client";
import { useAppNetwork } from "@/contexts/AppNetworkContext";

type PositionsResponse = {
  success: boolean;
  open: AlgoPosition[];
  closed: AlgoPosition[];
};

function formatPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

function formatMcap(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function formatPnl(pnlPct: number | null): {
  text: string;
  className: string;
} {
  if (pnlPct == null || !Number.isFinite(pnlPct)) {
    return { text: "—", className: "text-gray-400" };
  }
  const className =
    pnlPct > 0 ? "text-green-400" : pnlPct < 0 ? "text-red-400" : "text-gray-400";
  return { text: `${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(1)}%`, className };
}

function formatOpenRelative(isoOrTs: string): string {
  const ts = Date.parse(isoOrTs);
  if (!Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function PositionCard({
  position,
  meta,
}: {
  position: AlgoPosition;
  meta?: TokenDisplayMeta;
}) {
  const symbol = position.tokenSymbol ?? meta?.symbol ?? null;
  const name = position.tokenName ?? meta?.name ?? null;
  const logo = position.logoUrl ?? meta?.logoURI ?? null;
  const display =
    symbol ??
    name ??
    (position.tokenAddress ? `${position.tokenAddress.slice(0, 6)}…` : "Unknown");
  const pnl = formatPnl(position.pnlPct);

  return (
    <div className="p-3 bg-gray-800/60 border border-gray-700 rounded-lg">
      {/* PnL */}
      <div className={`text-sm font-semibold mb-2 ${pnl.className}`}>
        {pnl.text}
        {position.status === "closed" && position.outcome && (
          <span className="ml-2 text-[10px] uppercase text-gray-500">
            {position.outcome}
          </span>
        )}
      </div>

      {/* Token */}
      <div className="flex items-center space-x-2 mb-2">
        <div className="w-4 h-4 bg-gray-700 rounded-full flex items-center justify-center text-white text-xs font-bold overflow-hidden border border-gray-600">
          {logo ? (
            <OptimizedImage
              src={logo}
              alt={display}
              className="w-full h-full object-cover"
              fallback={display.charAt(0).toUpperCase()}
            />
          ) : (
            display.charAt(0).toUpperCase()
          )}
        </div>
        <span
          className="text-xs text-gray-300 font-medium truncate"
          title={position.tokenAddress ?? undefined}
        >
          {display}
        </span>
      </div>

      {/* Entry: mcap for mcap_tracker, price for everything else */}
      <div className="text-xs text-gray-400 mb-2">
        {position.domain === "mcap_tracker" ? (
          <>
            <span className="text-gray-500">Entry MCap: </span>
            <span className="text-gray-300">
              {formatMcap(position.entryMcap)}
            </span>
            {position.status === "closed" && position.exitMcap != null && (
              <>
                <span className="text-gray-500"> → </span>
                <span className="text-gray-300">
                  {formatMcap(position.exitMcap)}
                </span>
              </>
            )}
          </>
        ) : (
          <>
            <span className="text-gray-500">Buy Price: </span>
            <span className="text-gray-300">
              {formatPrice(position.entryPriceUsd)}
            </span>
            {position.status === "closed" && position.exitPriceUsd != null && (
              <>
                <span className="text-gray-500"> → </span>
                <span className="text-gray-300">
                  {formatPrice(position.exitPriceUsd)}
                </span>
              </>
            )}
          </>
        )}
        {position.entryAt && (
          <span
            className="text-gray-500 ml-2"
            title={new Date(position.entryAt).toLocaleString()}
          >
            · {formatOpenRelative(position.entryAt)}
          </span>
        )}
      </div>

      {/* Badges: strategy + sim/real */}
      <div className="flex flex-wrap items-center gap-1">
        <span
          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-900/40 text-blue-300 border border-blue-700/40 truncate max-w-[10rem]"
          title={`${position.domain} / ${position.strategyId}`}
        >
          {position.strategyName}
        </span>
        {position.isSimulated ? (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-900/40 text-yellow-300 border border-yellow-700/40">
            SIM
          </span>
        ) : (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-900/40 text-green-300 border border-green-700/40">
            REAL
          </span>
        )}
      </div>
    </div>
  );
}

export default function AlgoPositions() {
  const [tab, setTab] = useState<"open" | "closed">("open");
  const { network } = useAppNetwork();

  const { data, isLoading, error } = useQuery<PositionsResponse>({
    queryKey: ["algo-positions", network],
    queryFn: async () => {
      const response = await fetch(
        `/api/strategies/positions?limit=100&chain=${network}`,
      );
      if (!response.ok) throw new Error(`Positions fetch failed (${response.status})`);
      return response.json();
    },
    refetchInterval: 30_000,
  });

  const open = useMemo(() => data?.open ?? [], [data]);
  const closed = useMemo(() => data?.closed ?? [], [data]);
  const positions = tab === "open" ? open : closed;

  // Resolve missing symbols/icons in one batch call
  const missingMints = useMemo(
    () =>
      [...open, ...closed]
        .filter((p) => p.tokenAddress && (!p.tokenSymbol || !p.logoUrl))
        .map((p) => p.tokenAddress as string),
    [open, closed],
  );

  const { data: metaMap } = useQuery({
    queryKey: ["algo-positions-meta", missingMints.join(",")],
    queryFn: () => fetchTokenMetadataBatch(missingMints),
    enabled: missingMints.length > 0,
    staleTime: 10 * 60 * 1000,
  });

  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Algo Strategies</h3>
        <div className="flex rounded-lg overflow-hidden border border-gray-700">
          <button
            onClick={() => setTab("open")}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              tab === "open"
                ? "bg-gray-700 text-white"
                : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            Open ({open.length})
          </button>
          <button
            onClick={() => setTab("closed")}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              tab === "closed"
                ? "bg-gray-700 text-white"
                : "bg-gray-800 text-gray-400 hover:text-white"
            }`}
          >
            Closed ({closed.length})
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-400 py-6 text-center">
          Loading algo positions…
        </div>
      ) : error ? (
        <div className="text-sm text-red-400 py-6 text-center">
          Failed to load algo positions
        </div>
      ) : positions.length === 0 ? (
        <div className="text-sm text-gray-500 py-6 text-center">
          No {tab} algo positions
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {positions.map((position) => (
            <PositionCard
              key={position.id}
              position={position}
              meta={
                position.tokenAddress
                  ? metaMap?.get(position.tokenAddress)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
