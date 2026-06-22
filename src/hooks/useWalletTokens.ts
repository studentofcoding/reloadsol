"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Connection, PublicKey } from "@solana/web3.js";
import {
  categorizeUserTokens,
  fetchUserTokensEfficient,
  type UserToken,
} from "@/utils/jupiter";
import type { TokenFetchMeta } from "@/contexts/RpcContext";

export type WalletTokensData = {
  allTokens: UserToken[];
  valuable: UserToken[];
  dust: UserToken[];
  zeroValue: UserToken[];
  sellable: UserToken[];
  closeOnly: UserToken[];
  meta: TokenFetchMeta;
};

export function walletTokensQueryKey(
  walletAddress: string | null,
  activeRpcUrl: string,
  includeZeroBalance: boolean,
) {
  return ["wallet-tokens", walletAddress, activeRpcUrl, includeZeroBalance] as const;
}

async function fetchWalletTokens(
  connection: Connection,
  publicKey: PublicKey,
  rpcLabel: string,
  forceRefresh: boolean,
): Promise<WalletTokensData> {
  const start = Date.now();
  const allTokens = await fetchUserTokensEfficient(
    connection,
    publicKey,
    true,
    false,
    undefined,
    forceRefresh,
  );

  const { valuable, dust, zeroValue, sellable, zeroBalance, frozen } =
    categorizeUserTokens(allTokens);
  const closeOnly = [...zeroValue, ...zeroBalance, ...frozen];

  return {
    allTokens,
    valuable,
    dust,
    zeroValue,
    sellable,
    closeOnly,
    meta: {
      rawAccountCount: allTokens.length,
      latencyMs: Date.now() - start,
      rpcLabel,
    },
  };
}

type UseWalletTokensOptions = {
  connection: Connection;
  publicKey: PublicKey | null;
  walletAddress: string | null;
  activeRpcUrl: string;
  rpcLabel?: string;
  enabled?: boolean;
  includeZeroBalance?: boolean;
  refetchInterval?: number | false;
};

export function useWalletTokens({
  connection,
  publicKey,
  walletAddress,
  activeRpcUrl,
  rpcLabel = "RPC",
  enabled = true,
  includeZeroBalance = true,
  refetchInterval = false,
}: UseWalletTokensOptions) {
  const queryClient = useQueryClient();
  const queryKey = walletTokensQueryKey(
    walletAddress,
    activeRpcUrl,
    includeZeroBalance,
  );

  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!publicKey) throw new Error("Wallet not connected");
      return fetchWalletTokens(connection, publicKey, rpcLabel, false);
    },
    enabled: enabled && !!publicKey && !!walletAddress,
    staleTime: 30_000,
    refetchInterval,
    retry: 1,
  });

  const refetchTokens = async (forceRefresh = false): Promise<void> => {
    if (!publicKey) {
      await query.refetch();
      return;
    }
    if (forceRefresh) {
      await queryClient.fetchQuery({
        queryKey,
        queryFn: () =>
          fetchWalletTokens(connection, publicKey, rpcLabel, true),
        staleTime: 0,
      });
      return;
    }
    await query.refetch();
  };

  const patchTokens = (
    updater: (data: WalletTokensData) => WalletTokensData,
  ) => {
    queryClient.setQueryData<WalletTokensData>(queryKey, (prev) => {
      if (!prev) return prev;
      return updater(prev);
    });
  };

  return {
    ...query,
    refetchTokens,
    patchTokens,
    valuable: query.data?.valuable ?? [],
    dust: query.data?.dust ?? [],
    zeroValue: query.data?.zeroValue ?? [],
    sellable: query.data?.sellable ?? [],
    closeOnly: query.data?.closeOnly ?? [],
    allTokens: query.data?.allTokens ?? [],
    fetchMeta: query.data?.meta ?? null,
  };
}
