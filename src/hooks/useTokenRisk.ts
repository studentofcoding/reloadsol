'use client'

import { useQuery } from '@tanstack/react-query'
import {
  fetchAxiomTokenInfo,
  getRiskIndicators,
} from '@/utils/axiom'
import { mapGmgnSnapshotToRisk } from '@/utils/gmgn-risk-map'

export type TokenRiskChain = 'sol' | 'robinhood'

async function fetchRhGmgnRisk(tokenAddress: string, marketCap: number) {
  const q = new URLSearchParams({
    chain: 'robinhood',
    address: tokenAddress,
  })
  const res = await fetch(`/api/gmgn/token-snapshot?${q}`)
  const json = (await res.json()) as {
    success?: boolean
    error?: string
    top10HoldPct?: number | null
    devHoldPct?: number | null
    snipersHoldPct?: number | null
    insidersHoldPct?: number | null
    bundlersHoldPct?: number | null
    holders?: number | null
    isHoneypot?: boolean | null
  }
  if (!res.ok || !json.success) {
    throw new Error(json.error || 'Failed to load GMGN risk data')
  }
  return mapGmgnSnapshotToRisk({
    snapshot: {
      top10HoldPct: json.top10HoldPct,
      devHoldPct: json.devHoldPct,
      snipersHoldPct: json.snipersHoldPct,
      insidersHoldPct: json.insidersHoldPct,
      bundlersHoldPct: json.bundlersHoldPct,
      holders: json.holders,
      isHoneypot: json.isHoneypot,
      marketCap,
    },
    marketCap,
  })
}

/** Sol = Axiom; Robinhood = GMGN token-snapshot mapped to RiskAnalysis shape. */
export function useTokenRisk(
  tokenAddress: string,
  marketCap: number,
  chain: TokenRiskChain = 'sol',
  enabled = true,
) {
  return useQuery({
    queryKey: ['token-risk', chain, tokenAddress, marketCap],
    queryFn: async () => {
      if (chain === 'robinhood') {
        return fetchRhGmgnRisk(tokenAddress, marketCap)
      }
      const result = await fetchAxiomTokenInfo(tokenAddress)
      if (!result.success || !result.data) {
        throw new Error('Failed to load risk data')
      }
      return {
        axiomData: result.data,
        risk: getRiskIndicators(result.data, marketCap),
      }
    },
    enabled: enabled && !!tokenAddress,
    staleTime: 60_000,
    retry: 1,
  })
}
