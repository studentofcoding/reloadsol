// Rate limiting for server requests
let lastRequestTime = 0
const MIN_REQUEST_INTERVAL = 200 // 200ms between requests for batch calls

const MAX_RETRIES = 3
const RETRY_DELAYS = [400, 800, 1600]
const REQUEST_TIMEOUT = 10000 // 10 seconds timeout (covers headers AND body)

const SEARCH_URL = 'https://lite-api.jup.ag/tokens/v2/search'

/**
 * Shared 429 cooldown. A 429 from lite-api used to be retried 3x (400/800/1600 ms, no jitter, no
 * Retry-After) by *every* concurrent caller, so a burst of N callers produced 4N requests inside the
 * same limiter window and kept it engaged (prod 2026-10-03: ~480 calls exhausting all retries in 50 min).
 * Now the first 429 opens a process-wide window (Retry-After honoured, clamped, jittered) during which
 * every caller fails fast — exactly as `jupiter-api.ts` does for the price API since #133. All callers
 * already treat a throw / null as "no metadata".
 */
const COOLDOWN_DEFAULT_MS = 15_000
const COOLDOWN_MIN_MS = 5_000
const COOLDOWN_MAX_MS = 60_000
let rateLimitedUntilMs = 0

/** Cooldown ms for a 429 given `Retry-After` (seconds or HTTP date): clamped, +0–20% jitter. Pure. */
export function jupiterMetadataCooldownMs(
  retryAfter: string | null,
  nowMs: number = Date.now(),
  random: () => number = Math.random,
): number {
  let ms = COOLDOWN_DEFAULT_MS
  const t = retryAfter?.trim()
  if (t) {
    const n = Number(t)
    if (Number.isFinite(n) && n >= 0) ms = n * 1000
    else {
      const d = Date.parse(t)
      if (Number.isFinite(d)) ms = d - nowMs
    }
  }
  const clamped = Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, Math.ceil(ms)))
  return Math.ceil(clamped * (1 + 0.2 * random()))
}

/** Milliseconds of 429 cooldown left (0 = free to call). */
export function jupiterMetadataCooldownRemainingMs(nowMs: number = Date.now()): number {
  return Math.max(0, rateLimitedUntilMs - nowMs)
}

/** Backoff for transient (5xx/network) retries: base delay ±25% so concurrent callers de-synchronise. */
export function jitteredRetryDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = RETRY_DELAYS[attempt] ?? 1600
  return Math.round(base * (0.75 + 0.5 * random()))
}

const inflight = new Map<string, Promise<unknown>>()

export function __resetJupiterMetadataForTests(): void {
  rateLimitedUntilMs = 0
  lastRequestTime = 0
  inflight.clear()
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

class TransientError extends Error {}

async function fetchSearchJsonOnce(query: string): Promise<unknown> {
  const left = jupiterMetadataCooldownRemainingMs()
  if (left > 0) {
    throw new Error(`Rate limited: Jupiter metadata in 429 cooldown (${Math.ceil(left / 1000)}s left)`)
  }

  const sinceLast = Date.now() - lastRequestTime
  if (sinceLast < MIN_REQUEST_INTERVAL) await sleep(MIN_REQUEST_INTERVAL - sinceLast)

  // One timer for the whole exchange: it must outlive `response.json()` or a stalled body hangs forever.
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    let response: Response
    try {
      response = await fetch(`${SEARCH_URL}?query=${encodeURIComponent(query)}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'ReloadSol-API/1.0' },
      })
    } catch (fetchError) {
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new TransientError('Request timeout after 10 seconds')
      }
      throw new TransientError(`Network error: ${fetchError}`)
    } finally {
      lastRequestTime = Date.now()
    }

    if (response.status === 429) {
      const wasOpen = jupiterMetadataCooldownRemainingMs() > 0
      const cooldown = jupiterMetadataCooldownMs(response.headers.get('retry-after'))
      rateLimitedUntilMs = Math.max(rateLimitedUntilMs, Date.now() + cooldown)
      if (!wasOpen) {
        console.warn(`[jupiter-metadata] 429 from lite-api; failing fast for ${Math.ceil(cooldown / 1000)}s`)
      }
      throw new Error(`Rate limited by Jupiter (HTTP 429); cooling down ${Math.ceil(cooldown / 1000)}s`)
    }
    if (response.status === 504) throw new TransientError('Gateway timeout (HTTP 504)')
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)

    try {
      return await response.json()
    } catch (bodyError) {
      if (bodyError instanceof Error && bodyError.name === 'AbortError') {
        throw new TransientError('Request timeout after 10 seconds')
      }
      throw bodyError
    }
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchSearchJsonWithRetry(query: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchSearchJsonOnce(query)
    } catch (error) {
      if (!(error instanceof TransientError) || attempt >= MAX_RETRIES) {
        if (error instanceof TransientError && attempt >= MAX_RETRIES) {
          throw new Error(`${error.message} (after ${MAX_RETRIES} retries)`)
        }
        throw error
      }
      await sleep(jitteredRetryDelayMs(attempt))
    }
  }
}

/**
 * lite-api v2 search JSON for `query` (one mint, or comma-separated mints). Concurrent identical
 * queries share one upstream call: token-locate asked for the same mint three times in parallel and
 * entry-hints twice (meta + volume), each paying the rate limit separately.
 */
function fetchSearchJson(query: string): Promise<unknown> {
  const existing = inflight.get(query)
  if (existing) return existing
  const p = fetchSearchJsonWithRetry(query).finally(() => {
    inflight.delete(query)
  })
  inflight.set(query, p)
  return p
}

// New function to fetch multiple tokens using v2 search endpoint
// (`retryCount` is kept for call-site compatibility; retries are handled internally.)
async function fetchTokensFromJupiterV2(mintAddresses: string[], _retryCount = 0): Promise<Record<string, any>> {
  void _retryCount
  if (mintAddresses.length === 0) return {}
  const tokensData = await fetchSearchJson(mintAddresses.join(','))

  // Convert array response to object keyed by mint address - include graduated pool
  const results: Record<string, any> = {}

  if (Array.isArray(tokensData)) {
    tokensData.forEach((token) => {
      if (token.id) {
        results[token.id] = {
          decimals: token.decimals,
          symbol: token.symbol,
          name: token.name,
          logoURI: token.icon,
          graduatedPool: token.graduatedPool || null, // Include graduated pool if available
          bondingCurve: typeof token.bondingCurve === 'number' ? token.bondingCurve : null,
          organicScore: typeof token.organicScore === 'number' ? token.organicScore : null,
          audit: token.audit ? { topHoldersPercentage: typeof token.audit.topHoldersPercentage === 'number' ? token.audit.topHoldersPercentage : null } : undefined,
          graduatedAt: token.graduatedAt ? Number(token.graduatedAt) : null,
          launchpad: token.launchpad,
          // Creator wallet address (plain base58 string) + mint count. Jupiter has
          // no coin history/performance — that's GMGN created_tokens.
          dev: typeof token.dev === 'string' ? token.dev : (token.dev?.address ?? null),
          devMints: typeof token.audit?.devMints === 'number' ? token.audit.devMints : null
        }
      }
    })
  }

  return results
}

// Legacy function for single token (now uses v2 search)
export async function fetchTokenMetadataFromJupiter(mintAddress: string, retryCount = 0): Promise<any> {
  const results = await fetchTokensFromJupiterV2([mintAddress], retryCount)
  const tokenData = results[mintAddress]

  if (!tokenData) {
    throw new Error(`Token not found: ${mintAddress}`)
  }

  return tokenData
}

// Export the batch fetching function as well for use in route handlers
export { fetchTokensFromJupiterV2 }

export type JupiterVolumeWindow = '5m' | '1h' | '6h' | '24h'

export type JupiterMarketHints = {
  usdPrice: number | null
  volume5m: number | null
  mcap: number | null
  /** Which Jupiter stats window supplied volume5m (may be longer than 5m). */
  volumeWindow: JupiterVolumeWindow | null
}

function finiteOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function volumeFromStats(stats: Record<string, unknown> | null): number | null {
  if (!stats) return null
  const buy = finiteOrNull(stats.buyVolume)
  const sell = finiteOrNull(stats.sellVolume)
  if (buy == null && sell == null) return null
  return (buy ?? 0) + (sell ?? 0)
}

/**
 * Parse usdPrice + volume + mcap from lite-api v2 search JSON.
 * Volume waterfall: stats5m → stats1h → stats6h → stats24h (buy+sell).
 */
export function parseJupiterV2MarketHints(
  raw: unknown,
  mintAddress?: string,
): JupiterMarketHints | null {
  let token: Record<string, unknown> | null = null

  if (Array.isArray(raw)) {
    const match = mintAddress
      ? raw.find(
          (t) =>
            t &&
            typeof t === 'object' &&
            (t as { id?: string }).id === mintAddress,
        )
      : raw[0]
    token =
      match && typeof match === 'object'
        ? (match as Record<string, unknown>)
        : null
  } else if (raw && typeof raw === 'object') {
    token = raw as Record<string, unknown>
  }

  if (!token) return null

  const usdPrice = finiteOrNull(token.usdPrice)
  const mcap = finiteOrNull(token.mcap) ?? finiteOrNull(token.fdv)

  const windows: { key: JupiterVolumeWindow; field: string }[] = [
    { key: '5m', field: 'stats5m' },
    { key: '1h', field: 'stats1h' },
    { key: '6h', field: 'stats6h' },
    { key: '24h', field: 'stats24h' },
  ]

  let volume5m: number | null = null
  let volumeWindow: JupiterVolumeWindow | null = null
  for (const w of windows) {
    const stats =
      token[w.field] && typeof token[w.field] === 'object'
        ? (token[w.field] as Record<string, unknown>)
        : null
    const vol = volumeFromStats(stats)
    if (vol != null) {
      volume5m = vol
      volumeWindow = w.key
      break
    }
  }

  if (usdPrice == null && volume5m == null && mcap == null) return null

  return { usdPrice, volume5m, mcap, volumeWindow }
}

/** Rate-limited Jupiter v2 search → price + 5m volume for monitor/entry enrichment. */
export async function fetchJupiterMarketHints(
  mintAddress: string,
): Promise<JupiterMarketHints | null> {
  try {
    const raw = await fetchJupiterV2SearchRaw(mintAddress)
    return parseJupiterV2MarketHints(raw, mintAddress)
  } catch {
    return null
  }
}

/** Full lite-api v2 search JSON (unmapped) for a single mint. */
export async function fetchJupiterV2SearchRaw(
  mintAddress: string,
  _retryCount = 0,
): Promise<unknown> {
  void _retryCount
  return fetchSearchJson(mintAddress)
}

/** datapi.jup.ag assets search — raw JSON for token locate. */
export async function fetchJupiterDatapiSearchRaw(mintAddress: string): Promise<unknown> {
  const response = await fetch(
    `https://datapi.jup.ag/v1/assets/search?query=${encodeURIComponent(mintAddress)}`,
    {
      headers: {
        accept: 'application/json',
        referer: 'https://jup.ag/',
        'user-agent': 'ReloadSol-API/1.0',
      },
    },
  )
  if (!response.ok) {
    throw new Error(`datapi HTTP ${response.status}`)
  }
  return response.json()
}