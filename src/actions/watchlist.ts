'use server';

import { requireActionSession } from './auth';
import {
  addWatchlistEntry,
  removeWatchlistEntry,
} from '@/utils/watchlist/db';
import { parseDbChain } from '@/utils/app-network-db';
import type { AppNetwork } from '@/utils/app-network';

export interface WatchlistAddInput {
  tokenAddress: string;
  tokenSymbol?: string | null;
  logoUrl?: string | null;
  initialPrice?: number | null;
  chain?: AppNetwork;
}

export async function addToWatchlist(input: WatchlistAddInput) {
  const session = await requireActionSession();
  const chain = parseDbChain(input.chain);

  const tokenAddress = String(input.tokenAddress ?? '').trim();
  if (!tokenAddress) {
    throw new Error('tokenAddress is required');
  }

  const initialPriceUsd =
    input.initialPrice != null && Number(input.initialPrice) > 0
      ? Number(input.initialPrice)
      : null;

  const entry = await addWatchlistEntry({
    wallet_address: session.address,
    token_address: tokenAddress,
    token_symbol: input.tokenSymbol ? String(input.tokenSymbol) : null,
    logo_url: input.logoUrl ? String(input.logoUrl) : null,
    initial_price_usd: initialPriceUsd,
    chain,
  });

  // Client React Query owns the list cache — no updateTag (avoids full-page refresh).
  return { success: true as const, entry };
}

export async function removeFromWatchlist(
  tokenAddress: string,
  chain: AppNetwork = 'sol',
) {
  const session = await requireActionSession();
  const resolvedChain = parseDbChain(chain);

  const address = String(tokenAddress ?? '').trim();
  if (!address) {
    throw new Error('tokenAddress is required');
  }

  await removeWatchlistEntry(session.address, address, resolvedChain);

  return { success: true as const };
}
