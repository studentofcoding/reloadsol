import { NextRequest, NextResponse, connection } from 'next/server'
import { aggregateStrategyReports } from '@/strategies/db'
import {
  DEFAULT_REPORT_TIMEZONE,
  resolveReportTimeZone,
} from '@/strategies/best-trade-windows'
import { parseStrategyChain } from '@/strategies/types'
import type { StrategyDomain } from '@/strategies/types'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const REPORTS_CACHE_TTL_S = 30

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

    const cached = await cacheGet<Record<string, unknown>>(cacheKey)
    if (cached) {
      return NextResponse.json(cached)
    }

    const {
      breakdown,
      abPairs,
      topTrades,
      worstTrades,
      coverage,
      mlStats,
      mcapTrackerStats,
      bestTradeWindows,
      timezone,
    } = await aggregateStrategyReports({
      domain: domain ?? undefined,
      chain,
      strategyId,
      isSimulated,
      from,
      to,
      timeZone,
    })

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
      .sort(
        (a, b) =>
          b.avg_pnl_pct - a.avg_pnl_pct || b.win_rate - a.win_rate,
      )

    const body = {
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
      timezone,
      filters: {
        domain,
        strategy_id: strategyId,
        is_simulated: isSimulated,
        from,
        to,
        tz: timezone,
      },
    }

    void cacheSet(cacheKey, body, REPORTS_CACHE_TTL_S)
    return NextResponse.json(body)
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
