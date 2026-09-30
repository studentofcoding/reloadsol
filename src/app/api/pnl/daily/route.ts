import { resolveExecutionParams } from '@/strategies/execution-model'
import { NextRequest, NextResponse, connection } from 'next/server'
import { aggregateDailyPnl, loadOpenPaperPositions } from '@/strategies/db'
import {
  DEFAULT_REPORT_TIMEZONE,
  resolveReportTimeZone,
} from '@/strategies/best-trade-windows'
import { dayInTimeZone, isValidDayString } from '@/strategies/token-pnl-export'
import {
  buildDailyRows,
  buildRegimeBuckets,
  buildSizingBuckets,
  resolveBasePositionSizeSol,
  resolveBudgetHeadroom,
  resolveDailyBudgetSol,
  summarizeDailyPnl,
} from '@/strategies/pnl-dashboard'

const DEFAULT_RANGE_DAYS = 14

export async function GET(request: NextRequest) {
  // Hoisted above the try/catch: an `await connection()` inside it swallows the prerender-abort
  // rejection and logs it as a spurious 500 during the page-data collection pass.
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const timeZone = resolveReportTimeZone(
      searchParams.get('tz') ?? DEFAULT_REPORT_TIMEZONE,
    )

    const now = new Date()
    const to = searchParams.get('to') ?? dayInTimeZone(now, timeZone)
    const from =
      searchParams.get('from') ??
      dayInTimeZone(
        new Date(now.getTime() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000),
        timeZone,
      )
    if (!isValidDayString(from) || !isValidDayString(to) || from > to) {
      return NextResponse.json(
        { success: false, error: 'from/to must be YYYY-MM-DD and from <= to' },
        { status: 400 },
      )
    }

    const budgetSol = resolveDailyBudgetSol()
    const basePositionSizeSol = resolveBasePositionSizeSol()

    const [{ daily, peaks, bySizeMult, byRegimeTag, regimeByDay }, openPositions] =
      await Promise.all([
        aggregateDailyPnl({ from, to, timeZone }),
        // The paper positions the sims now register into the SL/TP tracker, so the dashboard can
        // show what is open right now rather than only what has closed.
        loadOpenPaperPositions(),
      ])

    const budgetHeadroom = resolveBudgetHeadroom()
    const rows = buildDailyRows({
      daily,
      peaks,
      regimeByDay: new Map(regimeByDay.map((r) => [r.day, r.regime_tag])),
      basePositionSizeSol,
      budgetSol,
      budgetHeadroom,
    })
    const summary = summarizeDailyPnl({ rows, budgetSol, basePositionSizeSol, budgetHeadroom })
    const sizing = buildSizingBuckets({
      bySizeMult: bySizeMult.map((r) => ({ ...r, regime: r.size_mult })),
      basePositionSizeSol,
    })
    const regimes = buildRegimeBuckets({ byRegimeTag, basePositionSizeSol })

    return NextResponse.json({
      success: true,
      range: { from, to, timezone: timeZone },
      config: { budgetSol, basePositionSizeSol, budgetHeadroom },

      regimes,
      daily: rows,
      open_positions: openPositions,
      sizing,
      // The cost model the paper desk applies. Surfaced because it decides whether a paper edge is
      // real: at feeBps 100 + spreadBps 50 per side it charged 300 bps round trip against a measured
      // ~26 bps, which was the whole modelled drag.
      summary: { ...summary, costModel: resolveExecutionParams() },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
