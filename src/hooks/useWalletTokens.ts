"use client";

import { useCallback } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Connection, PublicKey } from "@solana/web3.js";
import { categorizeUserTokens, type UserToken } from "@/utils/jupiter";
import { fetchSolWalletHoldings } from "@/utils/sol-wallet-holdings";
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

export const WALLET_TOKENS_SOURCE = "shyft-all-tokens" as const;

export function walletTokensQueryKey(
  walletAddress: string | null,
  includeZeroBalance: boolean,
) {
  return [
    "wallet-tokens",
    walletAddress,
    includeZeroBalance,
    WALLET_TOKENS_SOURCE,
  ] as const;
}

function sourceLabel(source: "shyft" | "jupiter"): string {
  return source === "shyft" ? "Shyft all_tokens" : "Jupiter Portfolio";
}

async function fetchWalletTokens(
  _connection: Connection,
  _publicKey: PublicKey,
  walletAddress: string,
  _forceRefresh: boolean,
  fresh = false,
): Promise<WalletTokensData> {
  const holdings = await fetchSolWalletHoldings(walletAddress, {
    fresh,
    enrichPrices: true,
  });
  const tokens = holdings.tokens;
  const totalPortfolioUsd = holdings.totalPortfolioUsd;

  const { valuable, dust, zeroValue, sellable, zeroBalance, frozen } =
    categorizeUserTokens(tokens);
  const closeOnly = [...zeroValue, ...zeroBalance, ...frozen];

  return {
    allTokens: tokens,
    valuable,
    dust,
    zeroValue,
    sellable,
    closeOnly,
    meta: {
      rawAccountCount: tokens.length,
      latencyMs: holdings.latencyMs,
      rpcLabel: sourceLabel(holdings.source),
      totalPortfolioUsd,
    },
  };
}

export async function refreshWalletTokensData(
  connection: Connection,
  publicKey: PublicKey,
  walletAddress: string,
): Promise<WalletTokensData> {
  return fetchWalletTokens(connection, publicKey, walletAddress, true);
}

type UseWalletTokensOptions = {
  connection: Connection | null;
  publicKey: PublicKey | null;
  walletAddress: string | null;
  activeRpcUrl?: string;
  rpcLabel?: string;
  enabled?: boolean;
  includeZeroBalance?: boolean;
  refetchInterval?: number | false;
};

export function useWalletTokens({
  connection,
  publicKey,
  walletAddress,
  enabled = true,
  includeZeroBalance = true,
  refetchInterval = false,
}: UseWalletTokensOptions) {
  const queryClient = useQueryClient();
  const queryKey = walletTokensQueryKey(walletAddress, includeZeroBalance);
  const isEnabled = enabled && !!connection && !!publicKey && !!walletAddress;

  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!connection || !publicKey || !walletAddress) {
        throw new Error("Wallet not connected");
      }
      return fetchWalletTokens(connection, publicKey, walletAddress, false);
    },
    enabled: isEnabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    refetchInterval,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const refetchTokens = useCallback(
    async (forceRefresh = false): Promise<void> => {
      if (!connection || !publicKey || !walletAddress) {
        await query.refetch();
        return;
      }
      if (forceRefresh) {
        await queryClient.fetchQuery({
          queryKey,
          queryFn: () =>
            fetchWalletTokens(connection, publicKey, walletAddress, true),
          staleTime: 0,
        });
        return;
      }
      await query.refetch();
    },
    [connection, publicKey, walletAddress, query, queryClient, queryKey],
  );

  /** Post-trade refresh: bypass the proxy's 15s response cache. */
  const refetchFresh = useCallback(async (): Promise<void> => {
    if (!connection || !publicKey || !walletAddress) return;
    await queryClient.fetchQuery({
      queryKey,
      queryFn: () =>
        fetchWalletTokens(connection, publicKey, walletAddress, true, true),
      staleTime: 0,
    });
  }, [connection, publicKey, walletAddress, queryClient, queryKey]);

  const patchTokens = useCallback(
    (updater: (data: WalletTokensData) => WalletTokensData) => {
      queryClient.setQueryData<WalletTokensData>(queryKey, (prev) => {
        if (!prev) return prev;
        return updater(prev);
      });
    },
    [queryClient, queryKey],
  );

  return {
    ...query,
    refetchTokens,
    refetchFresh,
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
