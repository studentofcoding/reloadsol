"use client";

import { useCallback } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { Connection, PublicKey } from "@solana/web3.js";

export function walletBalancesQueryKey(walletAddress: string | null) {
  return ["wallet-balances", walletAddress] as const;
}

type SolPortfolioResponse = { balance: number; usdc: number };

/** Shared, Redis-cached Sol balance proxy (native SOL + USDC). */
async function fetchSolPortfolio(
  walletAddress: string,
  fresh = false,
): Promise<SolPortfolioResponse> {
  const url = `/api/sol/portfolio?wallet=${encodeURIComponent(walletAddress)}${fresh ? "&fresh=1" : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Failed to load Solana balance");
  }
  const data = (await res.json()) as SolPortfolioResponse;
  return { balance: data.balance ?? 0, usdc: data.usdc ?? 0 };
}

type UseWalletBalancesOptions = {
  connection?: Connection | null;
  publicKey?: PublicKey | null;
  walletAddress: string | null;
  enabled?: boolean;
  refetchInterval?: number;
};

/**
 * SOL + USDC wallet balances from one `/api/sol/portfolio` request per poll
 * tick (they used to be two queries against the same URL). `placeholderData`
 * keeps the last known values on screen while a background refetch runs or
 * fails, so the balance pill never blips to 0.
 */
export function useWalletBalances({
  walletAddress,
  enabled = true,
  refetchInterval = 30_000,
}: UseWalletBalancesOptions) {
  const queryClient = useQueryClient();
  const isEnabled = enabled && Boolean(walletAddress);

  const query = useQuery({
    queryKey: walletBalancesQueryKey(walletAddress),
    queryFn: () => fetchSolPortfolio(walletAddress!),
    enabled: isEnabled,
    staleTime: 60_000,
    refetchInterval: isEnabled ? refetchInterval : false,
    placeholderData: keepPreviousData,
  });

  /** Refetch; `fresh=true` bypasses the server cache (post-trade). */
  const refreshBalances = useCallback(
    async (fresh = false): Promise<void> => {
      if (!walletAddress) return;
      await queryClient.fetchQuery({
        queryKey: walletBalancesQueryKey(walletAddress),
        queryFn: () => fetchSolPortfolio(walletAddress, fresh),
        staleTime: 0,
      });
    },
    [walletAddress, queryClient],
  );

  return {
    walletBalance: isEnabled ? (query.data?.balance ?? null) : null,
    usdcBalance: isEnabled ? (query.data?.usdc ?? null) : null,
    isLoadingBalances: query.isPending,
    refreshBalances,
  };
}
