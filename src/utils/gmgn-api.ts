import { randomUUID } from 'crypto'
import type { GmgnTrackResponse, GmgnTrackRow } from './gmgn-cli'

const DEFAULT_HOST = 'https://openapi.gmgn.ai'
const DEFAULT_TIMEOUT_MS = 15_000

export class GmgnApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly resetAt?: number,
  ) {
    super(message)
    this.name = 'GmgnApiError'
  }
}

function getApiKey(): string {
  const key = process.env.GMGN_API_KEY?.trim()
  if (!key) {
    throw new GmgnApiError('GMGN_API_KEY is not set')
  }
  return key
}

function getHost(): string {
  return process.env.GMGN_API_HOST?.trim() || DEFAULT_HOST
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseResetAt(headers: Headers, body: unknown): number | undefined {
  const headerReset = headers.get('X-RateLimit-Reset') ?? headers.get('x-ratelimit-reset')
  if (headerReset) {
    const n = Number(headerReset)
    if (Number.isFinite(n)) return n
  }
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const data = record.data
    if (data && typeof data === 'object') {
      const reset = (data as Record<string, unknown>).reset_at
      if (typeof reset === 'number' && Number.isFinite(reset)) return reset
    }
    const reset = record.reset_at
    if (typeof reset === 'number' && Number.isFinite(reset)) return reset
  }
  return undefined
}

function unwrapApiData<T>(body: unknown): T {
  if (!body || typeof body !== 'object') {
    throw new GmgnApiError('Invalid GMGN API response')
  }
  const record = body as Record<string, unknown>
  const code = record.code
  if (code !== 0 && code !== '0') {
    const msg =
      typeof record.msg === 'string'
        ? record.msg
        : typeof record.message === 'string'
          ? record.message
          : `GMGN API error (code=${String(code)})`
    throw new GmgnApiError(msg, String(code))
  }
  if ('data' in record) {
    return record.data as T
  }
  return body as T
}

async function gmgnFetch(path: string, query: Record<string, string> = {}): Promise<unknown> {
  const apiKey = getApiKey()
  const host = getHost()
  const params = new URLSearchParams(query)
  params.set('timestamp', String(Math.floor(Date.now() / 1000)))
  params.set('client_id', randomUUID())

  const url = `${host}${path}?${params.toString()}`
  const maxAttempts = 2

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-APIKEY': apiKey,
        },
        signal: controller.signal,
      })

      const text = await response.text()
      let body: unknown = null
      if (text.trim()) {
        try {
          body = JSON.parse(text) as unknown
        } catch {
          throw new GmgnApiError(`Invalid JSON from GMGN API: ${text.slice(0, 200)}`)
        }
      }

      if (response.status === 429) {
        const resetAt = parseResetAt(response.headers, body)
        if (attempt < maxAttempts) {
          const waitMs = resetAt
            ? Math.min(Math.max(resetAt * 1000 - Date.now(), 1000), 30_000)
            : 3000
          await sleep(waitMs)
          continue
        }
        throw new GmgnApiError('GMGN rate limit exceeded', 'RATE_LIMIT', resetAt)
      }

      if (!response.ok) {
        const msg =
          body && typeof body === 'object' && 'msg' in body
            ? String((body as Record<string, unknown>).msg)
            : `GMGN HTTP ${response.status}`
        throw new GmgnApiError(msg)
      }

      return body
    } catch (error) {
      if (error instanceof GmgnApiError) throw error
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GmgnApiError('GMGN API request timed out')
      }
      throw new GmgnApiError(error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timer)
    }
  }

  throw new GmgnApiError('GMGN API failed after retries')
}

export async function trackSmartMoney(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  const query: Record<string, string> = {
    chain: params.chain,
    limit: String(params.limit ?? 20),
  }
  if (params.side) query.side = params.side
  const raw = unwrapApiData<GmgnTrackResponse>(await gmgnFetch('/v1/user/smartmoney', query))
  return raw.list ?? []
}

export async function trackKol(params: {
  chain: string
  side?: 'buy' | 'sell'
  limit?: number
}): Promise<GmgnTrackRow[]> {
  const query: Record<string, string> = {
    chain: params.chain,
    limit: String(params.limit ?? 20),
  }
  if (params.side) query.side = params.side
  const raw = unwrapApiData<GmgnTrackResponse>(await gmgnFetch('/v1/user/kol', query))
  return raw.list ?? []
}

export async function tokenInfo(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  const data = unwrapApiData<Record<string, unknown>>(
    await gmgnFetch('/v1/token/info', {
      chain: params.chain,
      address: params.address,
    }),
  )
  return data ?? {}
}

export async function tokenSecurity(params: {
  chain: string
  address: string
}): Promise<Record<string, unknown>> {
  const data = unwrapApiData<Record<string, unknown>>(
    await gmgnFetch('/v1/token/security', {
      chain: params.chain,
      address: params.address,
    }),
  )
  return data ?? {}
}

export type GmgnMarketRankRow = Record<string, unknown> & {
  address?: string
  symbol?: string
  name?: string
  market_cap?: number
  volume?: number
  liquidity?: number
  holder_count?: number
  launchpad?: string
  launchpad_platform?: string
  website?: string
  twitter_username?: string
  telegram?: string
  price_change_percent?: number
  hot_level?: number
  smart_degen_count?: number
  renowned_count?: number
  visiting_count?: number
}

export type MarketTrendingParams = {
  chain: string
  interval: string
  limit?: number
  minMarketcap?: number
  minVolume?: number
  orderBy?: string
  direction?: 'asc' | 'desc'
}

export async function marketTrending(
  params: MarketTrendingParams,
): Promise<GmgnMarketRankRow[]> {
  const query: Record<string, string> = {
    chain: params.chain,
    interval: params.interval,
    limit: String(params.limit ?? 100),
  }
  if (params.minMarketcap != null) query.min_marketcap = String(params.minMarketcap)
  if (params.minVolume != null) query.min_volume = String(params.minVolume)
  if (params.orderBy) query.orderby = params.orderBy
  if (params.direction) query.direction = params.direction

  const data = unwrapApiData<{ rank?: GmgnMarketRankRow[] }>(
    await gmgnFetch('/v1/market/rank', query),
  )
  return Array.isArray(data?.rank) ? data.rank : []
}
