import { GmgnApiError, tokenInfo, tokenSecurity } from '@/utils/gmgn-api'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

/**
 * Shared short-TTL cache for GMGN token info + security, used by the
 * token-snapshot API route and the sim-track pipeline so both dedupe against
 * the same Redis key instead of each hitting upstream per caller.
 */

const SNAPSHOT_TTL_S = 10

export type GmgnSnapshotData = {
  info: Record<string, unknown>
  security: Record<string, unknown>
}

function snapshotKey(chain: GmgnTradeChain, address: string): string {
  return `gmgn:token-snapshot:${chain}:${address.toLowerCase()}`
}

/**
 * Cached token info + security. A `RATE_LIMIT` error is re-thrown (callers
 * map it to a 429 response); any other per-endpoint failure degrades to the
 * data that did come back. Returns `undefined` when nothing is available.
 */
export async function getGmgnTokenSnapshotCached(
  chain: GmgnTradeChain,
  address: string,
): Promise<GmgnSnapshotData | undefined> {
  const key = snapshotKey(chain, address)
  const cached = await cacheGet<GmgnSnapshotData>(key)
  if (cached) return cached

  let rateLimited: GmgnApiError | null = null
  const [info, security] = await Promise.all([
    tokenInfo({ chain, address }).catch((e: unknown) => {
      if (e instanceof GmgnApiError && e.code === 'RATE_LIMIT') {
        rateLimited = e
        return null
      }
      return {} as Record<string, unknown>
    }),
    tokenSecurity({ chain, address }).catch((e: unknown) => {
      if (e instanceof GmgnApiError && e.code === 'RATE_LIMIT') {
        rateLimited = e
        return null
      }
      return {} as Record<string, unknown>
    }),
  ])
  if (rateLimited) throw rateLimited

  const infoSafe = info ?? ({} as Record<string, unknown>)
  const securitySafe = security ?? ({} as Record<string, unknown>)
  if (Object.keys(infoSafe).length === 0 && Object.keys(securitySafe).length === 0) {
    return undefined
  }
  const data = { info: infoSafe, security: securitySafe }
  void cacheSet(key, data, SNAPSHOT_TTL_S)
  return data
}

/** Key used by the route + pipeline for cache invalidation. */
export function gmgnSnapshotCacheKey(
  chain: GmgnTradeChain,
  address: string,
): string {
  return snapshotKey(chain, address)
}
