import { listStrategyOutcomes } from '@/strategies/db'
import { fetchTrackerTokenMetrics } from '@/strategies/sim-monitor-snapshots'
import { parsePriceHistory } from '@/strategies/trade-window-chart-data'
import type { TokenMapDomain } from '@/strategies/token-map-types'

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

/**
 * OHLC adapter hook — no candle ingest in-repo yet (GMGN is iframe-only).
 * When a source is wired, return bars and set ohlcSource accordingly.
 */
export async function fetchTokenOhlc(_params: {
  tokenAddress: string
  hours: number
  interval?: string
}): Promise<{ candles: TokenOhlcBar[]; source: string }> {
  // ponytail: ceiling = empty until Solana Tracker / GMGN kline adapter is keyed
  return { candles: [], source: 'none' }
}

export async function loadTokenMapChart(params: {
  tokenAddress: string
  hours?: number
}): Promise<TokenMapChartPayload> {
  const hours = Math.min(Math.max(params.hours ?? 24, 1), 168)
  const sinceMs = Date.now() - hours * 60 * 60 * 1000
  const sinceIso = new Date(sinceMs).toISOString()

  const [metrics, outcomesResult, ohlc] = await Promise.all([
    fetchTrackerTokenMetrics(params.tokenAddress),
    listStrategyOutcomes({
      tokenAddress: params.tokenAddress,
      limit: 100,
      offset: 0,
    }),
    fetchTokenOhlc({ tokenAddress: params.tokenAddress, hours }),
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
