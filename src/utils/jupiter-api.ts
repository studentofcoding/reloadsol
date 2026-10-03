// Jupiter API utility with v2/v3 compatibility and centralized configuration
import { throttleJupiterRps } from './jupiter-rps'

// API Configuration
const JUPITER_API_CONFIG = {
  // Primary version to try first - now using v3 only
  PRIMARY_VERSION: 'v3' as 'v2' | 'v3',
  // Fallback version if primary fails
  FALLBACK_VERSION: 'v2' as 'v2' | 'v3',
  // Disable automatic fallback - using v3 only
  AUTO_FALLBACK: false,
  BASE_URL: 'https://api.jup.ag/price',
  MAX_TOKENS_PER_REQUEST: 50,
  REQUEST_TIMEOUT: 7000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000,
}

/**
 * After a 429 the price API is left alone for this long (Retry-After honoured, clamped). The old
 * behaviour was 3 more attempts 1 s apart — three extra 429s inside the same throttle window, from every
 * concurrent caller — which kept the limiter engaged. Callers already have a stale/other-source path.
 */
const RATE_LIMIT_BACKOFF_DEFAULT_MS = 30_000
const RATE_LIMIT_BACKOFF_MIN_MS = 5_000
const RATE_LIMIT_BACKOFF_MAX_MS = 60_000
let rateLimitedUntilMs = 0

/**
 * Backoff ms for a 429. `x-ratelimit-reset` (absolute epoch seconds, the end of the 10 s sliding window)
 * wins when present, so one window is waited out instead of a blind 30 s; otherwise `Retry-After`
 * (seconds or HTTP date); otherwise the 30 s default. Clamped to the 5..60 s range, except a
 * reset-derived wait which may be as short as 2 s. Pure.
 */
export function jupiterPriceBackoffMs(
  retryAfter: string | null,
  nowMs: number = Date.now(),
  resetEpochSec: string | null = null,
): number {
  const resetSec = Number(resetEpochSec)
  if (resetEpochSec && Number.isFinite(resetSec) && resetSec * 1000 > nowMs && resetSec * 1000 - nowMs <= 60_000) {
    return Math.min(RATE_LIMIT_BACKOFF_MAX_MS, Math.max(2_000, Math.ceil(resetSec * 1000 - nowMs) + 500))
  }
  let ms = RATE_LIMIT_BACKOFF_DEFAULT_MS
  if (retryAfter?.trim()) {
    const t = retryAfter.trim()
    const n = Number(t)
    if (Number.isFinite(n) && n >= 0) ms = n * 1000
    else {
      const d = Date.parse(t)
      if (Number.isFinite(d)) ms = d - nowMs
    }
  }
  return Math.min(RATE_LIMIT_BACKOFF_MAX_MS, Math.max(RATE_LIMIT_BACKOFF_MIN_MS, Math.ceil(ms)))
}

/**
 * Record a 429 from ANY keyed Price V3 caller (this file and usd-prices.ts share one cooldown, so a
 * 429 seen by one stops the others instead of each rediscovering it).
 */
export function noteJupiterPriceRateLimited(
  headers: { get(name: string): string | null },
  nowMs: number = Date.now(),
): number {
  const ms = jupiterPriceBackoffMs(headers.get('retry-after'), nowMs, headers.get('x-ratelimit-reset'))
  rateLimitedUntilMs = Math.max(rateLimitedUntilMs, nowMs + ms)
  return ms
}

/** Milliseconds of 429 backoff left (0 = free to call). */
export function jupiterPriceBackoffRemainingMs(nowMs: number = Date.now()): number {
  return Math.max(0, rateLimitedUntilMs - nowMs)
}

export function __resetJupiterPriceBackoffForTests(): void {
  rateLimitedUntilMs = 0
  priceInflight.clear()
  priceRecent.clear()
}

// Single-flight + short result cache for identical id sets: concurrent callers (and the 10+ call
// sites that ask for the same SOL price) share one upstream request instead of each spending a token.
const PRICE_RESULT_TTL_MS = 3_000
const priceInflight = new Map<string, Promise<Record<string, TokenPriceData>>>()
const priceRecent = new Map<string, { at: number; value: Record<string, TokenPriceData> }>()
const priceKey = (tokens: string[]) => [...new Set(tokens)].sort().join(',')

// Response type definitions
interface JupiterV2Response {
  data: Record<string, {
    id: string
    type: string
    price: string
  }>
  timeTaken: number
}

interface JupiterV3Response {
  [tokenId: string]: {
    usdPrice: number
    blockId: number
    decimals: number
    priceChange24h: number
  }
}

// Normalized price data interface
export interface TokenPriceData {
  price: number
  decimals?: number
  priceChange24h?: number
  blockId?: number
  source: 'v2' | 'v3'
}

// Error types
export class JupiterAPIError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public isRateLimit: boolean = false
  ) {
    super(message)
    this.name = 'JupiterAPIError'
  }
}

// Utility function to build API URL with specific version
function buildApiUrl(tokens: string[], version: 'v2' | 'v3'): string {
  const baseUrl = JUPITER_API_CONFIG.BASE_URL
  const tokenIds = tokens.join(',')

  return `${baseUrl}/${version}?ids=${tokenIds}`
}

// Utility function to normalize response data
function normalizeResponse(
  response: JupiterV2Response | JupiterV3Response,
  version: 'v2' | 'v3'
): Record<string, TokenPriceData> {
  const normalized: Record<string, TokenPriceData> = {}

  if (version === 'v2') {
    const v2Response = response as JupiterV2Response
    if (v2Response.data) {
      Object.entries(v2Response.data).forEach(([tokenId, data]) => {
        if (data && data.price) {
          normalized[tokenId] = {
            price: parseFloat(data.price),
            source: 'v2'
          }
        }
      })
    }
  } else {
    const v3Response = response as JupiterV3Response
    Object.entries(v3Response).forEach(([tokenId, data]) => {
      if (data && typeof data.usdPrice === 'number') {
        normalized[tokenId] = {
          price: data.usdPrice,
          decimals: data.decimals,
          priceChange24h: data.priceChange24h,
          blockId: data.blockId,
          source: 'v3'
        }
      }
    })
  }

  return normalized
}

// Core function to fetch prices from Jupiter API with automatic fallback
export async function fetchTokenPrices(
  tokens: string[],
  options: {
    timeout?: number
    retries?: number
    retryDelay?: number
  } = {}
): Promise<Record<string, TokenPriceData>> {
  if (tokens.length === 0) {
    return {}
  }

  if (tokens.length > JUPITER_API_CONFIG.MAX_TOKENS_PER_REQUEST) {
    throw new JupiterAPIError(
      `Too many tokens requested. Maximum ${JUPITER_API_CONFIG.MAX_TOKENS_PER_REQUEST} per request.`
    )
  }

  const {
    timeout = JUPITER_API_CONFIG.REQUEST_TIMEOUT,
    retries = JUPITER_API_CONFIG.RETRY_ATTEMPTS,
    retryDelay = JUPITER_API_CONFIG.RETRY_DELAY
  } = options

  // Try primary version first
  const primaryVersion = JUPITER_API_CONFIG.PRIMARY_VERSION
  const fallbackVersion = JUPITER_API_CONFIG.FALLBACK_VERSION

  const key = priceKey(tokens)
  const recent = priceRecent.get(key)
  if (recent && Date.now() - recent.at < PRICE_RESULT_TTL_MS) return recent.value
  const running = priceInflight.get(key)
  if (running) return running

  try {
    const pending = fetchTokenPricesWithVersion(tokens, primaryVersion, { timeout, retries, retryDelay })
    priceInflight.set(key, pending)
    const result = await pending.finally(() => priceInflight.delete(key))
    priceRecent.set(key, { at: Date.now(), value: result })
    if (priceRecent.size > 200) priceRecent.delete(priceRecent.keys().next().value as string)
    return result
  } catch (error: unknown) {
    // Since auto-fallback is disabled in v3-only mode, just throw the error
    // Log the error for monitoring
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`[Jupiter API] v3 request failed:`, {
      error: errorMessage,
      statusCode: error instanceof JupiterAPIError ? error.statusCode : 'unknown',
      tokenCount: tokens.length,
      timestamp: new Date().toISOString()
    })

    throw error
  }
}

// Internal function to fetch prices with a specific API version
async function fetchTokenPricesWithVersion(
  tokens: string[],
  version: 'v2' | 'v3',
  options: {
    timeout: number
    retries: number
    retryDelay: number
  }
): Promise<Record<string, TokenPriceData>> {
  const { timeout, retries, retryDelay } = options
  const url = buildApiUrl(tokens, version)

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const backoffLeft = jupiterPriceBackoffRemainingMs()
      if (backoffLeft > 0) {
        // In a 429 window: don't touch the API at all (and don't retry — see RATE_LIMIT_BACKOFF_*).
        throw new JupiterAPIError(
          `Jupiter price API in 429 backoff (${Math.ceil(backoffLeft / 1000)}s left)`,
          429,
          true,
        )
      }
      // Same bucket as Swap/`usd-prices`: take a token from the shared gate (this path used to skip it).
      await throttleJupiterRps('background')
      console.log(`Fetching prices for ${tokens.length} tokens (attempt ${attempt + 1}/${retries + 1})`, {
        version,
        url: url.replace(/ids=[^&]*/, 'ids=...')
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const headers: Record<string, string> = {
        'accept': 'application/json',
        'cache-control': 'no-cache',
        'user-agent': 'BuyBulk/1.0'
      }
      const apiKey = process.env.JUPITER_API_KEY?.trim()
      if (apiKey) headers['x-api-key'] = apiKey

      const response = await fetch(url, {
        headers,
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (response.status === 429) {
        noteJupiterPriceRateLimited(response.headers)
        throw new JupiterAPIError('Rate limited by Jupiter API', 429, true)
      }

      if (!response.ok) {
        throw new JupiterAPIError(
          `Jupiter API error: ${response.status} ${response.statusText}`,
          response.status
        )
      }

      const data = await response.json()
      const normalized = normalizeResponse(data, version)

      console.log(`Successfully fetched ${Object.keys(normalized).length}/${tokens.length} prices`)

      return normalized

    } catch (error) {
      const isLastAttempt = attempt === retries

      if (error instanceof JupiterAPIError) {
        // A rate limit is never retried in a burst: the backoff window above replaces it.
        throw error
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new JupiterAPIError('Request timeout')
      }

      if (isLastAttempt) {
        throw new JupiterAPIError(
          `Failed to fetch prices after ${retries + 1} attempts: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
      }

      console.warn(`Attempt ${attempt + 1} failed, retrying in ${retryDelay}ms...`, error)
      await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
  }

  // This should never be reached, but TypeScript requires it
  throw new JupiterAPIError('Unexpected error in fetchTokenPricesWithVersion')
}

// Batch function to handle large token lists
export async function fetchTokenPricesBatch(
  tokens: string[],
  options: {
    batchSize?: number
    batchDelay?: number
    timeout?: number
    retries?: number
    retryDelay?: number
  } = {}
): Promise<Record<string, TokenPriceData>> {
  const {
    batchSize = JUPITER_API_CONFIG.MAX_TOKENS_PER_REQUEST,
    batchDelay = 100,
    ...fetchOptions
  } = options

  if (tokens.length <= batchSize) {
    return fetchTokenPrices(tokens, fetchOptions)
  }

  const results: Record<string, TokenPriceData> = {}
  const chunks = []

  for (let i = 0; i < tokens.length; i += batchSize) {
    chunks.push(tokens.slice(i, i + batchSize))
  }

  console.log(`Processing ${tokens.length} tokens in ${chunks.length} batches`)

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]

    try {
      const chunkResults = await fetchTokenPrices(chunk, fetchOptions)
      Object.assign(results, chunkResults)

      // Add delay between batches to avoid rate limiting
      if (i < chunks.length - 1 && batchDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, batchDelay))
      }
    } catch (error) {
      console.error(`Batch ${i + 1}/${chunks.length} failed:`, error)
    }
  }

  return results
}

// Helper function to get just the prices (backward compatibility)
export async function getTokenPrices(tokens: string[]): Promise<Record<string, number>> {
  const priceData = await fetchTokenPricesBatch(tokens)
  const prices: Record<string, number> = {}
  Object.entries(priceData).forEach(([token, data]) => {
    prices[token] = data.price
  })
  return prices
}

// Helper function to get a single token price
export async function getTokenPrice(token: string): Promise<number> {
  const prices = await getTokenPrices([token])
  return prices[token] || 0
}

export function getJupiterApiVersion(): 'v2' | 'v3' {
  return JUPITER_API_CONFIG.PRIMARY_VERSION
}

export function getJupiterApiFallbackVersion(): 'v2' | 'v3' {
  return JUPITER_API_CONFIG.FALLBACK_VERSION
}

export function setJupiterApiFallbackVersion(version: 'v2' | 'v3'): void {
  JUPITER_API_CONFIG.FALLBACK_VERSION = version
  console.log(`Jupiter API fallback version set to ${version}`)
}

export function getJupiterApiConfig(): typeof JUPITER_API_CONFIG {
  return { ...JUPITER_API_CONFIG }
}

/** Raw Price V3 JSON for token locate (unmapped). */
export async function fetchJupiterPriceRaw(token: string): Promise<unknown> {
  const backoffLeft = jupiterPriceBackoffRemainingMs()
  if (backoffLeft > 0) {
    throw new JupiterAPIError(`Jupiter price API in 429 backoff (${Math.ceil(backoffLeft / 1000)}s left)`, 429, true)
  }
  await throttleJupiterRps('background')
  const url = `${JUPITER_API_CONFIG.BASE_URL}/v3?ids=${encodeURIComponent(token)}`
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'BuyBulk/1.0',
  }
  const apiKey = process.env.JUPITER_API_KEY?.trim()
  if (apiKey) headers['x-api-key'] = apiKey
  const response = await fetch(url, {
    headers,
  })
  if (response.status === 429) noteJupiterPriceRateLimited(response.headers)
  if (!response.ok) {
    throw new Error(`price HTTP ${response.status}`)
  }
  return response.json()
}

const jupiterApi = {
  fetchTokenPrices,
  fetchTokenPricesBatch,
  getTokenPrices,
  getTokenPrice,
  getJupiterApiVersion,
  getJupiterApiFallbackVersion,
  setJupiterApiFallbackVersion,
  getJupiterApiConfig,
  JupiterAPIError,
};

export default jupiterApi;