import type { AppNetwork } from '@/utils/app-network'

/** Compact home: Solana pre-selects dust only; Robinhood pre-selects all sellable. */
export function compactDustOnlyDefault(chain: AppNetwork): boolean {
  return chain === 'sol'
}
