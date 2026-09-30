import { NextRequest, NextResponse, connection } from 'next/server'
import { aggregateStrategyReports } from '@/strategies/db'
import {
  DEFAULT_REPORT_TIMEZONE,
  resolveReportTimeZone,
} from '@/strategies/best-trade-windows'
import { parseStrategyChain } from '@/strategies/types'
import type { StrategyChain, StrategyDomain } from '@/strategies/types'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

/**
 * Reports are a 30-day analysis, not per-filter UI data, and a cold recompute is
 * expensive (see the section timings in docs/algo_overview.md). A long TTL keeps the
 * slow path rare; the per-filter cache key already makes each filter its own entry.
 */
const REPORTS_FRESH_TTL_S = 600
/**
 * Expired-but-usable copy. When the fresh entry is gone we serve this instead of
 * blocking the caller on a recompute, and refresh in the background — so the cold cost
 * is paid by the *next* request, never by the user who waited out the TTL.
 */
const REPORTS_STALE_TTL_S = 24 * 60 * 60

type ReportBody = Record<string, unknown>

type ReportParams = {
  domain?: StrategyDomain
  chain?: StrategyChain
  strategyId?: string
  isSimulated?: boolean
  from?: string
  to?: string
  timeZone: string
}

const staleKey = (cacheKey: string) => `${cacheKey}:stale`

/** Single-flight: concurrent stale hits share one recompute instead of stampeding the DB. */
const inFlight = new Map<string, Promise<ReportBody>>()

/** The raw request filter values, echoed back verbatim (undefined keys stay omitted). */
type RawFilters = { domain?: string | null; from?: string; to?: string }

async function buildReportBody(
  raw: RawFilters,
  params: ReportParams,
): Promise<ReportBody> {
  const {
    breakdown,
    abPairs,
    topTrades,
    worstTrades,
    coverage,
    mlStats,
    mcapTrackerStats,
    bestTradeWindows,
    overlap,
    pairs,
    consensus,
    capital,
    timezone,
  } = await aggregateStrategyReports(params)

  const totalTrades = breakdown.reduce((s, b) => s + b.trade_count, 0)
  const totalWins = breakdown.reduce((s, b) => s + b.win_count, 0)
  const avgWinRate = totalTrades ? totalWins / totalTrades : 0
  const avgPnl =
    breakdown.length > 0
      ? breakdown.reduce((s, b) => s + b.avg_pnl_pct, 0) / breakdown.length
      : 0

  // Profit-first ranking among buckets with enough sample.
  const ranking = breakdown
    .filter((b) => b.trade_count >= 10)
    .sort((a, b) => b.avg_pnl_pct - a.avg_pnl_pct || b.win_rate - a.win_rate)

  return {
    success: true,
    summary: {
      total_trades: totalTrades,
      win_rate: avgWinRate,
      avg_pnl_pct: avgPnl,
    },
    breakdown,
    coverage,
    ab_pairs: abPairs,
    ranking,
    top_trades: topTrades,
    worst_trades: worstTrades,
    ml_stats: mlStats,
    mcap_tracker_stats: mcapTrackerStats,
    best_trade_windows: bestTradeWindows,
    // Tokens entered by more than one strategy (agreement, not a defect).
    overlap,
    // Redundant pairs (same family) vs genuinely agreeing pairs.
    pairs,
    // Is agreement predictive? Carries CIs and an explicit inconclusive state.
    consensus,
    // Paper-trade capital + R:R per chain (native units differ — never summed).
    capital,
    timezone,
    filters: {
      domain: raw.domain,
      strategy_id: params.strategyId,
      is_simulated: params.isSimulated,
      from: raw.from,
      to: raw.to,
      tz: timezone,
    },
  }
}

function computeAndCache(
  cacheKey: string,
  raw: RawFilters,
  params: ReportParams,
): Promise<ReportBody> {
  const existing = inFlight.get(cacheKey)
  if (existing) return existing

  const run = buildReportBody(raw, params)
    .then(async (body) => {
      await Promise.all([
        cacheSet(cacheKey, body, REPORTS_FRESH_TTL_S),
        cacheSet(staleKey(cacheKey), body, REPORTS_STALE_TTL_S),
      ])
      return body
    })
    .finally(() => inFlight.delete(cacheKey))

  inFlight.set(cacheKey, run)
  return run
}

export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const domain = searchParams.get('domain') as StrategyDomain | null
    const strategyId = searchParams.get('strategy_id') ?? undefined
    const isSimParam = searchParams.get('is_simulated')
    const isSimulated =
      isSimParam === 'true' ? true : isSimParam === 'false' ? false : undefined
    const from = searchParams.get('from') ?? undefined
    const to = searchParams.get('to') ?? undefined
    const timeZone = resolveReportTimeZone(
      searchParams.get('tz') ?? DEFAULT_REPORT_TIMEZONE,
    )
    const chain = parseStrategyChain(searchParams.get('chain'))

    const cacheKey = [
      'strategies:reports:v1',
      chain ?? 'all',
      domain ?? 'all',
      strategyId ?? 'all',
      String(isSimulated ?? 'all'),
      from ?? 'all',
      to ?? 'all',
      timeZone,
    ].join(':')

    const raw = { domain, from, to }
    const params: ReportParams = {
      domain: domain ?? undefined,
      chain,
      strategyId,
      isSimulated,
      from,
      to,
      timeZone,
    }

    const fresh = await cacheGet<ReportBody>(cacheKey)
    if (fresh) {
      return NextResponse.json(fresh, { headers: { 'X-Report-Cache': 'fresh' } })
    }

    const stale = await cacheGet<ReportBody>(staleKey(cacheKey))
    if (stale) {
      // Never block on the recompute: hand back what we have and refresh behind it.
      void computeAndCache(cacheKey, raw, params).catch(() => {})
      return NextResponse.json(stale, { headers: { 'X-Report-Cache': 'stale' } })
    }

    const body = await computeAndCache(cacheKey, raw, params)
    return NextResponse.json(body, { headers: { 'X-Report-Cache': 'miss' } })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
