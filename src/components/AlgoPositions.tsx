"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { OptimizedImage } from "@/components/OptimizedImage";
import type { AlgoPosition } from "@/strategies/algo-positions";
import {
  fetchTokenMetadataBatch,
  type TokenDisplayMeta,
} from "@/utils/token-metadata-client";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import Link from "next/link";
import {
  filterAlgoPositions,
  openPositionsEmptyCopy,
  positionDeskHref,
  type AlgoTesterSimulated,
} from "@/components/algo-tester/algo-tester-query";

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

export function PositionCard({
  position,
  meta,
  showDeskLink = false,
}: {
  position: AlgoPosition;
  meta?: TokenDisplayMeta;
  showDeskLink?: boolean;
}) {
  const symbol = position.tokenSymbol ?? meta?.symbol ?? null;
  const name = position.tokenName ?? meta?.name ?? null;
  const logo = position.logoUrl ?? meta?.logoURI ?? null;
  const display =
    symbol ??
    name ??
    (position.tokenAddress ? `${position.tokenAddress.slice(0, 6)}…` : "Unknown");
  const pnl = formatPnl(position.pnlPct);
  const deskHref = showDeskLink ? positionDeskHref(position) : null;

  return (
    <div className="p-3 bg-gray-800/60 border border-gray-700 rounded-lg">
      <div className={`text-sm font-semibold mb-2 ${pnl.className}`}>
        {pnl.text}
        {position.status === "closed" && position.outcome && (
          <span className="ml-2 text-xs uppercase text-gray-500">
            {position.outcome}
          </span>
        )}
      </div>

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

      <div className="flex flex-wrap items-center gap-1">
        <span
          className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-900/40 text-blue-300 border border-blue-700/40 truncate max-w-[10rem]"
          title={`${position.domain} / ${position.strategyId}`}
        >
          {position.strategyName}
        </span>
        {position.isSimulated ? (
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-yellow-900/40 text-yellow-300 border border-yellow-700/40">
            SIM
          </span>
        ) : (
          <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-green-900/40 text-green-300 border border-green-700/40">
            REAL
          </span>
        )}
        {deskHref ? (
          <Link
            href={deskHref}
            className="px-1.5 py-0.5 rounded text-xs font-medium text-blue-400 hover:text-blue-300 underline"
          >
            {position.domain === "dlmm"
              ? "DLMM"
              : position.domain === "social"
                ? "Social"
                : "Tracker"}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function AlgoOpenPositionsTab({
  domain,
  strategyId,
  simulated,
  tokenAddress,
}: {
  domain?: string;
  strategyId?: string;
  simulated?: AlgoTesterSimulated;
  tokenAddress?: string;
}) {
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

  const open = useMemo(
    () =>
      filterAlgoPositions(data?.open ?? [], {
        domain,
        strategyId,
        simulated,
        tokenAddress,
      }),
    [data?.open, domain, strategyId, simulated, tokenAddress],
  );

  const missingMints = useMemo(
    () =>
      open
        .filter((p) => p.tokenAddress && (!p.tokenSymbol || !p.logoUrl))
        .map((p) => p.tokenAddress as string),
    [open],
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
        <h3 className="text-lg font-semibold text-white">Open positions</h3>
        <span className="text-xs text-gray-500">{open.length} open</span>
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-400 py-6 text-center">
          Loading algo positions…
        </div>
      ) : error ? (
        <div className="text-sm text-red-400 py-6 text-center">
          Failed to load algo positions
        </div>
      ) : open.length === 0 ? (
        <div className="text-sm text-gray-500 py-6 text-center">
          {openPositionsEmptyCopy({ domain, strategyId, simulated, tokenAddress })}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {open.map((position) => (
            <PositionCard
              key={position.id}
              position={position}
              showDeskLink
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

/** PnL shrink: counts + link-out. Desk of record is Algo Tester. */
export default function AlgoPositions() {
  const { network } = useAppNetwork();
  const { data, isLoading } = useQuery<PositionsResponse>({
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

  const openCount = data?.open?.length ?? 0;
  const closedCount = data?.closed?.length ?? 0;

  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-white">Algo strategies</h3>
        <p className="text-xs text-gray-500">
          {isLoading
            ? "Loading counts…"
            : `${openCount} open · ${closedCount} closed`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Link
          href="/dev/algo-tester?tab=open"
          className="text-blue-400 hover:text-blue-300 underline"
        >
          Open on Algo Tester
        </Link>
        <Link
          href="/dev/algo-tester?tab=closed"
          className="text-gray-400 hover:text-gray-200 underline"
        >
          Closed reports
        </Link>
      </div>
    </div>
  );
}
