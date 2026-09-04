'use client'

import { useQuery } from '@tanstack/react-query'
import {
  toPoolRows,
  type LpTerminalPoolRow,
  type LpTerminalPoolsResponse,
} from '@/utils/dlmm/lp-terminal-pools'

export type LpTerminalPoolsQuery = {
  q?: string
  /** empty = all, or 'univ3' | 'univ2' */
  proto?: '' | 'univ3' | 'univ2'
  hideDust?: boolean
  sort?: 'tvl' | 'vol' | 'created'
  limit?: number
}

type ProxyResponse = LpTerminalPoolsResponse & {
  success?: boolean
  error?: string
  upstream?: string
  count?: number
  totals?: { univ2?: number; univ3?: number }
}

async function fetchLpTerminalPools(
  params: LpTerminalPoolsQuery,
): Promise<{
  rows: LpTerminalPoolRow[]
  count: number
  totals: { univ2: number; univ3: number }
  ready: boolean
  upstream: string
}> {
  const sp = new URLSearchParams()
  if (params.q?.trim()) sp.set('q', params.q.trim())
  if (params.proto) sp.set('proto', params.proto)
  if (params.hideDust !== false) sp.set('min_tvl', '1000')
  sp.set('sort', params.sort ?? 'vol')
  sp.set('limit', String(params.limit ?? 100))

  const res = await fetch(`/api/dlmm/lp-terminal-pools?${sp.toString()}`)
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    // Guard against an HTML error page (e.g. a Next/bind-500 doc) masquerading
    // as JSON — parsing it would surface a cryptic "Unexpected token '<'".
    throw new Error(
      res.ok
        ? 'LP Terminal returned a non-JSON response'
        : `LP Terminal unreachable (HTTP ${res.status})`,
    )
  }
  const data = (await res.json()) as ProxyResponse
  if (!res.ok || data.success === false) {
    throw new Error(data.error || 'Failed to fetch LP Terminal pools')
  }

  const pools = data.pools ?? []
  return {
    rows: toPoolRows(pools, data.tokens),
    count: data.count ?? pools.length,
    totals: {
      univ2: data.totals?.univ2 ?? 0,
      univ3: data.totals?.univ3 ?? 0,
    },
    ready: data.ready !== false,
    upstream: data.upstream ?? '',
  }
}

export function useLpTerminalPools(
  enabled: boolean,
  params: LpTerminalPoolsQuery,
) {
  const query = useQuery({
    queryKey: [
      'dlmm-lp-terminal-pools',
      params.q ?? '',
      params.proto ?? '',
      params.hideDust !== false,
      params.sort ?? 'vol',
      params.limit ?? 100,
    ],
    queryFn: () => fetchLpTerminalPools(params),
    enabled,
    refetchInterval: enabled ? 45_000 : false,
    staleTime: 20_000,
  })

  return {
    rows: query.data?.rows ?? [],
    count: query.data?.count ?? 0,
    totals: query.data?.totals ?? { univ2: 0, univ3: 0 },
    ready: query.data?.ready ?? true,
    upstream: query.data?.upstream ?? '',
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  }
}
