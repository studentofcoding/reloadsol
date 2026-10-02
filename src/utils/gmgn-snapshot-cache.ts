import { GmgnApiError, tokenInfo, tokenSecurity } from '@/utils/gmgn-api'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import {
  fetchGmgnWebMultiTokenInfo,
  GmgnWebMultiError,
  usesGmgnWebTokenInfo,
} from '@/utils/gmgn-web-multi'
import { cacheDel, cacheGet, cacheSet } from '@/utils/redis-cache'

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

/** Reject HTTP payload shapes that used to poison this key (route overwrite). */
export function isGmgnSnapshotData(value: unknown): value is GmgnSnapshotData {
  if (value == null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    v.info != null &&
    typeof v.info === 'object' &&
    !Array.isArray(v.info) &&
    v.security != null &&
    typeof v.security === 'object' &&
    !Array.isArray(v.security)
  )
}

/** Single-flight: concurrent callers for the same mint share one upstream load. */
const inflight = new Map<string, Promise<GmgnSnapshotData | undefined>>()

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
  const cached = await cacheGet<unknown>(key)
  if (cached != null) {
    if (isGmgnSnapshotData(cached)) return cached
    // Poisoned by old route payload write — drop and refetch.
    void cacheDel(key)
  }

  // Concurrent callers (UI poll + cron tick + shadow) otherwise each spend the
  // shared rate budget on the same mint.
  const existing = inflight.get(key)
  if (existing) return existing

  const load = (
    usesGmgnWebTokenInfo(chain)
      ? loadWebSnapshot(address, key)
      : loadOpenApiSnapshot(chain, address, key)
  ).finally(() => inflight.delete(key))
  inflight.set(key, load)
  return load
}

async function loadOpenApiSnapshot(
  chain: GmgnTradeChain,
  address: string,
  key: string,
): Promise<GmgnSnapshotData | undefined> {
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

/**
 * Public web multi path. Same Redis snapshot key and 10s TTL as OpenAPI.
 * 429 / Cloudflare cooldown becomes RATE_LIMIT so the route can answer 429
 * without a retry loop. Other misses degrade to undefined.
 */
async function loadWebSnapshot(
  address: string,
  key: string,
): Promise<GmgnSnapshotData | undefined> {
  let rows: Awaited<ReturnType<typeof fetchGmgnWebMultiTokenInfo>>
  try {
    rows = await fetchGmgnWebMultiTokenInfo([address], { includeHolderStat: 'if-missing' })
  } catch (error) {
    if (
      error instanceof GmgnWebMultiError &&
      (error.code === 'RATE_LIMIT' || error.code === 'BLOCKED')
    ) {
      throw new GmgnApiError('GMGN web multi cooldown', 'RATE_LIMIT')
    }
    return undefined
  }

  const row = rows.find((item) => item.address === address) ?? rows[0]
  if (!row) return undefined
  if (Object.keys(row.info).length === 0 && Object.keys(row.security).length === 0) {
    return undefined
  }
  const data = { info: row.info, security: row.security }
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
