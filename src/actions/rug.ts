'use server';

import { updateTag } from 'next/cache';
import { requireActionSession } from './auth';
import { CACHE_TAGS } from '@/lib/cache-tags';
import {
  markTokenRug,
  unmarkTokenRug,
  toggleTokenRug,
} from '@/utils/rug-list/service';
import type { TokenRugSource } from '@/types/rug-list';
import type { AppNetwork } from '@/utils/app-network';
import { parseDbChain } from '@/utils/app-network-db';

export interface RugActionInput {
  tokenAddress: string;
  tokenSymbol?: string | null;
  source?: TokenRugSource;
  chain?: AppNetwork;
}

export async function markAsRug(input: RugActionInput) {
  const session = await requireActionSession();
  const tokenAddress = String(input.tokenAddress ?? '').trim();
  if (!tokenAddress) {
    throw new Error('tokenAddress is required');
  }

  const entry = await markTokenRug({
    tokenAddress,
    tokenSymbol: input.tokenSymbol ?? null,
    source: input.source ?? 'board',
    chain: parseDbChain(input.chain),
  });

  updateTag(CACHE_TAGS.rug);
  updateTag(CACHE_TAGS.signals);

  return { success: true as const, entry };
}

export async function unmarkRug(
  tokenAddress: string,
  chain: AppNetwork = 'sol',
) {
  const session = await requireActionSession();
  const address = String(tokenAddress ?? '').trim();
  if (!address) {
    throw new Error('tokenAddress is required');
  }

  await unmarkTokenRug(address, parseDbChain(chain));

  updateTag(CACHE_TAGS.rug);
  updateTag(CACHE_TAGS.signals);

  return { success: true as const };
}

export async function toggleRug(input: RugActionInput) {
  const session = await requireActionSession();
  const tokenAddress = String(input.tokenAddress ?? '').trim();
  if (!tokenAddress) {
    throw new Error('tokenAddress is required');
  }

  const rugged = await toggleTokenRug({
    tokenAddress,
    tokenSymbol: input.tokenSymbol ?? null,
    source: input.source ?? 'board',
    chain: parseDbChain(input.chain),
  });

  updateTag(CACHE_TAGS.rug);
  updateTag(CACHE_TAGS.signals);

  return { success: true as const, rugged };
}
