import { cacheGet, cacheSet } from '@/utils/redis-cache'

/**
 * Cached, single-flight, 429-aware proxy for `datapi.jup.ag/v1/assets/search`.
 *
 * The route used to forward every request upstream: a trending UI poll (or several tabs) typed the same
 * query many times a minute, and a 429 became a generic 500. Now:
 *  - fresh cache per normalised query (default 45 s, memory + Redis via `redis-cache`)
 *  - in-flight dedupe: concurrent identical queries share one upstream call
 *  - a 429 (or `Retry-After`) opens a short upstream backoff; during it we serve the last good
 *    answer (stale, ≤ 10 min old) or a clean 429 with `Retry-After` — never hammering upstream.
 */

const UPSTREAM = 'https://datapi.jup.ag/v1/assets/search'
const FRESH_TTL_S = 45
const STALE_TTL_S = 600
const DEFAULT_BACKOFF_S = 30
const MIN_BACKOFF_S = 5
const MAX_BACKOFF_S = 120
const MAX_QUERY_LEN = 100
const CACHE_PREFIX = 'jup:assets-search:'

export type JupiterAssetSearchResult =
  | { ok: true; status: 200; data: unknown; cache: 'miss' | 'hit' | 'stale' }
  | { ok: false; status: 429; retryAfterS: number }
  | { ok: false; status: 502 | 500; error: string }

type Stored = { data: unknown; storedAt: number }

let backoffUntilMs = 0
const inflight = new Map<string, Promise<JupiterAssetSearchResult>>()

export function normalizeAssetSearchQuery(raw: string): string {
  return raw.trim().slice(0, MAX_QUERY_LEN)
}

function cacheKey(q: string): string {
  return `${CACHE_PREFIX}${q.toLowerCase()}`
}

/** `Retry-After` seconds or HTTP-date → clamped backoff seconds. */
export function parseAssetSearchBackoffS(retryAfter: string | null, nowMs: number = Date.now()): number {
  let secs = DEFAULT_BACKOFF_S
  if (retryAfter) {
    const t = retryAfter.trim()
    const n = Number(t)
    if (t && Number.isFinite(n) && n >= 0) secs = n
    else {
      const d = Date.parse(t)
      if (Number.isFinite(d)) secs = (d - nowMs) / 1000
    }
  }
  return Math.min(MAX_BACKOFF_S, Math.max(MIN_BACKOFF_S, Math.ceil(secs)))
}

export function __resetJupiterAssetSearchForTests(): void {
  backoffUntilMs = 0
  inflight.clear()
}

async function readStored(key: string): Promise<Stored | null> {
  const v = await cacheGet<Stored>(key)
  return v && typeof v === 'object' && 'data' in v && typeof v.storedAt === 'number' ? v : null
}

async function load(q: string, key: string): Promise<JupiterAssetSearchResult> {
  const stored = await readStored(key)
  const now = Date.now()
  if (stored && now - stored.storedAt < FRESH_TTL_S * 1000) {
    return { ok: true, status: 200, data: stored.data, cache: 'hit' }
  }

  const stale = (): JupiterAssetSearchResult | null =>
    stored ? { ok: true, status: 200, data: stored.data, cache: 'stale' } : null

  if (now < backoffUntilMs) {
    return stale() ?? { ok: false, status: 429, retryAfterS: Math.ceil((backoffUntilMs - now) / 1000) }
  }

  try {
    const response = await fetch(`${UPSTREAM}?query=${encodeURIComponent(q)}`, {
      headers: {
        accept: 'application/json',
        referer: 'https://jup.ag/',
        'user-agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (response.status === 429) {
      const backoffS = parseAssetSearchBackoffS(response.headers.get('retry-after'))
      backoffUntilMs = Date.now() + backoffS * 1000
      return stale() ?? { ok: false, status: 429, retryAfterS: backoffS }
    }
    if (!response.ok) {
      return stale() ?? { ok: false, status: 502, error: `Jupiter API responded with status: ${response.status}` }
    }
    const data: unknown = await response.json()
    await cacheSet(key, { data, storedAt: Date.now() } satisfies Stored, STALE_TTL_S)
    return { ok: true, status: 200, data, cache: 'miss' }
  } catch (error) {
    console.error('Error fetching token data:', error)
    return stale() ?? { ok: false, status: 500, error: 'Failed to fetch token data' }
  }
}

export async function searchJupiterAssets(rawQuery: string): Promise<JupiterAssetSearchResult> {
  const q = normalizeAssetSearchQuery(rawQuery)
  const key = cacheKey(q)
  const existing = inflight.get(key)
  if (existing) return existing
  const p = load(q, key).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}
