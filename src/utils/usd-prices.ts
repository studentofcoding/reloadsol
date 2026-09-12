import { cacheGet, cacheSet, cacheSetNx } from '@/utils/redis-cache'

export const USD_PRICE_IDS_PER_REQUEST = 50
export const USD_PRICE_FRESH_TTL_SEC = 30
export const USD_PRICE_STALE_TTL_SEC = 120
export const USD_PRICE_MAX_RPS = 5
export const USD_PRICE_LOCK_TTL_SEC = 5

const JUPITER_PRICE_V3 = 'https://api.jup.ag/price/v3'
const USER_AGENT = 'BuyBulk/1.0'
const MIN_INTERVAL_MS = 1000 / USD_PRICE_MAX_RPS

export type UsdPriceCacheEntry = {
  price: number | null
  timestamp: number
  expiresAt: number
  source: string
}

export type UsdPricesResult = {
  prices: Record<string, number>
  unpriced: string[]
}

const memory = new Map<string, UsdPriceCacheEntry>()
const inflight = new Map<string, Promise<void>>()
let nextSlotMs = 0
let missingKeyLogged = false

export function usdPriceRedisKey(mint: string): string {
  return `prices:${mint}`
}

export function usdPriceLockKey(chunk: string[]): string {
  return `prices:lock:${[...chunk].sort().join(',')}`
}

export function chunkMints(
  mints: string[],
  size: number = USD_PRICE_IDS_PER_REQUEST,
): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < mints.length; i += size) {
    chunks.push(mints.slice(i, i + size))
  }
  return chunks
}

export function parseJupiterPriceV3(
  body: unknown,
  requested: string[],
): UsdPricesResult {
  const prices: Record<string, number> = {}
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [mint, data] of Object.entries(body as Record<string, unknown>)) {
      if (!data || typeof data !== 'object') continue
      const usd = (data as { usdPrice?: unknown }).usdPrice
      if (typeof usd === 'number' && Number.isFinite(usd)) {
        prices[mint] = usd
      }
    }
  }
  const unpriced = requested.filter((mint) => !(mint in prices))
  return { prices, unpriced }
}

export function resetUsdPricesForTests(): void {
  memory.clear()
  inflight.clear()
  nextSlotMs = 0
  missingKeyLogged = false
}

function applyEntry(
  mint: string,
  entry: UsdPriceCacheEntry,
  prices: Record<string, number>,
  unpriced: string[],
): void {
  if (entry.price == null) {
    unpriced.push(mint)
    return
  }
  prices[mint] = entry.price
}

async function readEntry(mint: string): Promise<UsdPriceCacheEntry | null> {
  const local = memory.get(mint)
  if (local) return local
  const fromRedis = await cacheGet<UsdPriceCacheEntry>(usdPriceRedisKey(mint))
  if (fromRedis) memory.set(mint, fromRedis)
  return fromRedis
}

async function writeEntry(mint: string, entry: UsdPriceCacheEntry): Promise<void> {
  memory.set(mint, entry)
  const ttlSec =
    entry.price == null
      ? USD_PRICE_FRESH_TTL_SEC
      : USD_PRICE_STALE_TTL_SEC
  await cacheSet(usdPriceRedisKey(mint), entry, ttlSec)
}

async function throttleRps(): Promise<void> {
  const now = Date.now()
  const slot = Math.max(now, nextSlotMs)
  nextSlotMs = slot + MIN_INTERVAL_MS
  const wait = slot - now
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait))
  }
}

function jupiterHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'cache-control': 'no-cache',
    'user-agent': USER_AGENT,
  }
  const key = process.env.JUPITER_API_KEY?.trim()
  if (key) headers['x-api-key'] = key
  return headers
}

async function fetchChunkFromJupiter(chunk: string[]): Promise<void> {
  const key = process.env.JUPITER_API_KEY?.trim()
  if (!key) {
    if (!missingKeyLogged) {
      missingKeyLogged = true
      console.warn('[usd-prices] JUPITER_API_KEY missing; skip Jupiter (no lite fallback)')
    }
    return
  }

  const lockKey = usdPriceLockKey(chunk)
  const gotLock = await cacheSetNx(lockKey, 1, USD_PRICE_LOCK_TTL_SEC)
  if (!gotLock) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    return
  }

  await throttleRps()
  const url = `${JUPITER_PRICE_V3}?ids=${chunk.map(encodeURIComponent).join(',')}`
  const response = await fetch(url, { headers: jupiterHeaders() })
  if (response.status === 429) {
    throw new Error('Jupiter price rate limited')
  }
  if (!response.ok) {
    throw new Error(`Jupiter price HTTP ${response.status}`)
  }
  const body: unknown = await response.json()
  const parsed = parseJupiterPriceV3(body, chunk)
  const now = Date.now()
  const expiresAt = now + USD_PRICE_FRESH_TTL_SEC * 1000
  for (const mint of parsed.unpriced) {
    await writeEntry(mint, {
      price: null,
      timestamp: now,
      expiresAt,
      source: 'jupiter-v3',
    })
  }
  for (const [mint, price] of Object.entries(parsed.prices)) {
    await writeEntry(mint, {
      price,
      timestamp: now,
      expiresAt,
      source: 'jupiter-v3',
    })
  }
}

async function fetchMints(mints: string[]): Promise<void> {
  const unique = [...new Set(mints)]
  for (const chunk of chunkMints(unique)) {
    const id = usdPriceLockKey(chunk)
    const existing = inflight.get(id)
    if (existing) {
      await existing
      continue
    }
    const pending = fetchChunkFromJupiter(chunk).finally(() => {
      inflight.delete(id)
    })
    inflight.set(id, pending)
    await pending
  }
}

export async function getUsdPrices(mints: string[]): Promise<UsdPricesResult> {
  const unique = [...new Set(mints.filter((m) => typeof m === 'string' && m.length > 0))]
  const prices: Record<string, number> = {}
  const unpriced: string[] = []
  const needFetch: string[] = []
  const staleRefresh: string[] = []
  const now = Date.now()
  const staleMs = USD_PRICE_STALE_TTL_SEC * 1000

  for (const mint of unique) {
    const entry = await readEntry(mint)
    if (!entry) {
      needFetch.push(mint)
      continue
    }
    if (now <= entry.expiresAt) {
      applyEntry(mint, entry, prices, unpriced)
      continue
    }
    if (now - entry.timestamp <= staleMs) {
      applyEntry(mint, entry, prices, unpriced)
      staleRefresh.push(mint)
      continue
    }
    needFetch.push(mint)
  }

  if (needFetch.length > 0) {
    try {
      await fetchMints(needFetch)
    } catch (err) {
      console.warn('[usd-prices] Jupiter fetch failed:', err)
    }
    for (const mint of needFetch) {
      if (mint in prices || unpriced.includes(mint)) continue
      const entry = await readEntry(mint)
      if (entry) applyEntry(mint, entry, prices, unpriced)
    }
  }

  if (staleRefresh.length > 0) {
    void fetchMints(staleRefresh).catch((err) => {
      console.warn('[usd-prices] background refresh failed:', err)
    })
  }

  return { prices, unpriced }
}
