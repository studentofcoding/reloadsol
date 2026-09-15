import { useQuery } from '@tanstack/react-query'

export const CLIMATE_DISPLAY_QUERY_KEY = ['regime-climate-display'] as const
export const CLIMATE_DISPLAY_POLL_MS = 30_000

export type ClimateChipLabel = 'Safe' | 'Not safe' | 'Unknown'

export type ClimateChipResponse = {
  ok: boolean
  label: ClimateChipLabel
  state?: string | null
  h?: number | null
  cascadeVeto?: boolean
  sizeKind?: string
  scale?: number
  fetchedAt: number
  stale: boolean
  headline?: string | null
  detail?: string | null
  tone?: string | null
}

const UNKNOWN: ClimateChipResponse = {
  ok: false,
  label: 'Unknown',
  fetchedAt: 0,
  stale: false,
}

function isChipLabel(value: unknown): value is ClimateChipLabel {
  return value === 'Safe' || value === 'Not safe' || value === 'Unknown'
}

async function fetchClimateDisplay(): Promise<ClimateChipResponse> {
  const response = await fetch('/api/regime/climate', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    return { ...UNKNOWN, fetchedAt: Date.now() }
  }
  const data: unknown = await response.json()
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ...UNKNOWN, fetchedAt: Date.now() }
  }
  const body = data as ClimateChipResponse
  if (!isChipLabel(body.label) || typeof body.fetchedAt !== 'number') {
    return { ...UNKNOWN, fetchedAt: Date.now() }
  }
  return body
}

/** Polls the display-only climate BFF. Does not import climateGate policy/env. */
export function useClimateDisplay() {
  return useQuery({
    queryKey: CLIMATE_DISPLAY_QUERY_KEY,
    queryFn: fetchClimateDisplay,
    refetchInterval: CLIMATE_DISPLAY_POLL_MS,
    staleTime: 15_000,
    retry: 1,
  })
}
