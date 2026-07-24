'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppNetwork } from '@/contexts/AppNetworkContext';
import type { TokenRugEntry, TokenRugSource } from '@/types/rug-list';
import type { AppNetwork } from '@/utils/app-network';

export const RUG_LIST_QUERY_KEY = ['rug-list'] as const;

async function fetchRugList(chain: AppNetwork): Promise<TokenRugEntry[]> {
  const res = await fetch(`/api/rug?chain=${encodeURIComponent(chain)}`);
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch rug list');
  }
  return data.entries as TokenRugEntry[];
}

export function useRugList() {
  const { network } = useAppNetwork();
  const queryClient = useQueryClient();
  const listKey = [...RUG_LIST_QUERY_KEY, network] as const;

  const query = useQuery({
    queryKey: listKey,
    queryFn: () => fetchRugList(network),
    refetchInterval: 30_000,
  });

  const addressSet = new Set((query.data ?? []).map((e) => e.token_address));

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: RUG_LIST_QUERY_KEY });

  const addMutation = useMutation({
    mutationFn: async (input: {
      tokenAddress: string;
      tokenSymbol?: string | null;
      source: TokenRugSource;
    }) => {
      const res = await fetch('/api/rug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenAddress: input.tokenAddress,
          tokenSymbol: input.tokenSymbol,
          source: input.source,
          chain: network,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to add to rug list');
      }
      return data.entry as TokenRugEntry;
    },
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: async (tokenAddress: string) => {
      const qs = new URLSearchParams({
        tokenAddress,
        chain: network,
      });
      const res = await fetch(`/api/rug?${qs}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to remove from rug list');
      }
    },
    onSuccess: invalidate,
  });

  const markRug = async (input: {
    tokenAddress: string;
    tokenSymbol?: string | null;
    source: TokenRugSource;
  }) => addMutation.mutateAsync(input);

  const unmarkRug = async (tokenAddress: string) =>
    removeMutation.mutateAsync(tokenAddress);

  const toggleRug = async (input: {
    tokenAddress: string;
    tokenSymbol?: string | null;
    source: TokenRugSource;
  }) => {
    if (addressSet.has(input.tokenAddress)) {
      await unmarkRug(input.tokenAddress);
      return false;
    }
    await markRug(input);
    return true;
  };

  return {
    entries: query.data ?? [],
    addressSet,
    isLoading: query.isLoading,
    isRugged: (tokenAddress: string) => addressSet.has(tokenAddress),
    markRug,
    unmarkRug,
    toggleRug,
    isPending: addMutation.isPending || removeMutation.isPending,
    invalidate,
  };
}

/** @deprecated Use useRugList */
export function useDlmmRugList() {
  return useRugList();
}
