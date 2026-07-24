'use client'

import { useQuery } from '@tanstack/react-query'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'

export type GmgnSearchToken = {
  id: string
  address: string
  name: string
  symbol: string
  icon?: string
  mcap?: number
}

async function searchGmgnTokens(
  chain: GmgnTradeChain,
  query: string,
): Promise<GmgnSearchToken[]> {
  const params = new URLSearchParams({ chain, query })
  const res = await fetch(`/api/gmgn/token/search?${params}`)
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

export function useGmgnTokenSearch(
  chain: GmgnTradeChain,
  query: string,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: ['gmgn-token-search', chain, query],
    queryFn: () => searchGmgnTokens(chain, query),
    enabled: (options?.enabled ?? true) && query.trim().length > 0,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  })
}

export function useGmgnTrending(chain: GmgnTradeChain, enabled = true) {
  return useQuery({
    queryKey: ['gmgn-token-trending', chain],
    queryFn: () => searchGmgnTokens(chain, ''),
    enabled,
    staleTime: 60_000,
  })
}
