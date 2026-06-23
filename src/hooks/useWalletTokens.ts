"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Connection, PublicKey } from "@solana/web3.js";
import { categorizeUserTokens, type UserToken } from "@/utils/jupiter";
import {
  fetchJupiterPortfolio,
  mapPortfolioToUserTokens,
} from "@/utils/jupiter-portfolio";
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

export const WALLET_TOKENS_SOURCE = "jupiter-portfolio" as const;

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

async function fetchWalletTokens(
  _connection: Connection,
  _publicKey: PublicKey,
  walletAddress: string,
  _forceRefresh: boolean,
): Promise<WalletTokensData> {
  const start = Date.now();

  const portfolio = await fetchJupiterPortfolio(walletAddress);
  const tokens = mapPortfolioToUserTokens(portfolio);
  const totalPortfolioUsd = portfolio.totalValue;
  const sourceLabel = "Jupiter Portfolio";

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
      latencyMs: Date.now() - start,
      rpcLabel: sourceLabel,
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
  connection: Connection;
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

  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!publicKey || !walletAddress) {
        throw new Error("Wallet not connected");
      }
      return fetchWalletTokens(connection, publicKey, walletAddress, false);
    },
    enabled: enabled && !!publicKey && !!walletAddress,
    staleTime: 30_000,
    refetchInterval,
    retry: 1,
  });

  const refetchTokens = async (forceRefresh = false): Promise<void> => {
    if (!publicKey || !walletAddress) {
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
