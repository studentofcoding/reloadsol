'use client'

import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { getRhBatchExecutorAddress } from '@/utils/dlmm/rh-batch-executor'

type RhPublicConfig = {
  batchExecutorAddress: Address | null
}

function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
}

/**
 * Prefer the build-time public value and use a no-store server read when an
 * older/misconfigured client bundle has no inlined executor address.
 */
export function useRhBatchExecutorAddress(): {
  address: Address | null
  resolving: boolean
} {
  const buildTimeAddress = getRhBatchExecutorAddress()
  const query = useQuery({
    queryKey: ['rh-public-config'],
    enabled: buildTimeAddress == null,
    staleTime: 60_000,
    queryFn: async (): Promise<RhPublicConfig> => {
      const response = await fetch('/api/rh/config', { cache: 'no-store' })
      if (!response.ok) {
        throw new Error(`RH config request failed (${response.status})`)
      }
      const data = (await response.json()) as {
        batchExecutorAddress?: unknown
      }
      return {
        batchExecutorAddress: isAddress(data.batchExecutorAddress)
          ? data.batchExecutorAddress
          : null,
      }
    },
  })

  return {
    address: buildTimeAddress ?? query.data?.batchExecutorAddress ?? null,
    resolving: buildTimeAddress == null && query.isPending,
  }
}
