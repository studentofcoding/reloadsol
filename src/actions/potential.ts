'use server';

import { updateTag } from 'next/cache';
import { requireActionSession } from './auth';
import { CACHE_TAGS } from '@/lib/cache-tags';
import {
  markTokenPotential,
  unmarkTokenPotential,
  toggleTokenPotential,
} from '@/utils/potential-list/service';
import type { DlmmPotentialSource } from '@/types/dlmm';
import type { AppNetwork } from '@/utils/app-network';
import { parseDbChain } from '@/utils/app-network-db';

const VALID_SOURCES: DlmmPotentialSource[] = [
  'signals',
  'live',
  'board',
  'tracker',
  'algo-dashboard',
  'algo-history',
  'dlmm-general',
];

export interface PotentialActionInput {
  tokenAddress: string;
  tokenSymbol?: string | null;
  source?: DlmmPotentialSource;
  notes?: string | null;
  chain?: AppNetwork;
}

function assertSource(
  source: DlmmPotentialSource | undefined,
): DlmmPotentialSource {
  if (source && VALID_SOURCES.includes(source)) return source;
  return 'signals';
}

export async function markPotential(input: PotentialActionInput) {
  const session = await requireActionSession();
  const tokenAddress = String(input.tokenAddress ?? '').trim();
  if (!tokenAddress) {
    throw new Error('tokenAddress is required');
  }

  const entry = await markTokenPotential({
    tokenAddress,
    tokenSymbol: input.tokenSymbol ?? null,
    source: assertSource(input.source),
    notes: input.notes ?? null,
    chain: parseDbChain(input.chain),
  });

  updateTag(CACHE_TAGS.potential);
  updateTag(CACHE_TAGS.signals);

  return { success: true as const, entry, potential: true as const };
}

export async function unmarkPotential(
  tokenAddress: string,
  chain: AppNetwork = 'sol',
) {
  const session = await requireActionSession();
  const address = String(tokenAddress ?? '').trim();
  if (!address) {
    throw new Error('tokenAddress is required');
  }

  await unmarkTokenPotential(address, parseDbChain(chain));

  updateTag(CACHE_TAGS.potential);
  updateTag(CACHE_TAGS.signals);

  return { success: true as const, potential: false as const };
}

export async function togglePotential(input: PotentialActionInput) {
  const session = await requireActionSession();
  const tokenAddress = String(input.tokenAddress ?? '').trim();
  if (!tokenAddress) {
    throw new Error('tokenAddress is required');
  }

  const potential = await toggleTokenPotential({
    tokenAddress,
    tokenSymbol: input.tokenSymbol ?? null,
    source: assertSource(input.source),
    notes: input.notes ?? null,
    chain: parseDbChain(input.chain),
  });

  updateTag(CACHE_TAGS.potential);
  updateTag(CACHE_TAGS.signals);

  return { success: true as const, potential };
}
