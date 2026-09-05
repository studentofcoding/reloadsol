import { listStrategyOutcomes } from '@/strategies/db'
import { fetchTrackerTokenMetrics } from '@/strategies/sim-monitor-snapshots'
import { parsePriceHistory } from '@/strategies/trade-window-chart-data'
import type { TokenMapDomain } from '@/strategies/token-map-types'
import type { OhlcRugBar } from '@/strategies/ohlc-rug-rules'
import { tokenKline } from '@/utils/gmgn-api'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

/** ponytail: 90s collapses Telegram + Freeview + label capture bursts; upgrade = longer TTL + stampede lock */
export const OHLC_24H_1M_CACHE_TTL_SEC = 90
/** Skip stuck Redis connect/get so Freeview/Telegram still hit ST */
const OHLC_CACHE_GET_TIMEOUT_MS = 400

function ohlc24h1mCacheKey(tokenAddress: string): string {
  return `ohlc:v1:24h1m:${tokenAddress}`
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export type TokenChartPoint = {
  t: number
  priceUsd: number
  volume?: number
}

export type TokenChartOutcomeSegment = {
  id: string
  domain: TokenMapDomain
  strategyId: string
  status: string | null
  pnlPct: number | null
  entryAt: string | null
  exitAt: string | null
  isSimulated: boolean
}

export type TokenOhlcBar = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export type TokenMapChartPayload = {
  tokenAddress: string
  hours: number
  points: TokenChartPoint[]
  outcomes: TokenChartOutcomeSegment[]
  candles: TokenOhlcBar[]
  priceSource: 'tracker' | 'empty'
  ohlcSource: 'none' | string
}

const DOMAIN_OK = new Set<TokenMapDomain>([
  'mcap_tracker',
  'signals',
  'gmgn',
  'trending_bot',
  'dlmm',
  'social',
])

function domainFromOutcome(domain: string | null): TokenMapDomain {
  if (domain && DOMAIN_OK.has(domain as TokenMapDomain)) {
    return domain as TokenMapDomain
  }
  return 'infra'
}

function toUnixSec(iso: string): number | null {
  const ms = new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 1000)
}

const ST_CHART_BASE = 'https://data.solanatracker.io/chart'

export function ohlcIntervalForHours(hours: number): string {
  if (hours <= 6) return '1m'
  if (hours <= 24) return '5m'
  return '15m'
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function mapStBars(raw: unknown): TokenOhlcBar[] {
  if (!Array.isArray(raw)) return []
  const out: TokenOhlcBar[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const time = num(r.time)
    const open = num(r.open)
    const high = num(r.high)
    const low = num(r.low)
    const close = num(r.close)
    if (time == null || open == null || high == null || low == null || close == null) {
      continue
    }
    const volume = num(r.volume)
    out.push({
      time: Math.floor(time),
      open,
      high,
      low,
      close,
      ...(volume != null ? { volume } : {}),
    })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

function klineList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return []
  const rec = raw as Record<string, unknown>
  for (const key of ['list', 'kline', 'candles'] as const) {
    const v = rec[key]
    if (Array.isArray(v)) return v
  }
  return []
}

function toUnixBarTime(v: number): number {
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v)
}

/** Map GMGN token_kline payload to chart bars. */
export function mapGmgnKlineBars(raw: unknown): TokenOhlcBar[] {
  const out: TokenOhlcBar[] = []
  for (const row of klineList(raw)) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const timeRaw = num(r.time) ?? num(r.timestamp) ?? num(r.t)
    const open = num(r.open) ?? num(r.o)
    const high = num(r.high) ?? num(r.h)
    const low = num(r.low) ?? num(r.l)
    const close = num(r.close) ?? num(r.c)
    if (
      timeRaw == null ||
      open == null ||
      high == null ||
      low == null ||
      close == null
    ) {
      continue
    }
    const volume = num(r.volume) ?? num(r.v)
    out.push({
      time: toUnixBarTime(timeRaw),
      open,
      high,
      low,
      close,
      ...(volume != null ? { volume } : {}),
    })
  }
  out.sort((a, b) => a.time - b.time)
  return out
}

function wantsGmgnOhlc(
  chain: GmgnTradeChain | undefined,
  tokenAddress: string,
): boolean {
  return chain === 'robinhood' || /^0x[a-fA-F0-9]{40}$/i.test(tokenAddress)
}

function ohlcWindow(params: {
  hours?: number
  interval?: string
  timeFrom?: number
  timeTo?: number
}): { timeFrom: number; timeTo: number; type: string } {
  const nowSec = Math.floor(Date.now() / 1000)
  let timeTo =
    params.timeTo != null && Number.isFinite(params.timeTo)
      ? Math.floor(params.timeTo)
      : nowSec
  let timeFrom =
    params.timeFrom != null && Number.isFinite(params.timeFrom)
      ? Math.floor(params.timeFrom)
      : null

  if (timeFrom == null) {
    const hours = Math.min(Math.max(params.hours ?? 24, 1), 168)
    timeFrom = timeTo - hours * 60 * 60
  }

  if (timeFrom >= timeTo) {
    timeFrom = timeTo - 3600
  }

  const spanHours = Math.max(1, Math.ceil((timeTo - timeFrom) / 3600))
  const hoursClamped = Math.min(spanHours, 168)
  const type =
    params.interval?.trim() || ohlcIntervalForHours(hoursClamped)
  return { timeFrom, timeTo, type }
}

/** Live OHLCV: Solana Tracker on sol, GMGN kline on robinhood / 0x. */
export async function fetchTokenOhlc(params: {
  tokenAddress: string
  hours?: number
  interval?: string
  chain?: GmgnTradeChain
  /** Unix seconds — when set with timeTo, overrides hours window. */
  timeFrom?: number
  timeTo?: number
}): Promise<{ candles: TokenOhlcBar[]; source: string }> {
  const { timeFrom, timeTo, type } = ohlcWindow(params)
  const gmgnChain: GmgnTradeChain =
    params.chain ??
    (/^0x[a-fA-F0-9]{40}$/i.test(params.tokenAddress) ? 'robinhood' : 'sol')
  if (wantsGmgnOhlc(gmgnChain, params.tokenAddress)) {
    try {
      const raw = await tokenKline({
        chain: gmgnChain,
        address: params.tokenAddress,
        resolution: type,
        from: timeFrom,
        to: timeTo,
      })
      const candles = mapGmgnKlineBars(raw)
      if (candles.length === 0) return { candles: [], source: 'none' }
      return { candles, source: 'gmgn' }
    } catch {
      return { candles: [], source: 'none' }
    }
  }

  const apiKey = process.env.SOLANATRACKER_DATA_API_KEY?.trim()
  if (!apiKey) return { candles: [], source: 'none' }

  const url = new URL(
    `${ST_CHART_BASE}/${encodeURIComponent(params.tokenAddress)}`,
  )
  url.searchParams.set('type', type)
  url.searchParams.set('time_from', String(timeFrom))
  url.searchParams.set('time_to', String(timeTo))
  url.searchParams.set('currency', 'usd')

  try {
    const res = await fetch(url.toString(), {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return { candles: [], source: 'none' }
    const body = (await res.json()) as Record<string, unknown>
    const candles = mapStBars(body.oclhv ?? body.ohlcv)
    if (candles.length === 0) return { candles: [], source: 'none' }
    return { candles, source: 'solanatracker' }
  } catch {
    return { candles: [], source: 'none' }
  }
}

export function tokenOhlcToRugBars(candles: TokenOhlcBar[]): OhlcRugBar[] {
  return candles.map((c) => ({
    t: c.time,
    o: c.open,
    h: c.high,
    l: c.low,
    c: c.close,
    ...(c.volume != null ? { v: c.volume } : {}),
  }))
}

/**
 * Canonical last-24h × 1m series (cached). Telegram / rug-10 / signal_ohlc_labels derive from this.
 */
export async function getCachedTokenOhlc24h1m(
  tokenAddress: string,
): Promise<{ candles: TokenOhlcBar[]; source: string }> {
  const key = ohlc24h1mCacheKey(tokenAddress)
  try {
    const cached = await withTimeout(
      cacheGet<{ candles: TokenOhlcBar[]; source: string }>(key),
      OHLC_CACHE_GET_TIMEOUT_MS,
    )
    if (cached && Array.isArray(cached.candles) && cached.candles.length > 0) {
      return cached
    }
  } catch {
    /* fail-open: Redis hang/timeout → ST */
  }

  const result = await fetchTokenOhlc({
    tokenAddress,
    hours: 24,
    interval: '1m',
  })
  if (result.candles.length > 0) {
    try {
      await withTimeout(
        cacheSet(key, result, OHLC_24H_1M_CACHE_TTL_SEC),
        OHLC_CACHE_GET_TIMEOUT_MS,
      )
    } catch {
      /* fail-open */
    }
  }
  return result
}

export async function loadTokenMapChart(params: {
  tokenAddress: string
  hours?: number
  chain?: GmgnTradeChain
}): Promise<TokenMapChartPayload> {
  const hours = Math.min(Math.max(params.hours ?? 24, 1), 168)
  const sinceMs = Date.now() - hours * 60 * 60 * 1000
  const sinceIso = new Date(sinceMs).toISOString()
  const chain =
    params.chain ??
    (/^0x[a-fA-F0-9]{40}$/i.test(params.tokenAddress) ? 'robinhood' : 'sol')

  const [metrics, outcomesResult, ohlc] = await Promise.all([
    fetchTrackerTokenMetrics(params.tokenAddress),
    listStrategyOutcomes({
      tokenAddress: params.tokenAddress,
      chain,
      limit: 100,
      offset: 0,
    }),
    fetchTokenOhlc({ tokenAddress: params.tokenAddress, hours, chain }),
  ])

  const history = parsePriceHistory(metrics?.price_history)
  const points: TokenChartPoint[] = []
  for (const p of history) {
    const t = toUnixSec(p.timestamp)
    if (t == null) continue
    if (t * 1000 < sinceMs) continue
    points.push({
      t,
      priceUsd: p.price_usd,
      volume:
        typeof p.volume_5m === 'number' && Number.isFinite(p.volume_5m)
          ? p.volume_5m
          : undefined,
    })
  }
  points.sort((a, b) => a.t - b.t)

  // Deduplicate same-second stamps (keep last)
  const deduped: TokenChartPoint[] = []
  for (const p of points) {
    const last = deduped[deduped.length - 1]
    if (last && last.t === p.t) {
      deduped[deduped.length - 1] = p
    } else {
      deduped.push(p)
    }
  }

  const outcomes: TokenChartOutcomeSegment[] = []
  for (const row of outcomesResult.rows) {
    const entryAt = row.entry_at
    const exitAt = row.exit_at
    if (exitAt && exitAt < sinceIso && (!entryAt || entryAt < sinceIso)) {
      continue
    }
    if (!entryAt && !exitAt) continue
    outcomes.push({
      id: row.id,
      domain: domainFromOutcome(row.domain),
      strategyId: row.strategy_id,
      status: row.status,
      pnlPct: row.pnl_pct,
      entryAt,
      exitAt,
      isSimulated: row.is_simulated,
    })
  }

  return {
    tokenAddress: params.tokenAddress,
    hours,
    points: deduped,
    outcomes,
    candles: ohlc.candles,
    priceSource: deduped.length > 0 ? 'tracker' : 'empty',
    ohlcSource: ohlc.source,
  }
}
