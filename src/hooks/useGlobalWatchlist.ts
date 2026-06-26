'use client';

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useWalletAddress } from '@/components/WalletProvider';
import type { WalletWatchlistEntry } from '@/types/watchlist';
import {
  readWatchlistCache,
  writeWatchlistCache,
} from '@/utils/watchlist/local-cache';
import { pctFromBaseline } from '@/utils/watchlist/pct';

export const GLOBAL_WATCHLIST_QUERY_KEY = 'global-watchlist';
export const GLOBAL_WATCHLIST_PRICES_KEY = 'global-watchlist-prices';

async function fetchWatchlist(): Promise<WalletWatchlistEntry[]> {
  const res = await fetch('/api/watchlist');
  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch watchlist');
  }
  return data.entries as WalletWatchlistEntry[];
}

async function fetchTokenPrices(
  tokenAddresses: string[],
): Promise<Record<string, number>> {
  if (tokenAddresses.length === 0) return {};
  const res = await fetch(
    `/api/tokens/prices?tokens=${encodeURIComponent(tokenAddresses.join(','))}`,
  );
  if (!res.ok) {
    throw new Error('Failed to fetch token prices');
  }
  const data = await res.json();
  return (data.prices ?? {}) as Record<string, number>;
}

type WatchlistMutationInput = {
  tokenAddress: string;
  tokenSymbol?: string | null;
  logoUrl?: string | null;
  initialPrice?: number | null;
};

export function useGlobalWatchlist() {
  const walletAddress = useWalletAddress();
  const queryClient = useQueryClient();
  const enabled = !!walletAddress;

  const listQuery = useQuery({
    queryKey: [GLOBAL_WATCHLIST_QUERY_KEY, walletAddress],
    queryFn: async () => {
      const entries = await fetchWatchlist();
      if (walletAddress) {
        writeWatchlistCache(walletAddress, entries);
      }
      return entries;
    },
    enabled,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    placeholderData: () =>
      walletAddress ? readWatchlistCache(walletAddress) : [],
  });

  const entries = listQuery.data ?? [];
  const tokenAddresses = entries.map((e) => e.token_address);
  const mintsKey = tokenAddresses.join(',');

  const pricesQuery = useQuery({
    queryKey: [GLOBAL_WATCHLIST_PRICES_KEY, walletAddress, mintsKey],
    queryFn: () => fetchTokenPrices(tokenAddresses),
    enabled: enabled && tokenAddresses.length > 0,
    staleTime: 55_000,
    refetchInterval: 60_000,
  });

  const currentPrices = pricesQuery.data ?? {};

  const priceChangePct = useMemo(() => {
    const result: Record<string, number | null> = {};
    for (const entry of entries) {
      result[entry.token_address] = pctFromBaseline(
        entry.initial_price_usd,
        currentPrices[entry.token_address],
      );
    }
    return result;
  }, [entries, currentPrices]);

  const addressSet = new Set(tokenAddresses);

  const syncListCache = (nextEntries: WalletWatchlistEntry[]) => {
    queryClient.setQueryData(
      [GLOBAL_WATCHLIST_QUERY_KEY, walletAddress],
      nextEntries,
    );
    if (walletAddress) {
      writeWatchlistCache(walletAddress, nextEntries);
    }
  };

  const invalidateList = () => {
    queryClient.invalidateQueries({
      queryKey: [GLOBAL_WATCHLIST_QUERY_KEY, walletAddress],
    });
  };

  const addMutation = useMutation({
    mutationFn: async (input: WatchlistMutationInput) => {
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenAddress: input.tokenAddress,
          tokenSymbol: input.tokenSymbol,
          logoUrl: input.logoUrl,
          initialPrice: input.initialPrice,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to add to watchlist');
      }
      return data.entry as WalletWatchlistEntry;
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({
        queryKey: [GLOBAL_WATCHLIST_QUERY_KEY, walletAddress],
      });
      const previous = queryClient.getQueryData<WalletWatchlistEntry[]>([
        GLOBAL_WATCHLIST_QUERY_KEY,
        walletAddress,
      ]);

      const optimistic: WalletWatchlistEntry = {
        id: `optimistic-${input.tokenAddress}`,
        wallet_address: walletAddress ?? '',
        token_address: input.tokenAddress,
        token_symbol: input.tokenSymbol ?? null,
        logo_url: input.logoUrl ?? null,
        initial_price_usd:
          input.initialPrice != null && input.initialPrice > 0
            ? input.initialPrice
            : null,
        added_at: new Date().toISOString(),
      };

      const withoutDup = (previous ?? []).filter(
        (e) => e.token_address !== input.tokenAddress,
      );
      syncListCache([optimistic, ...withoutDup]);

      return { previous };
    },
    onSuccess: (entry) => {
      const current =
        queryClient.getQueryData<WalletWatchlistEntry[]>([
          GLOBAL_WATCHLIST_QUERY_KEY,
          walletAddress,
        ]) ?? [];
      const withoutDup = current.filter(
        (e) => e.token_address !== entry.token_address,
      );
      syncListCache([entry, ...withoutDup]);
      queryClient.invalidateQueries({
        queryKey: [GLOBAL_WATCHLIST_PRICES_KEY, walletAddress],
      });
    },
    onError: (_err, _input, context) => {
      if (context?.previous) {
        syncListCache(context.previous);
      } else {
        invalidateList();
      }
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (tokenAddress: string) => {
      const res = await fetch(
        `/api/watchlist?tokenAddress=${encodeURIComponent(tokenAddress)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to remove from watchlist');
      }
    },
    onMutate: async (tokenAddress) => {
      await queryClient.cancelQueries({
        queryKey: [GLOBAL_WATCHLIST_QUERY_KEY, walletAddress],
      });
      const previous = queryClient.getQueryData<WalletWatchlistEntry[]>([
        GLOBAL_WATCHLIST_QUERY_KEY,
        walletAddress,
      ]);
      syncListCache(
        (previous ?? []).filter((e) => e.token_address !== tokenAddress),
      );
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [GLOBAL_WATCHLIST_PRICES_KEY, walletAddress],
      });
    },
    onError: (_err, _input, context) => {
      if (context?.previous) {
        syncListCache(context.previous);
      } else {
        invalidateList();
      }
    },
  });

  const toggle = async (input: WatchlistMutationInput) => {
    if (addressSet.has(input.tokenAddress)) {
      await removeMutation.mutateAsync(input.tokenAddress);
    } else {
      await addMutation.mutateAsync(input);
    }
  };

  return {
    entries,
    currentPrices,
    priceChangePct,
    addressSet,
    isLoading: listQuery.isLoading,
    isInList: (tokenAddress: string) => addressSet.has(tokenAddress),
    add: addMutation.mutateAsync,
    remove: removeMutation.mutateAsync,
    toggle,
    isPending: addMutation.isPending || removeMutation.isPending,
    walletConnected: enabled,
  };
}
