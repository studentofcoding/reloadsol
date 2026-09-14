import { useQuery } from '@tanstack/react-query'
import type { ScoutBffResponse, ScoutChainQuery } from '@/utils/data-public-scout'

export const DATA_PUBLIC_SCOUT_QUERY_KEY = ['scout-data-public'] as const
export const DATA_PUBLIC_SCOUT_POLL_MS = 45_000

async function fetchScout(chain: ScoutChainQuery): Promise<ScoutBffResponse> {
  const response = await fetch(
    `/api/scout/data-public?chain=${encodeURIComponent(chain)}`,
    { method: 'GET', headers: { Accept: 'application/json' } },
  )
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok || data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(
      data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `scout BFF HTTP ${response.status}`,
    )
  }
  const body = data as ScoutBffResponse
  if (body.ok !== true || !Array.isArray(body.rows)) {
    throw new Error('scout BFF returned an invalid payload')
  }
  return body
}

/** Polls the data-public observe BFF. Does not call live execute/swap. */
export function useDataPublicScout(chain: ScoutChainQuery = 'all') {
  return useQuery({
    queryKey: [...DATA_PUBLIC_SCOUT_QUERY_KEY, chain],
    queryFn: () => fetchScout(chain),
    refetchInterval: DATA_PUBLIC_SCOUT_POLL_MS,
    staleTime: 20_000,
    retry: 1,
  })
}
