'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { OptimizedImage } from '@/components/OptimizedImage';
import { useGlobalWatchlist } from '@/hooks/useGlobalWatchlist';

function formatPct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

function pctColor(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value) || value === 0) return 'text-gray-400';
  return value > 0 ? 'text-green-400' : 'text-red-400';
}

export default function GlobalWatchlistBar() {
  const router = useRouter();
  const { entries, priceChangePct, remove, isPending, walletConnected } =
    useGlobalWatchlist();

  if (!walletConnected || entries.length === 0) {
    return null;
  }

  return (
    <div className="w-full min-h-[40px] mb-2">
      <div className="flex max-w-6xl mx-auto items-center gap-2 overflow-x-auto px-2 py-1.5 flex-nowrap scrollbar-thin">
        {entries.map((entry) => {
          const symbol =
            entry.token_symbol ?? entry.token_address.slice(0, 6);
          const logoUrl = entry.logo_url;
          const pct = priceChangePct[entry.token_address];

          return (
            <div
              key={entry.id}
              className="flex items-center gap-1.5 shrink-0 rounded-md bg-gray-900/70 border border-gray-700 px-2 py-1"
            >
              <button
                type="button"
                onClick={() => router.push(`/chart/${entry.token_address}`)}
                className="flex items-center gap-1.5 min-h-[28px] hover:opacity-90"
                title={`Open ${symbol} chart`}
              >
                {logoUrl ? (
                  <OptimizedImage
                    src={logoUrl}
                    alt={symbol}
                    width={24}
                    height={24}
                    className="w-6 h-6 rounded-full"
                  />
                ) : (
                  <span className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center text-[10px] text-gray-300">
                    {symbol.slice(0, 2).toUpperCase()}
                  </span>
                )}
                <span className="text-xs font-medium text-white max-w-[72px] truncate">
                  {symbol}
                </span>
                <span className={`text-xs font-semibold tabular-nums ${pctColor(pct)}`}>
                  {formatPct(pct)}
                </span>
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(entry.token_address);
                }}
                className="min-w-[28px] min-h-[28px] flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 rounded disabled:opacity-50"
                title="Remove from watchlist"
                aria-label={`Remove ${symbol} from watchlist`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
