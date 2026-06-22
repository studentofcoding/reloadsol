"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Connection, PublicKey } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKENS } from "@/utils/solana";

export function walletBalanceQueryKey(walletAddress: string | null) {
  return ["wallet-balance", walletAddress] as const;
}

export function walletUsdcBalanceQueryKey(walletAddress: string | null) {
  return ["wallet-usdc-balance", walletAddress] as const;
}

async function fetchSolBalance(
  connection: Connection,
  publicKey: PublicKey,
): Promise<number> {
  const lamports = await connection.getBalance(publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

async function fetchUsdcBalance(
  connection: Connection,
  publicKey: PublicKey,
): Promise<number> {
  const { PublicKey: SolPublicKey } = await import("@solana/web3.js");
  const usdcMint = new SolPublicKey(TOKENS.USDC);
  const { getAssociatedTokenAddress, getAccount } =
    await import("@solana/spl-token");
  const usdcTokenAccount = await getAssociatedTokenAddress(usdcMint, publicKey);
  try {
    const accountInfo = await getAccount(connection, usdcTokenAccount);
    return Number(accountInfo.amount) / 1e6;
  } catch {
    return 0;
  }
}

type UseWalletBalancesOptions = {
  connection: Connection;
  publicKey: PublicKey | null;
  walletAddress: string | null;
  enabled?: boolean;
  refetchInterval?: number;
};

export function useWalletBalances({
  connection,
  publicKey,
  walletAddress,
  enabled = true,
  refetchInterval = 30_000,
}: UseWalletBalancesOptions) {
  const queryClient = useQueryClient();
  const isEnabled = enabled && !!publicKey && !!walletAddress;

  const solQuery = useQuery({
    queryKey: walletBalanceQueryKey(walletAddress),
    queryFn: () => fetchSolBalance(connection, publicKey!),
    enabled: isEnabled,
    staleTime: 15_000,
    refetchInterval: isEnabled ? refetchInterval : false,
  });

  const usdcQuery = useQuery({
    queryKey: walletUsdcBalanceQueryKey(walletAddress),
    queryFn: () => fetchUsdcBalance(connection, publicKey!),
    enabled: isEnabled,
    staleTime: 15_000,
    refetchInterval: isEnabled ? refetchInterval : false,
  });

  const refreshBalances = async () => {
    if (!walletAddress) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: walletBalanceQueryKey(walletAddress),
      }),
      queryClient.invalidateQueries({
        queryKey: walletUsdcBalanceQueryKey(walletAddress),
      }),
    ]);
  };

  return {
    walletBalance: isEnabled ? (solQuery.data ?? null) : null,
    usdcBalance: isEnabled ? (usdcQuery.data ?? null) : null,
    isLoadingBalances: solQuery.isPending || usdcQuery.isPending,
    refreshBalances,
  };
}
