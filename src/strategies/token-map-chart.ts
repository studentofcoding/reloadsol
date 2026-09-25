import { listStrategyOutcomes } from '@/strategies/db'
import { query } from '@/utils/db'
import {
  fetchOutcomeMonitorPriceHistory,
  fetchTrackerTokenMetrics,
} from '@/strategies/sim-monitor-snapshots'
import { parsePriceHistory } from '@/strategies/trade-window-chart-data'
import type { TokenMapDomain } from '@/strategies/token-map-types'
import type { OhlcRugBar } from '@/strategies/ohlc-rug-rules'
import { fetchTokenMapActivity } from '@/strategies/token-map-activity'
import {
  SHORT_OHLC_FETCH_MAX_SPAN_SEC,
  chartWindowHours,
  resolveFreeviewChartWindow,
} from '@/strategies/token-map-chart-window'
import { tokenKline } from '@/utils/gmgn-api'
import type { GmgnTradeChain } from '@/utils/gmgn-currencies'
import {
  brainOhlcSourceLabel,
  fetchBrainOhlc,
  inferBrainOhlcChain,
  isMarketBrainOhlcEnabled,
  shouldFallbackBrainOhlc,
  type MarketBrainFetchOpts,
} from '@/utils/market-brain'
import { cacheGet, cacheSet } from '@/utils/redis-cache'
import { acquireSolanaTrackerOhlcSlot } from '@/utils/solanatracker-ohlc-limit'

/** ponytail: 10m collapses Freeview+Telegram+shadow bursts; last-good covers 429 */
export const OHLC_24H_1M_CACHE_TTL_SEC = 600
/** Keep a successful series for stale serve after soft TTL / upstream fail */
export const OHLC_24H_1M_LAST_GOOD_TTL_SEC = 86_400
/** Skip stuck Redis connect/get so Freeview/Telegram still hit ST */
const OHLC_CACHE_GET_TIMEOUT_MS = 400
/**
 * Freeview token-chart must finish under Cloudflare ~100s.
 * Budget OHLC cold fill so we return partial/stale instead of hanging.
 */
export const TOKEN_MAP_CHART_OHLC_BUDGET_MS = 22_000

function ohlc24h1mCacheKey(tokenAddress: string): string {
  return `ohlc:v1:24h1m:${tokenAddress}`
}

function ohlc24h1mLastGoodKey(tokenAddress: string): string {
  return `ohlc:v1:24h1m:last:${tokenAddress}`
}

type OhlcCachePayload = { candles: TokenOhlcBar[]; source: string }

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

async function readOhlcCache(
  key: string,
): Promise<OhlcCachePayload | null> {
  try {
    const cached = await withTimeout(
      cacheGet<OhlcCachePayload>(key),
      OHLC_CACHE_GET_TIMEOUT_MS,
    )
    if (cached && Array.isArray(cached.candles) && cached.candles.length > 0) {
      return cached
    }
  } catch {
    /* fail-open */
  }
  return null
}

async function writeOhlcCaches(
  tokenAddress: string,
  result: OhlcCachePayload,
): Promise<void> {
  if (result.candles.length === 0) return
  const primary = ohlc24h1mCacheKey(tokenAddress)
  const last = ohlc24h1mLastGoodKey(tokenAddress)
  try {
    await withTimeout(
      Promise.all([
        cacheSet(primary, result, OHLC_24H_1M_CACHE_TTL_SEC),
        cacheSet(last, result, OHLC_24H_1M_LAST_GOOD_TTL_SEC),
      ]),
      OHLC_CACHE_GET_TIMEOUT_MS,
    )
  } catch {
    /* fail-open */
  }
}

function staleSourceLabel(base: string | undefined): string {
  const b = (base ?? '').trim()
  if (!b || b === 'none') return 'cache'
  if (b.endsWith('-stale')) return b
  return `${b}-stale`
}

export function rugBarsToTokenOhlc(bars: OhlcRugBar[]): TokenOhlcBar[] {
  return bars.map((b) => ({
    time: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    ...(b.v != null ? { volume: b.v } : {}),
  }))
}

function sliceCandlesSince(
  candles: TokenOhlcBar[],
  sinceSec: number,
): TokenOhlcBar[] {
  return candles.filter((c) => c.time >= sinceSec)
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

/** 24h window for Redis chart extend / trim (1m bars). */
export const OHLC_24H_SPAN_SEC = 24 * 60 * 60
/** Allow a couple of missing minutes before treating span as full. */
const OHLC_24H_FULL_EPSILON_SEC = 120

export function seriesSpanSec(candles: TokenOhlcBar[]): number {
  if (candles.length < 2) return 0
  let minT = candles[0]!.time
  let maxT = candles[0]!.time
  for (const c of candles) {
    if (c.time < minT) minT = c.time
    if (c.time > maxT) maxT = c.time
  }
  return Math.max(0, maxT - minT)
}

/** True when Redis series already covers ~24h — skip further GMGN fetches. */
export function isFull24h1m(
  candles: TokenOhlcBar[],
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (candles.length === 0) return false
  const span = seriesSpanSec(candles)
  if (span < OHLC_24H_SPAN_SEC - OHLC_24H_FULL_EPSILON_SEC) return false
  let maxT = candles[0]!.time
  for (const c of candles) {
    if (c.time > maxT) maxT = c.time
  }
  // Newest bar should still be inside the trailing 24h window.
  return maxT >= nowSec - OHLC_24H_SPAN_SEC
}

/** Union by time (incoming wins); drop bars older than now−24h; sort ascending. */
export function mergeOhlcCandles(
  existing: TokenOhlcBar[],
  incoming: TokenOhlcBar[],
  nowSec = Math.floor(Date.now() / 1000),
): TokenOhlcBar[] {
  const cutoff = nowSec - OHLC_24H_SPAN_SEC
  const byTime = new Map<number, TokenOhlcBar>()
  for (const c of existing) {
    if (c.time >= cutoff) byTime.set(c.time, c)
  }
  for (const c of incoming) {
    if (c.time >= cutoff) byTime.set(c.time, c)
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

/** Union by time without 24h trim (for multi-page GMGN fetch). */
export function unionOhlcCandles(
  existing: TokenOhlcBar[],
  incoming: TokenOhlcBar[],
): TokenOhlcBar[] {
  const byTime = new Map<number, TokenOhlcBar>()
  for (const c of existing) byTime.set(c.time, c)
  for (const c of incoming) byTime.set(c.time, c)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

export type TokenMapChartPayload = {
  tokenAddress: string
  hours: number
  points: TokenChartPoint[]
  outcomes: TokenChartOutcomeSegment[]
  candles: TokenOhlcBar[]
  /** Frozen Postgres detect-snapshot bars (paint layer separate from Redis). */
  detectCandles: TokenOhlcBar[]
  detectAt: string | null
  priceSource: 'tracker' | 'empty'
  ohlcSource: 'none' | string
  /** Set when load used window=auto (Freeview). */
  chartWindow?: {
    mode: 'new' | 'old'
    timeFrom: number
    timeTo: number
  }
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

/** Live OHLCV: prefer market-brain, then Solana Tracker on sol / GMGN on 0x. */
export async function fetchTokenOhlc(params: {
  tokenAddress: string
  hours?: number
  interval?: string
  chain?: GmgnTradeChain
  /** Unix seconds — when set with timeTo, overrides hours window. */
  timeFrom?: number
  timeTo?: number
  /** Test / override hook for the brain client. */
  brain?: MarketBrainFetchOpts
  /** When Redis already holds a full 24h series, skip GMGN kline. */
  skipGmgn?: boolean
  /** Remaining wall-clock budget for the fallback paging walk. */
  deadlineMs?: number
}): Promise<{ candles: TokenOhlcBar[]; source: string }> {
  const { timeFrom, timeTo, type } = ohlcWindow(params)
  const gmgnChain: GmgnTradeChain =
    params.chain ??
    (/^0x[a-fA-F0-9]{40}$/i.test(params.tokenAddress) ? 'robinhood' : 'sol')

  // ponytail: brain GET /ohlc first; ST/GMGN stay the fallback on 5xx/timeout
  if (isMarketBrainOhlcEnabled(params.brain)) {
    const explicitWindow = params.timeFrom != null || params.timeTo != null
    const hours = explicitWindow
      ? undefined
      : Math.min(Math.max(params.hours ?? 24, 1), 168)
    const brain = await fetchBrainOhlc(
      {
        mint: params.tokenAddress,
        chain: inferBrainOhlcChain(params.tokenAddress, gmgnChain),
        interval: type,
        ...(hours != null ? { hours } : {}),
        ...(explicitWindow ? { from: timeFrom, to: timeTo } : {}),
      },
      params.brain,
    )
    if (!shouldFallbackBrainOhlc(brain) && brain.ok) {
      return {
        candles: brain.data.candles,
        source: brainOhlcSourceLabel(brain.data.source),
      }
    }
  }

  return fetchTokenOhlcUpstream({
    tokenAddress: params.tokenAddress,
    timeFrom,
    timeTo,
    type,
    gmgnChain,
    skipGmgn: params.skipGmgn === true,
    deadlineMs: params.deadlineMs,
  })
}

const ST_OHLC_MAX_ATTEMPTS = 3
const ST_OHLC_RETRY_BASE_MS = 400

/**
 * Dedicated secure Data API origin. Auth is the subdomain itself.
 * Docs: https://docs.solanatracker.io/data-api/chart/get-ohlcv-data-for-a-token
 * Requests are `{origin}/chart/{token}` (`oclhv`).
 */
export const DEFAULT_SOLANATRACKER_DATA_API_BASE =
  'https://ivory-badger-5278.secure.data.solanatracker.io'

const SECURE_DATA_HOST_SUFFIX = '.secure.data.solanatracker.io'

export type SolanaTrackerOhlcRequest = {
  url: string
  /** Empty on secure hosts. Public hosts get `x-api-key` only. */
  headers: Record<string, string>
}

/**
 * Data API origin (scheme + host, no path or query).
 *
 * Env shape is an origin, for example
 * `https://ivory-badger-5278.secure.data.solanatracker.io`.
 * A trailing `/chart` or `api_key` query is ignored — chart calls always
 * use `{origin}/chart/{token}`.
 *
 * Precedence: `SOLANATRACKER_CHART_BASE`, then `SOLANATRACKER_DATA_API_BASE`,
 * then the ivory-badger secure host. An invalid value skips the chart fetch.
 */
export function solanaTrackerDataApiOrigin(): string | null {
  const raw =
    process.env.SOLANATRACKER_CHART_BASE?.trim() ||
    process.env.SOLANATRACKER_DATA_API_BASE?.trim() ||
    ''
  if (!raw) return DEFAULT_SOLANATRACKER_DATA_API_BASE
  try {
    return new URL(raw).origin
  } catch {
    console.warn(
      '[token-map-chart] invalid SolanaTracker data API base; skipping chart fetch',
    )
    return null
  }
}

/** `*.secure.data.solanatracker.io`, including the ivory-badger host. */
export function isSecureSolanaTrackerDataHost(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase()
    return (
      host.endsWith(SECURE_DATA_HOST_SUFFIX) ||
      host === 'ivory-badger-5278.secure.data.solanatracker.io'
    )
  } catch {
    return false
  }
}

/**
 * URL + headers for Solana Tracker OHLCV.
 * Secure hosts never receive `x-api-key` or `api_key`.
 * `data.solanatracker.io` (or any other non-secure origin) is used only when
 * configured, and only with `SOLANATRACKER_DATA_API_KEY` as `x-api-key`.
 * Returns null when the origin is invalid or a public host has no key.
 */
export function buildSolanaTrackerOhlcRequest(params: {
  tokenAddress: string
  type: string
  timeFrom: number
  timeTo: number
}): SolanaTrackerOhlcRequest | null {
  const origin = solanaTrackerDataApiOrigin()
  if (!origin) return null

  const url = new URL(
    `${origin}/chart/${encodeURIComponent(params.tokenAddress)}`,
  )
  url.searchParams.set('type', params.type)
  url.searchParams.set('time_from', String(params.timeFrom))
  url.searchParams.set('time_to', String(params.timeTo))
  url.searchParams.set('currency', 'usd')
  url.searchParams.delete('api_key')

  const secure = isSecureSolanaTrackerDataHost(url.origin)
  const apiKey = process.env.SOLANATRACKER_DATA_API_KEY?.trim() || ''
  if (!secure && !apiKey) return null

  const headers: Record<string, string> = {}
  if (!secure && apiKey) headers['x-api-key'] = apiKey
  return { url: url.toString(), headers }
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** GMGN token_kline returns at most ~100 bars per request. */
export const GMGN_KLINE_PAGE_BARS = 100

export function gmgnResolutionSec(resolution: string): number {
  const r = resolution.trim().toLowerCase()
  if (r === '30s') return 30
  if (r.endsWith('m')) {
    const n = Number(r.slice(0, -1))
    return Number.isFinite(n) && n > 0 ? n * 60 : 60
  }
  if (r.endsWith('h')) {
    const n = Number(r.slice(0, -1))
    return Number.isFinite(n) && n > 0 ? n * 3600 : 3600
  }
  if (r.endsWith('d')) {
    const n = Number(r.slice(0, -1))
    return Number.isFinite(n) && n > 0 ? n * 86400 : 86400
  }
  return 60
}

/**
 * Page GMGN kline across [timeFrom, timeTo] so 24h×1m is not truncated at ~100 bars.
 * Mid-walk RATE_LIMIT / errors keep bars already fetched (don't wipe the merge).
 */
export async function fetchGmgnKlinePaged(params: {
  chain: string
  address: string
  resolution: string
  timeFrom: number
  timeTo: number
  /**
   * Wall-clock budget for the whole walk. The loader passes its remaining
   * chart budget so a 24h x 1m request can't spend it all and still time out.
   */
  deadlineMs?: number
  /** Stop after this many consecutive empty pages (upstream has nothing). */
  maxEmptyPages?: number
}): Promise<TokenOhlcBar[]> {
  const resSec = gmgnResolutionSec(params.resolution)
  const pageSpanSec = GMGN_KLINE_PAGE_BARS * resSec
  const startedAt = Date.now()
  const maxEmptyPages = params.maxEmptyPages ?? 3
  let emptyPages = 0
  let cursor = params.timeFrom
  let merged: TokenOhlcBar[] = []
  let pages = 0
  const maxPages = Math.ceil(
    Math.max(1, params.timeTo - params.timeFrom) / pageSpanSec,
  ) + 1

  while (cursor < params.timeTo && pages < maxPages) {
    if (params.deadlineMs != null && Date.now() - startedAt > params.deadlineMs) {
      break
    }
    const pageEnd = Math.min(params.timeTo, cursor + pageSpanSec)
    try {
      const raw = await tokenKline({
        chain: params.chain,
        address: params.address,
        resolution: params.resolution,
        from: cursor * 1000,
        to: pageEnd * 1000,
      })
      const page = mapGmgnKlineBars(raw)
      pages++
      if (page.length === 0) {
        emptyPages++
        if (emptyPages >= maxEmptyPages) break
        cursor = pageEnd
        continue
      }
      emptyPages = 0
      merged = unionOhlcCandles(merged, page)
      const lastT = page[page.length - 1]!.time
      // Advance past last bar; avoid infinite loop on sticky timestamps.
      cursor = Math.max(pageEnd, lastT + resSec)
    } catch {
      // ponytail: RATE_LIMIT / network mid-walk — keep what we have; next cache miss extends
      break
    }
  }
  return merged.filter(
    (c) => c.time >= params.timeFrom && c.time <= params.timeTo,
  )
}

async function fetchTokenOhlcUpstream(params: {
  tokenAddress: string
  timeFrom: number
  timeTo: number
  type: string
  gmgnChain: GmgnTradeChain
  skipGmgn?: boolean
  deadlineMs?: number
}): Promise<{ candles: TokenOhlcBar[]; source: string }> {
  if (wantsGmgnOhlc(params.gmgnChain, params.tokenAddress)) {
    if (params.skipGmgn) return { candles: [], source: 'none' }
    try {
      const candles = await fetchGmgnKlinePaged({
        chain: params.gmgnChain,
        address: params.tokenAddress,
        resolution: params.type,
        timeFrom: params.timeFrom,
        timeTo: params.timeTo,
        deadlineMs: params.deadlineMs,
      })
      if (candles.length === 0) return { candles: [], source: 'none' }
      return { candles, source: 'gmgn' }
    } catch {
      return { candles: [], source: 'none' }
    }
  }

  // Sol: secure host by default (no API key). Public data.solanatracker.io
  // only when that origin is configured and SOLANATRACKER_DATA_API_KEY is set.
  const request = buildSolanaTrackerOhlcRequest({
    tokenAddress: params.tokenAddress,
    type: params.type,
    timeFrom: params.timeFrom,
    timeTo: params.timeTo,
  })

  if (request) {
    for (let attempt = 0; attempt < ST_OHLC_MAX_ATTEMPTS; attempt++) {
      try {
        // Shared queue with backfill workers: SOLANATRACKER_OHLC_RPS (default 3).
        await acquireSolanaTrackerOhlcSlot()
        const res = await fetch(request.url, {
          ...(Object.keys(request.headers).length > 0
            ? { headers: request.headers }
            : {}),
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          const body = (await res.json()) as Record<string, unknown>
          const candles = mapStBars(body.oclhv ?? body.ohlcv)
          if (candles.length > 0) return { candles, source: 'solanatracker' }
          break
        }
        if (res.status === 429 && attempt < ST_OHLC_MAX_ATTEMPTS - 1) {
          const delay = ST_OHLC_RETRY_BASE_MS * 2 ** attempt
          console.warn(
            `[token-map-chart] SolanaTracker OHLC rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${ST_OHLC_MAX_ATTEMPTS})`,
          )
          await sleepMs(delay)
          continue
        }
        break
      } catch {
        // fall through to GMGN kline below
        break
      }
    }
  }

  // GMGN kline fallback — skipped when Redis already holds a full 24h series.
  if (params.skipGmgn) return { candles: [], source: 'none' }
  try {
    const candles = await fetchGmgnKlinePaged({
      chain: 'sol',
      address: params.tokenAddress,
      resolution: params.type,
      timeFrom: params.timeFrom,
      timeTo: params.timeTo,
      deadlineMs: params.deadlineMs,
    })
    if (candles.length === 0) return { candles: [], source: 'none' }
    return { candles, source: 'gmgn' }
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
 * Canonical last-24h × 1m series (cached). Telegram / rug-10 / signal_ohlc_labels
 * derive from this. Goes through fetchTokenOhlc (brain first when flag on).
 * GMGN results merge into Redis (extend); brain/ST full-replace.
 * Skip GMGN when Redis already holds a full 24h series.
 * When last-good is partial, only fetch the forward gap (not the whole 24h again).
 * On upstream empty/fail, serves last-good with `*-stale` source.
 */
export async function getCachedTokenOhlc24h1m(
  tokenAddress: string,
): Promise<{ candles: TokenOhlcBar[]; source: string }> {
  const primary = await readOhlcCache(ohlc24h1mCacheKey(tokenAddress))
  if (primary) return primary

  const lastGood = await readOhlcCache(ohlc24h1mLastGoodKey(tokenAddress))
  const skipGmgn = lastGood != null && isFull24h1m(lastGood.candles)

  const nowSec = Math.floor(Date.now() / 1000)
  const windowFrom = nowSec - OHLC_24H_SPAN_SEC
  let fetchOpts: {
    tokenAddress: string
    hours?: number
    interval: string
    skipGmgn?: boolean
    timeFrom?: number
    timeTo?: number
  } = {
    tokenAddress,
    hours: 24,
    interval: '1m',
    skipGmgn,
  }

  if (!skipGmgn && lastGood && lastGood.candles.length > 0) {
    let maxT = lastGood.candles[0]!.time
    for (const c of lastGood.candles) {
      if (c.time > maxT) maxT = c.time
    }
    const gapFrom = Math.max(windowFrom, maxT + 1)
    if (gapFrom >= nowSec) {
      // Already current enough — refresh soft TTL from last-good.
      await writeOhlcCaches(tokenAddress, lastGood)
      return lastGood
    }
    fetchOpts = {
      tokenAddress,
      interval: '1m',
      timeFrom: gapFrom,
      timeTo: nowSec,
      skipGmgn: false,
    }
  }

  let result: OhlcCachePayload = { candles: [], source: 'none' }
  try {
    result = await fetchTokenOhlc(fetchOpts)
  } catch {
    result = { candles: [], source: 'none' }
  }

  if (result.candles.length > 0) {
    const isGmgn =
      result.source === 'gmgn' || result.source.startsWith('gmgn')
    if (isGmgn) {
      const prior = lastGood?.candles ?? []
      result = {
        candles: mergeOhlcCandles(prior, result.candles, nowSec),
        source: 'gmgn',
      }
    }
    await writeOhlcCaches(tokenAddress, result)
    return result
  }

  if (lastGood) {
    return {
      candles: lastGood.candles,
      source: staleSourceLabel(lastGood.source),
    }
  }
  return result
}

/**
 * "Tracker" price series for the chart, chain-aware:
 * 1. `trending_token_tracker.price_history` (sol-only trending-token tracker).
 * 2. Per-position `monitor_snapshots` from `strategy_outcomes.features`
 *    (sol + robinhood) — so tokens that were never on the sol trending tracker
 *    still get a real price axis when strategies traded them.
 */
async function loadTrackerHistory(
  tokenAddress: string,
  chain: GmgnTradeChain,
): Promise<ReturnType<typeof parsePriceHistory>> {
  const metrics = await fetchTrackerTokenMetrics(tokenAddress)
  const direct = parsePriceHistory(metrics?.price_history)
  if (direct.length > 0) return direct
  return fetchOutcomeMonitorPriceHistory(tokenAddress, chain)
}

/**
 * Our own 1m series (`token_ohlc_bars`), written by the 15s sampler. The
 * dependency-free source: it needs no upstream, so a chart still draws when
 * brain / SolanaTracker / GMGN all miss.
 */
async function loadOwnOhlcBars(
  tokenAddress: string,
  sinceSec: number,
  timeTo: number,
): Promise<TokenOhlcBar[]> {
  try {
    const { rows } = await query<{
      timestamp: string
      open: unknown
      high: unknown
      low: unknown
      close: unknown
      volume: unknown
    }>(
      `SELECT timestamp, open, high, low, close, volume
         FROM token_ohlc_bars
        WHERE token_address = $1
          AND interval = '1m'
          AND timestamp >= to_timestamp($2)
          AND timestamp <= to_timestamp($3)
        ORDER BY timestamp ASC`,
      [tokenAddress, sinceSec, timeTo],
    )
    const out: TokenOhlcBar[] = []
    for (const r of rows) {
      const time = Math.floor(new Date(r.timestamp).getTime() / 1000)
      const open = num(r.open)
      const high = num(r.high)
      const low = num(r.low)
      const close = num(r.close)
      if (
        !Number.isFinite(time) ||
        open == null ||
        high == null ||
        low == null ||
        close == null
      ) {
        continue
      }
      const volume = num(r.volume)
      out.push({
        time,
        open,
        high,
        low,
        close,
        ...(volume != null ? { volume } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

async function loadPersistedOhlcFallback(
  tokenAddress: string,
): Promise<{ candles: TokenOhlcBar[]; source: string } | null> {
  try {
    const { getLatestDetectSnapshot } = await import(
      '@/strategies/detect-snapshots'
    )
    const snap = await getLatestDetectSnapshot(tokenAddress)
    if (snap?.bars && snap.bars.length > 0) {
      return {
        candles: rugBarsToTokenOhlc(snap.bars),
        source: 'detect-snapshot',
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const { loadStoredSignalOhlcBars } = await import(
      '@/strategies/signal-ohlc-labels'
    )
    const bars = await loadStoredSignalOhlcBars(tokenAddress)
    if (bars.length > 0) {
      return { candles: rugBarsToTokenOhlc(bars), source: 'signal-ohlc-labels' }
    }
  } catch {
    /* ignore */
  }
  return null
}

export async function loadTokenMapChart(params: {
  tokenAddress: string
  hours?: number
  chain?: GmgnTradeChain
  /** Freeview: resolve OHLC span from first activity/outcome entry. */
  window?: 'auto' | 'fixed'
}): Promise<TokenMapChartPayload> {
  const chain =
    params.chain ??
    (/^0x[a-fA-F0-9]{40}$/i.test(params.tokenAddress) ? 'robinhood' : 'sol')
  const useAuto = params.window === 'auto'
  const nowSec = Math.floor(Date.now() / 1000)

  const outcomesResult = await listStrategyOutcomes({
    tokenAddress: params.tokenAddress,
    chain,
    limit: 100,
    offset: 0,
  })

  let chartWindow: ReturnType<typeof resolveFreeviewChartWindow> | null = null
  let hours: number
  let sinceSec: number
  let sinceMs: number
  let sinceIso: string
  let timeFrom: number
  let timeTo: number

  if (useAuto) {
    let activityAnchors: number[] = []
    try {
      const activities = await fetchTokenMapActivity({
        tokenAddress: params.tokenAddress,
        chain,
        hours: 24,
        limit: 80,
      })
      for (const a of activities) {
        const t = toUnixSec(a.occurredAt)
        if (t != null) activityAnchors.push(t)
      }
    } catch {
      activityAnchors = []
    }
    const entryAnchors: number[] = []
    for (const row of outcomesResult.rows) {
      if (!row.entry_at) continue
      const t = toUnixSec(row.entry_at)
      if (t != null) entryAnchors.push(t)
    }
    chartWindow = resolveFreeviewChartWindow({
      nowSec,
      anchorsSec: [...activityAnchors, ...entryAnchors],
    })
    timeFrom = chartWindow.timeFrom
    timeTo = chartWindow.timeTo
    hours = chartWindowHours(chartWindow)
    sinceSec = timeFrom
    sinceMs = timeFrom * 1000
    sinceIso = new Date(sinceMs).toISOString()
  } else {
    hours = Math.min(Math.max(params.hours ?? 24, 1), 168)
    sinceMs = Date.now() - hours * 60 * 60 * 1000
    sinceSec = Math.floor(sinceMs / 1000)
    sinceIso = new Date(sinceMs).toISOString()
    timeFrom = sinceSec
    timeTo = nowSec
  }

  const spanSec = timeTo - timeFrom
  const useShortFetch = useAuto && spanSec <= SHORT_OHLC_FETCH_MAX_SPAN_SEC
  // Bar size for a bounded window: 1m only for short spans, 5m/15m beyond.
  const windowInterval = useShortFetch ? '1m' : ohlcIntervalForHours(hours)
  // Only a genuine ~24h window is worth the canonical 24h x 1m series (16 gated
  // GMGN pages); anything shorter fetches exactly its own span instead, which is
  // what made a 6.9h Freeview window blow the 22s budget.
  const useCanonical24h = !useAuto && hours >= 20

  const ohlcPromise = (async (): Promise<{
    candles: TokenOhlcBar[]
    source: string
  }> => {
    if (useCanonical24h) {
      const cached = await getCachedTokenOhlc24h1m(params.tokenAddress)
      return {
        candles: sliceCandlesSince(cached.candles, sinceSec).filter(
          (c) => c.time <= timeTo,
        ),
        source: cached.source,
      }
    }
    if (useAuto || useShortFetch || hours <= 24) {
      const live = await fetchTokenOhlc({
        tokenAddress: params.tokenAddress,
        interval: windowInterval,
        chain,
        timeFrom,
        timeTo,
        deadlineMs: TOKEN_MAP_CHART_OHLC_BUDGET_MS,
      })
      return {
        candles: live.candles.filter(
          (c) => c.time >= sinceSec && c.time <= timeTo,
        ),
        source: live.source,
      }
    }
    return fetchTokenOhlc({
      tokenAddress: params.tokenAddress,
      hours,
      chain,
      deadlineMs: TOKEN_MAP_CHART_OHLC_BUDGET_MS,
    })
  })()

  const ohlcBudgeted = withTimeout(
    ohlcPromise,
    TOKEN_MAP_CHART_OHLC_BUDGET_MS,
  ).catch(() => ({
    candles: [] as TokenOhlcBar[],
    source: 'timeout',
  }))

  const detectPromise = (async (): Promise<{
    candles: TokenOhlcBar[]
    detectAt: string | null
  }> => {
    try {
      const { getLatestDetectSnapshot } = await import(
        '@/strategies/detect-snapshots'
      )
      const snap = await getLatestDetectSnapshot(params.tokenAddress)
      if (!snap?.bars?.length) return { candles: [], detectAt: null }
      return {
        candles: sliceCandlesSince(rugBarsToTokenOhlc(snap.bars), sinceSec).filter(
          (c) => c.time <= timeTo,
        ),
        detectAt: snap.detected_at ?? null,
      }
    } catch {
      return { candles: [], detectAt: null }
    }
  })()

  const [history, ohlcLive, detect] = await Promise.all([
    loadTrackerHistory(params.tokenAddress, chain),
    ohlcBudgeted,
    detectPromise,
  ])

  let candles = ohlcLive.candles
  let ohlcSource =
    ohlcLive.source === 'timeout'
      ? 'timeout'
      : ohlcLive.source
  if (candles.length === 0) {
    // Our own live 1m series comes before the frozen label/detect snapshots.
    const own = await loadOwnOhlcBars(params.tokenAddress, sinceSec, timeTo)
    if (own.length > 0) {
      candles = own
      ohlcSource = 'own-1m'
    } else {
      const persisted = await loadPersistedOhlcFallback(params.tokenAddress)
      if (persisted) {
        candles = sliceCandlesSince(persisted.candles, sinceSec).filter(
          (c) => c.time <= timeTo,
        )
        ohlcSource =
          ohlcLive.source === 'timeout'
            ? `${staleSourceLabel(persisted.source)}-timeout`
            : persisted.source
      } else if (ohlcLive.source === 'timeout') {
        ohlcSource = 'timeout'
      }
    }
  }

  const points: TokenChartPoint[] = []
  for (const p of history) {
    const t = toUnixSec(p.timestamp)
    if (t == null) continue
    if (t * 1000 < sinceMs) continue
    if (t > timeTo) continue
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
    candles,
    detectCandles: detect.candles,
    detectAt: detect.detectAt,
    priceSource: deduped.length > 0 || candles.length > 0 ? 'tracker' : 'empty',
    ohlcSource:
      candles.length > 0
        ? ohlcSource
        : ohlcSource === 'timeout' || ohlcSource.endsWith('-timeout')
          ? ohlcSource
          : 'none',
    ...(chartWindow
      ? {
          chartWindow: {
            mode: chartWindow.mode,
            timeFrom: chartWindow.timeFrom,
            timeTo: chartWindow.timeTo,
          },
        }
      : {}),
  }
}
