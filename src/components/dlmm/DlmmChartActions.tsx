'use client';

import React from 'react';
import type { DlmmPotentialSource } from '@/types/dlmm';
import { useDlmmChartActions } from '@/hooks/useDlmmChartActions';

type DlmmChartActionsProps = {
  tokenAddress: string;
  tokenSymbol?: string | null;
  source: DlmmPotentialSource;
  className?: string;
  layout?: 'inline' | 'stacked';
};

/** Toggle token on DLMM Potential watchlist or Rug exclusion list. */
export default function DlmmChartActions({
  tokenAddress,
  tokenSymbol,
  source,
  className = '',
  layout = 'inline',
}: DlmmChartActionsProps) {
  const { isInPotential, isRugged, markPotential, markRug, isPending } =
    useDlmmChartActions();
  const inPotential = isInPotential(tokenAddress);
  const rugged = isRugged(tokenAddress);

  const containerClass =
    layout === 'stacked'
      ? 'flex flex-col gap-1'
      : 'flex flex-wrap items-center gap-1';

  return (
    <div className={`${containerClass} ${className}`}>
      <button
        type="button"
        disabled={isPending}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          void markPotential({ tokenAddress, tokenSymbol, source });
        }}
        className={`rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
          inPotential
            ? 'bg-green-600 text-white border border-green-500'
            : 'bg-gray-800 text-green-300 hover:bg-green-900/40 border border-green-700/50'
        }`}
        title={
          inPotential
            ? 'Remove from DLMM Potential list'
            : 'Add to DLMM Potential list'
        }
      >
        {isPending ? '…' : inPotential ? 'Potential ✓' : 'Potential'}
      </button>
      <button
        type="button"
        disabled={isPending}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          void markRug({ tokenAddress, tokenSymbol, source });
        }}
        className={`rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
          rugged
            ? 'bg-red-700 text-white border border-red-500'
            : 'bg-gray-800 text-red-300 hover:bg-red-900/40 border border-red-700/50'
        }`}
        title={
          rugged
            ? 'Remove from DLMM Rug list'
            : 'Mark as Rug — excluded from DLMM lists'
        }
      >
        {isPending ? '…' : rugged ? 'Rug ✓' : 'Rug'}
      </button>
    </div>
  );
}
