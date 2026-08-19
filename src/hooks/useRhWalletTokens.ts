'use client'

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { usePortfolioWallet } from '@/hooks/usePortfolioWallet'
import type { UserToken } from '@/utils/jupiter'
import { sortRhTokensByUsd } from '@/utils/rh-wallet-holdings'

export const RH_WALLET_TOKENS_KEY = 'rh-wallet-tokens'

async function fetchRhWalletTokens(
  wallet: string,
  fresh = false,
): Promise<{
  tokens: UserToken[]
  source: 'gmgn' | 'blockscout' | 'rpc'
}> {
  const res = await fetch(
    `/api/rh/wallet-tokens?wallet=${encodeURIComponent(wallet)}${fresh ? '&fresh=1' : ''}`,
  )
  const data = (await res.json()) as {
    success?: boolean
    error?: string
    tokens?: UserToken[]
    source?: 'gmgn' | 'blockscout' | 'rpc'
  }
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to load RH wallet tokens')
  }
  return {
    tokens: sortRhTokensByUsd(data.tokens ?? []),
    source: data.source ?? 'gmgn',
  }
}

/** ERC-20 holdings + USD for active RH Parent/Bound wallet. */
export function useRhWalletTokens() {
  const { network, walletAddress } = usePortfolioWallet()
  const queryClient = useQueryClient()
  const enabled = network === 'robinhood' && Boolean(walletAddress)

  const query = useQuery({
    queryKey: [RH_WALLET_TOKENS_KEY, walletAddress],
    queryFn: () => fetchRhWalletTokens(walletAddress!),
    enabled,
    staleTime: 30_000,
  })

  /** Post-trade refresh: bypass the server-side 20s cache. */
  const refetchFresh = useCallback(async () => {
    if (!walletAddress) return
    await queryClient.fetchQuery({
      queryKey: [RH_WALLET_TOKENS_KEY, walletAddress],
      queryFn: () => fetchRhWalletTokens(walletAddress, true),
      staleTime: 0,
    })
  }, [walletAddress, queryClient])

  return {
    tokens: query.data?.tokens ?? [],
    source: query.data?.source,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    refetchFresh,
    walletAddress: enabled ? walletAddress : null,
  }
}
