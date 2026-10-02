'use client'

import { useQuery } from '@tanstack/react-query'
import { mapGmgnSnapshotToRisk } from '@/utils/gmgn-risk-map'

export type TokenRiskChain = 'sol' | 'robinhood'

/**
 * One risk source for both chains: the GMGN token-snapshot route, which already defaults to
 * `chain=sol` and is served from a 10s cache with in-flight de-duplication
 * (`gmgn-snapshot-cache.ts`) behind the GMGN priority lanes — so this adds no new upstream and
 * no new budget (`docs/GMGN_RATE_BUDGET.md`, "cache first, single-flight everywhere").
 *
 * It replaced Axiom, which was dead rather than merely flaky: the route carried hardcoded auth
 * cookies whose access token expired 2025-07-18, so every Sol call 503'd and the risk panel had
 * been falling back for over a year. GMGN returns the same six fields plus honeypot and
 * concentration, and `mapGmgnSnapshotToRisk` — already in use for Robinhood — yields the exact
 * `{ axiomData, risk }` shape these components read.
 */
async function fetchGmgnRisk(
  chain: TokenRiskChain,
  tokenAddress: string,
  marketCap: number,
) {
  const q = new URLSearchParams({
    chain,
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

/** Both chains read the GMGN snapshot, mapped to the RiskAnalysis shape. */
export function useTokenRisk(
  tokenAddress: string,
  marketCap: number,
  chain: TokenRiskChain = 'sol',
  enabled = true,
) {
  return useQuery({
    queryKey: ['token-risk', chain, tokenAddress, marketCap],
    queryFn: () => fetchGmgnRisk(chain, tokenAddress, marketCap),
    enabled: enabled && !!tokenAddress,
    staleTime: 60_000,
    retry: 1,
  })
}
