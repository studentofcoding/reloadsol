import { cacheGet, cacheSet, cacheDelByPrefix } from '@/utils/redis-cache'

export type CacheOrigin = 'hit' | 'miss' | 'stale'

export type FetchWithCacheResult<T> = {
  data: T
  origin: CacheOrigin
}

type FetchWithCacheOpts<T> = {
  /** Fresh cache key (e.g. `pf:sol:{wallet}:holdings`). */
  key: string
  /** Long-lived last-known-good snapshot key for stale-while-revalidate. */
  staleKey: string
  ttlSeconds: number
  staleTtlSeconds: number
  fetch: () => Promise<T>
  /** Bypass cache entirely (post-trade `fresh=1`) and purge the keys. */
  skipCache?: boolean
}

/**
 * Read-through cache with stale-while-revalidate (SWR).
 *
 * - Hit: serve the fresh snapshot with zero upstream latency.
 * - Miss: fetch upstream, write fresh + a longer-lived last-good copy.
 * - Upstream error: serve the stale snapshot if present (reliability), else rethrow.
 * - `skipCache` purges both keys and always fetches (post-trade `fresh=1`).
 *
 * Redis-first, with the built-in in-memory fallback (see `redis-cache.ts`).
 * A Redis blip degrades to a plain live fetch — never a crash.
 */
export async function fetchWithCache<T>(
  opts: FetchWithCacheOpts<T>,
): Promise<FetchWithCacheResult<T>> {
  const {
    key,
    staleKey,
    ttlSeconds,
    staleTtlSeconds,
    fetch: upstream,
    skipCache = false,
  } = opts

  if (skipCache) {
    await cacheDelByPrefix(`${key}:`)
  }

  if (!skipCache) {
    const fresh = await cacheGet<T>(key).catch(() => null)
    if (fresh != null) return { data: fresh, origin: 'hit' }
  }

  try {
    const data = await upstream()
    if (!skipCache) {
      await cacheSet(key, data, ttlSeconds)
      await cacheSet(staleKey, data, staleTtlSeconds)
    }
    return { data, origin: 'miss' }
  } catch (err) {
    if (!skipCache) {
      const stale = await cacheGet<T>(staleKey).catch(() => null)
      if (stale != null) return { data: stale, origin: 'stale' }
    }
    throw err
  }
}

/** Prefix shared by every portfolio cache key for a chain+wallet. */
export function portfolioWalletPrefix(
  chain: 'sol' | 'robinhood',
  wallet: string,
): string {
  return `pf:${chain}:${wallet.trim().toLowerCase()}:`
}

/** Canonical portfolio cache key per chain/wallet/kind. */
export function portfolioKey(
  chain: 'sol' | 'robinhood',
  wallet: string,
  kind: 'holdings' | 'balance',
): string {
  return `${portfolioWalletPrefix(chain, wallet)}${kind}`
}

/** Cached Shyft `all_tokens` key — distinct from Jupiter `holdings`. */
export function shyftAllTokensKey(
  wallet: string,
  network = 'mainnet-beta',
): string {
  const n = network.trim().toLowerCase() || 'mainnet-beta'
  return `${portfolioWalletPrefix('sol', wallet)}all_tokens:${n}`
}

/** Expire a wallet's portfolio cache (call after a buy/sell to force refresh). */
export async function invalidatePortfolio(
  chain: 'sol' | 'robinhood',
  wallet: string,
): Promise<void> {
  await cacheDelByPrefix(portfolioWalletPrefix(chain, wallet))
}