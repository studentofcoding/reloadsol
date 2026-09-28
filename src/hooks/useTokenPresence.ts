import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { TrackerSocialLinks } from '@/utils/tracker-social-join'
import { isTrackerSocialJoinEnabled } from '@/utils/tracker-flags'

/**
 * Web/social presence for a set of mints, shared by every /dev/signals token list.
 *
 * One request per distinct mint set (react-query dedupes + caches), sol-only via
 * /api/tokens/presence. Presence is live-only — absent is the normal answer for a
 * token that is not in the current GMGN rank feed, so callers must render nothing.
 */

export type TokenPresenceLookup = {
  presenceFor: (mint: string | null | undefined) => TrackerSocialLinks | undefined
}

const EMPTY_MAP: ReadonlyMap<string, TrackerSocialLinks> = new Map()

/**
 * Order-independent, deduped cache key for a mint list, so a caller that rebuilds
 * its array every render does not refetch. Exported for the unit test.
 */
export function presenceMintKey(mints: readonly string[]): string {
  const unique = new Set<string>()
  for (const mint of mints) {
    if (typeof mint === 'string' && mint.trim()) unique.add(mint.trim())
  }
  return Array.from(unique).sort().join(',')
}

export function useTokenPresence(mints: readonly string[]): TokenPresenceLookup {
  const enabled = isTrackerSocialJoinEnabled()
  const key = useMemo(() => presenceMintKey(mints), [mints])

  const { data } = useQuery({
    queryKey: ['token-presence', key],
    enabled: enabled && key.length > 0,
    // Upstream (GMGN filtered trending) is already Redis-cached for 2–5 min.
    staleTime: 60_000,
    queryFn: async ({ signal }): Promise<ReadonlyMap<string, TrackerSocialLinks>> => {
      try {
        const response = await fetch(
          `/api/tokens/presence?mints=${encodeURIComponent(key)}`,
          { signal },
        )
        if (!response.ok) return EMPTY_MAP
        const body = (await response.json()) as {
          presence?: Record<string, TrackerSocialLinks>
        }
        return new Map(Object.entries(body.presence ?? {}))
      } catch {
        // Fail-soft: a presence lookup must never break a list.
        return EMPTY_MAP
      }
    },
  })

  const map = data ?? EMPTY_MAP
  const presenceFor = useMemo(
    () => (mint: string | null | undefined) =>
      mint ? map.get(mint) : undefined,
    [map],
  )

  return { presenceFor }
}
