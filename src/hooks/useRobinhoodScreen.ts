'use client'

import { useQuery } from '@tanstack/react-query'
import type { RobinhoodScreenToken } from '@/utils/dlmm/robinhood-screen'
import { ROBINHOOD_LP_DEFAULTS } from '@/utils/dlmm/robinhood-screen'

type RobinhoodScreenResponse = {
  success: boolean
  tokens?: RobinhoodScreenToken[]
  fetchedAt?: string
  filters?: typeof ROBINHOOD_LP_DEFAULTS
  error?: string
}

async function fetchRobinhoodScreen(): Promise<{
  tokens: RobinhoodScreenToken[]
  fetchedAt: string
}> {
  const res = await fetch('/api/dlmm/robinhood-screen')
  const data = (await res.json()) as RobinhoodScreenResponse
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch Robinhood screen')
  }
  return {
    tokens: data.tokens ?? [],
    fetchedAt: data.fetchedAt ?? new Date().toISOString(),
  }
}

export function useRobinhoodScreen(enabled: boolean) {
  const query = useQuery({
    queryKey: ['dlmm-robinhood-screen'],
    queryFn: fetchRobinhoodScreen,
    enabled,
    refetchInterval: enabled ? 60_000 : false,
    staleTime: 30_000,
  })

  return {
    tokens: query.data?.tokens ?? [],
    fetchedAt: query.data?.fetchedAt ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  }
}
