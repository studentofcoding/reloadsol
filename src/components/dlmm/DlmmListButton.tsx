'use client';

import React from 'react';
import type { DlmmPotentialSource } from '@/types/dlmm';
import { useDlmmPotentialList } from '@/hooks/useDlmmPotentialList';

type DlmmListButtonProps = {
  tokenAddress: string;
  tokenSymbol?: string | null;
  source: DlmmPotentialSource;
  className?: string;
  title?: string;
};

/** Toggle token on the DLMM Potential watchlist. */
export default function DlmmListButton({
  tokenAddress,
  tokenSymbol,
  source,
  className = '',
  title,
}: DlmmListButtonProps) {
  const { isInList, toggle, isPending } = useDlmmPotentialList();
  const inList = isInList(tokenAddress);

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        void toggle({ tokenAddress, tokenSymbol, source });
      }}
      className={`rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
        inList
          ? 'bg-purple-700 text-white hover:bg-purple-600 border border-purple-500'
          : 'bg-gray-800 text-purple-300 hover:bg-purple-900/40 border border-purple-700/50'
      } ${className}`}
      title={
        title ??
        (inList
          ? 'Remove from DLMM Potential list'
          : 'Add to DLMM Potential list')
      }
    >
      {isPending ? '…' : inList ? 'DLMM ✓' : 'DLMM+'}
    </button>
  );
}
