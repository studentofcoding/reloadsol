'use client';

import React from 'react';
import { useGlobalWatchlist } from '@/hooks/useGlobalWatchlist';

type GlobalWatchlistButtonProps = {
  tokenAddress: string;
  tokenSymbol?: string | null;
  logoUrl?: string | null;
  initialPrice?: number | null;
  className?: string;
};

/** Toggle token on the wallet-scoped global watchlist (nav bar). */
export default function GlobalWatchlistButton({
  tokenAddress,
  tokenSymbol,
  logoUrl,
  initialPrice,
  className = '',
}: GlobalWatchlistButtonProps) {
  const { isInList, toggle, isPending, walletConnected } = useGlobalWatchlist();
  const inList = isInList(tokenAddress);

  if (!walletConnected) {
    return null;
  }

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void toggle({ tokenAddress, tokenSymbol, logoUrl, initialPrice });
      }}
      className={`rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
        inList
          ? 'bg-amber-600 text-white border border-amber-500'
          : 'bg-gray-800 text-amber-300 hover:bg-amber-900/40 border border-amber-700/50'
      } ${className}`}
      title={inList ? 'Remove from watchlist' : 'Add to watchlist'}
    >
      {isPending ? '…' : inList ? 'Watchlist ✓' : 'Watchlist'}
    </button>
  );
}
