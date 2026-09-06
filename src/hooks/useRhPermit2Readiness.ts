'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Address, PublicClient } from 'viem'
import {
  isPermit2Ready,
  readPermit2Readiness,
} from '@/utils/dlmm/rh-permit2-readiness'

export function useRhPermit2Readiness(params: {
  publicClient: PublicClient | null
  account: Address | null
  tokens: readonly Address[]
  spender: Address | null
  enabled?: boolean
}) {
  const tokenKey = params.tokens
    .map((token) => token.toLowerCase())
    .filter((token, index, all) => all.indexOf(token) === index)
    .sort()
    .join(',')
  const tokens = useMemo(
    () => (tokenKey ? (tokenKey.split(',') as Address[]) : []),
    [tokenKey],
  )
  const query = useQuery({
    queryKey: [
      'rh-permit2-readiness',
      params.account?.toLowerCase(),
      params.spender?.toLowerCase(),
      tokenKey,
    ],
    enabled:
      params.enabled !== false &&
      Boolean(params.publicClient && params.account && params.spender),
    staleTime: 15_000,
    queryFn: async () => {
      if (!params.publicClient || !params.account || !params.spender) return []
      return await readPermit2Readiness({
        publicClient: params.publicClient,
        account: params.account,
        tokens,
        spender: params.spender,
      })
    },
  })

  return {
    ...query,
    ready: query.data != null && isPermit2Ready(query.data),
    readyCount: query.data?.filter((item) => item.status === 'ready').length ?? 0,
    totalCount: query.data?.length ?? tokens.length,
  }
}
