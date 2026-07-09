import { useQuery } from '@tanstack/react-query'
import type { McapToast } from '@/types/mcap-toasts'

type SimOpenAlertsResponse = {
  success: boolean
  alerts: McapToast[]
  error?: string
}

export function useMcapSimOpenAlerts(options?: {
  refetchInterval?: number | false
  enabled?: boolean
}) {
  const refetchInterval = options?.refetchInterval ?? 15_000
  const enabled = options?.enabled ?? true

  return useQuery({
    queryKey: ['mcap-sim-open-alerts'],
    queryFn: async (): Promise<McapToast[]> => {
      const res = await fetch('/api/mcap-tracking/sim-open-alerts', {
        cache: 'no-store',
      })
      if (!res.ok) {
        throw new Error(`Failed to fetch sim-open alerts (${res.status})`)
      }
      const json = (await res.json()) as SimOpenAlertsResponse
      return Array.isArray(json.alerts) ? json.alerts : []
    },
    enabled,
    refetchInterval,
    staleTime: 0,
  })
}
