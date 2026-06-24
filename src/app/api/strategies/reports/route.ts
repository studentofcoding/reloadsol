import { NextRequest, NextResponse } from 'next/server'
import { aggregateStrategyReports } from '@/strategies/db'
import type { StrategyDomain } from '@/strategies/types'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const domain = searchParams.get('domain') as StrategyDomain | null
    const strategyId = searchParams.get('strategy_id') ?? undefined
    const isSimParam = searchParams.get('is_simulated')
    const isSimulated =
      isSimParam === 'true' ? true : isSimParam === 'false' ? false : undefined
    const from = searchParams.get('from') ?? undefined
    const to = searchParams.get('to') ?? undefined

    const { breakdown, abPairs, topTrades, worstTrades, coverage, mlStats } = await aggregateStrategyReports({
      domain: domain ?? undefined,
      strategyId,
      isSimulated,
      from,
      to,
    })

    const totalTrades = breakdown.reduce((s, b) => s + b.trade_count, 0)
    const totalWins = breakdown.reduce((s, b) => s + b.win_count, 0)
    const avgWinRate = totalTrades ? totalWins / totalTrades : 0
    const avgPnl =
      breakdown.length > 0
        ? breakdown.reduce((s, b) => s + b.avg_pnl_pct, 0) / breakdown.length
        : 0

    const ranking = breakdown
      .filter((b) => b.trade_count >= 10)
      .sort((a, b) => b.win_rate - a.win_rate || b.avg_pnl_pct - a.avg_pnl_pct)

    return NextResponse.json({
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
      filters: { domain, strategy_id: strategyId, is_simulated: isSimulated, from, to },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
