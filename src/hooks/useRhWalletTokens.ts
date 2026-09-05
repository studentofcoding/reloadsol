'use client'

import { useCallback, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { usePortfolioWallet } from '@/hooks/usePortfolioWallet'
import type { UserToken } from '@/utils/jupiter'
import { isRhHeldToken, sortRhTokensByUsd } from '@/utils/rh-wallet-holdings'

export const RH_WALLET_TOKENS_KEY = 'rh-wallet-tokens'

/** In-tab skip of RPC-probed zeros (per wallet). Not persisted. */
const sessionRpcSkip = new Map<string, Set<string>>()

function skipParam(wallet: string): string {
  const set = sessionRpcSkip.get(wallet.toLowerCase())
  if (!set || set.size === 0) return ''
  return [...set].join(',')
}

function rememberRpcZeros(wallet: string, zeros: string[] | undefined): void {
  if (!zeros?.length) return
  const key = wallet.toLowerCase()
  let set = sessionRpcSkip.get(key)
  if (!set) {
    set = new Set()
    sessionRpcSkip.set(key, set)
  }
  for (const z of zeros) {
    const a = z.trim().toLowerCase()
    if (a.startsWith('0x') && a.length === 42) set.add(a)
  }
}

async function fetchRhWalletTokens(
  wallet: string,
  fresh = false,
): Promise<{
  tokens: UserToken[]
  source: 'gmgn' | 'blockscout' | 'rpc'
}> {
  const params = new URLSearchParams({ wallet })
  if (fresh) params.set('fresh', '1')
  const skip = skipParam(wallet)
  if (skip) params.set('skip', skip)
  const res = await fetch(`/api/rh/wallet-tokens?${params}`)
  const data = (await res.json()) as {
    success?: boolean
    error?: string
    tokens?: UserToken[]
    source?: 'gmgn' | 'blockscout' | 'rpc'
    rpcZeros?: string[]
  }
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to load RH wallet tokens')
  }
  rememberRpcZeros(wallet, data.rpcZeros)
  return {
    tokens: sortRhTokensByUsd((data.tokens ?? []).filter(isRhHeldToken)),
    source: data.source ?? 'gmgn',
  }
}

/** ERC-20 holdings + USD for active RH Parent/Bound wallet. */
export function useRhWalletTokens() {
  const { network, walletAddress } = usePortfolioWallet()
  const queryClient = useQueryClient()
  const enabled = network === 'robinhood' && Boolean(walletAddress)
  const walletRef = useRef(walletAddress)
  walletRef.current = walletAddress

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
