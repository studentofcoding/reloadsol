"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Connection, PublicKey } from "@solana/web3.js";

export function walletBalanceQueryKey(walletAddress: string | null) {
  return ["wallet-balance", walletAddress] as const;
}

export function walletUsdcBalanceQueryKey(walletAddress: string | null) {
  return ["wallet-usdc-balance", walletAddress] as const;
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

export function useWalletBalances({
  walletAddress,
  enabled = true,
  refetchInterval = 30_000,
}: UseWalletBalancesOptions) {
  const queryClient = useQueryClient();
  const isEnabled = enabled && Boolean(walletAddress);

  const solQuery = useQuery({
    queryKey: walletBalanceQueryKey(walletAddress),
    queryFn: () => fetchSolPortfolio(walletAddress!).then((d) => d.balance),
    enabled: isEnabled,
    staleTime: 60_000,
    refetchInterval: isEnabled ? refetchInterval : false,
  });

  const usdcQuery = useQuery({
    queryKey: walletUsdcBalanceQueryKey(walletAddress),
    queryFn: () => fetchSolPortfolio(walletAddress!).then((d) => d.usdc),
    enabled: isEnabled,
    staleTime: 60_000,
    refetchInterval: isEnabled ? refetchInterval : false,
  });

  /** Invalidate and refetch; `fresh=true` bypasses the server cache (post-trade). */
  const refreshBalances = useCallback(
    async (fresh = false): Promise<void> => {
      if (!walletAddress) return;
      await Promise.all([
        queryClient.fetchQuery({
          queryKey: walletBalanceQueryKey(walletAddress),
          queryFn: () =>
            fetchSolPortfolio(walletAddress, fresh).then((d) => d.balance),
          staleTime: 0,
        }),
        queryClient.fetchQuery({
          queryKey: walletUsdcBalanceQueryKey(walletAddress),
          queryFn: () =>
            fetchSolPortfolio(walletAddress, fresh).then((d) => d.usdc),
          staleTime: 0,
        }),
      ]);
    },
    [walletAddress, queryClient],
  );

  return {
    walletBalance: isEnabled ? (solQuery.data ?? null) : null,
    usdcBalance: isEnabled ? (usdcQuery.data ?? null) : null,
    isLoadingBalances: solQuery.isPending || usdcQuery.isPending,
    refreshBalances,
  };
}