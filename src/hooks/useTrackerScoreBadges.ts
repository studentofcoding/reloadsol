import { useQuery } from '@tanstack/react-query'

export type TrackerScoreBadge = {
  combined: number | null
  mlScore: number | null
}

const MAX_CONCURRENCY = 4

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  }
  const n = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function fetchJsonFailSoft(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

async function fetchTokenScores(
  address: string,
  chain: 'sol' | 'robinhood',
): Promise<TrackerScoreBadge> {
  const qs = `address=${encodeURIComponent(address)}&chain=${chain}`
  const [combinedPayload, mlPayload] = await Promise.all([
    fetchJsonFailSoft(`/api/strategies/combined-score?${qs}`),
    fetchJsonFailSoft(`/api/strategies/ml/score?${qs}`),
  ])
  return {
    combined: finiteOrNull(combinedPayload?.combined),
    mlScore:
      finiteOrNull(mlPayload?.mlScore) ?? finiteOrNull(combinedPayload?.mlScore),
  }
}

async function fetchScoreBadges(
  addresses: string[],
  chain: 'sol' | 'robinhood',
): Promise<Record<string, TrackerScoreBadge>> {
  const unique = [...new Set(addresses.filter(Boolean))]
  const rows = await mapPool(unique, MAX_CONCURRENCY, (address) =>
    fetchTokenScores(address, chain),
  )
  const out: Record<string, TrackerScoreBadge> = {}
  unique.forEach((address, i) => {
    out[address] = rows[i] ?? { combined: null, mlScore: null }
  })
  return out
}

/** Hydrate combined + ml badges async. Fail-soft; does not block list render. */
export function useTrackerScoreBadges(
  tokenAddresses: string[],
  opts: { enabled: boolean; chain: 'sol' | 'robinhood' },
) {
  const key = tokenAddresses.join(',')
  return useQuery({
    queryKey: ['tracker-score-badges', key, opts.chain],
    queryFn: () => fetchScoreBadges(tokenAddresses, opts.chain),
    enabled: opts.enabled && tokenAddresses.length > 0,
    staleTime: 60_000,
    retry: false,
  })
}
