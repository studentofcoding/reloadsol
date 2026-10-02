'use client';

/**
 * Superseded by `useOpenPositions` — the single derivation of open positions.
 *
 * This module is now a re-export so the bar's import path keeps working. New callers should import
 * from `@/hooks/useOpenPositions`. The body and its comments live there, unchanged.
 */
export {
  useOpenPositions,
  useOpenPositions as useGlobalOpenPositionsBar,
  GLOBAL_OPEN_BAR_PRICES_KEY,
  OPEN_BAR_PRICE_POLL_MS,
} from './useOpenPositions';
