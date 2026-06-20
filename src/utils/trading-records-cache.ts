/** In-memory cache for GET /api/trading/records (server-side). */

interface TradingRecordsCache {
  data: unknown[]
  walletAddress: string
  limit: number
  timestamp: number
  expiresAt: number
}

interface OngoingRecordsRequest {
  promise: Promise<unknown[]>
  walletAddress: string
  limit: number
  timestamp: number
}

const tradingRecordsCache = new Map<string, TradingRecordsCache>()
export const ongoingRecordsRequests = new Map<string, OngoingRecordsRequest>()

export const TRADING_RECORDS_CACHE_TTL_MS = 30 * 1000

const MAX_CACHE_ENTRIES = 50
const REQUEST_TIMEOUT = 10000

function cleanupRecordsCache() {
  const now = Date.now()

  for (const [key, cache] of Array.from(tradingRecordsCache.entries())) {
    if (now > cache.expiresAt) {
      tradingRecordsCache.delete(key)
    }
  }

  for (const [key, request] of Array.from(ongoingRecordsRequests.entries())) {
    if (now - request.timestamp > REQUEST_TIMEOUT) {
      ongoingRecordsRequests.delete(key)
    }
  }

  if (tradingRecordsCache.size > MAX_CACHE_ENTRIES) {
    const entries = Array.from(tradingRecordsCache.entries())
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
    const toDelete = entries.slice(0, tradingRecordsCache.size - MAX_CACHE_ENTRIES)
    toDelete.forEach(([key]) => tradingRecordsCache.delete(key))
  }
}

export function generateRecordsCacheKey(
  walletAddress: string,
  limit: number,
): string {
  return `${walletAddress}-${limit}`
}

export function getCachedRecords(
  walletAddress: string,
  limit: number,
): unknown[] | null {
  const cacheKey = generateRecordsCacheKey(walletAddress, limit)
  const cached = tradingRecordsCache.get(cacheKey)
  if (!cached) return null

  const now = Date.now()
  if (now <= cached.expiresAt) {
    return cached.data
  }

  tradingRecordsCache.delete(cacheKey)
  return null
}

export function setCachedRecords(
  walletAddress: string,
  limit: number,
  data: unknown[],
) {
  const now = Date.now()
  const cacheKey = generateRecordsCacheKey(walletAddress, limit)

  tradingRecordsCache.set(cacheKey, {
    data,
    walletAddress,
    limit,
    timestamp: now,
    expiresAt: now + TRADING_RECORDS_CACHE_TTL_MS,
  })

  cleanupRecordsCache()
}

export function invalidateTradingRecordsCache(walletAddress: string): number {
  const keysToDelete: string[] = []
  for (const [key, cache] of Array.from(tradingRecordsCache.entries())) {
    if (cache.walletAddress === walletAddress) {
      keysToDelete.push(key)
    }
  }
  keysToDelete.forEach((key) => tradingRecordsCache.delete(key))
  return keysToDelete.length
}
