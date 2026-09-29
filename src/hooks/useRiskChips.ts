'use client'

import { useQuery } from '@tanstack/react-query'
import type { RiskChipData } from '@/types/risk-chip'

/**
 * Bulk shadow risk chips for a set of tokens (one request, cached).
 * Returns a map keyed by token address; tokens without a shadow row are absent.
 */
export function useRiskChips(
  addresses: string[],
  chain = 'sol',
): { chips: Record<string, RiskChipData>; isLoading: boolean } {
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))].sort()
  const key = unique.join(',')

  const query = useQuery({
    queryKey: ['risk-chips', chain, key],
    queryFn: async (): Promise<Record<string, RiskChipData>> => {
      if (!key) return {}
      const res = await fetch(
        `/api/gmgn/risk-chips?chain=${encodeURIComponent(chain)}&addresses=${encodeURIComponent(key)}`,
      )
      if (!res.ok) throw new Error('risk chips unavailable')
      const json = (await res.json()) as {
        success: boolean
        chips?: Record<string, RiskChipData>
      }
      return json.chips ?? {}
    },
    enabled: key.length > 0,
    staleTime: 60_000,
    refetchInterval: 120_000,
  })

  return { chips: query.data ?? {}, isLoading: query.isLoading }
}
