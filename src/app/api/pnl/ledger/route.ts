import { NextRequest, NextResponse, connection } from 'next/server'
import { loadSimLedgerRecords } from '@/strategies/db'
import {
  DEFAULT_REPORT_TIMEZONE,
  resolveReportTimeZone,
} from '@/strategies/best-trade-windows'
import { dayInTimeZone, isValidDayString } from '@/strategies/token-pnl-export'
import { buildStrategyReadiness, summarizeLedger, summarizeLedgerPositions } from '@/strategies/ledger-pnl'
import type { TrackingRecord } from '@/utils/trading-tracker'

const DEFAULT_RANGE_DAYS = 14

/**
 * Realized paper PnL computed READ-SIDE from the sim ledger, rather than from the outcome row.
 *
 * The ledger already records every simulated buy and sell with its own SOL and token amounts, so the
 * result is derived instead of enriched at write time. A computation that runs in a query is visible
 * when it breaks; one that runs inside an outcome insert had been failing silently.
 */
export async function GET(request: NextRequest) {
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
      dayInTimeZone(new Date(now.getTime() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000), timeZone)
    if (!isValidDayString(from) || !isValidDayString(to) || from > to) {
      return NextResponse.json(
        { success: false, error: 'from/to must be YYYY-MM-DD and from <= to' },
        { status: 400 },
      )
    }

    const rows = await loadSimLedgerRecords({ from, to, timeZone })
    // Shape the selected columns back into the record the reconstruction expects.
    const records = rows.map(
      (r) =>
        ({
          id: `ledger-${r.timestamp}-${r.operationType}`,
          walletAddress: '',
          operationType: (r.operationType === 'sell'
            ? 'sell'
            : r.operationType === 'close'
              ? 'close'
              : 'buy') as TrackingRecord['operationType'],
          timestamp: r.timestamp,
          chain: (r.chain === 'robinhood' ? 'robinhood' : 'sol') as 'sol' | 'robinhood',
          tokens: (r.tokens as TrackingRecord['tokens']) ?? [],
          successCount: r.successCount ?? 0,
          failureCount: 0,
          totalTokens: 1,
          solAmount: r.solAmount ?? undefined,
          bot_strategy: r.botStrategy ?? undefined,
          is_simulation: true,
        }) as unknown as TrackingRecord,
    )

    const positions = summarizeLedgerPositions(records)

    // Per strategy, realized only — what an operator would call "how did this strategy do".
    const byStrategy = new Map<string, typeof positions>()
    for (const position of positions) {
      const key = position.strategyId ?? '(unknown)'
      const list = byStrategy.get(key) ?? []
      list.push(position)
      byStrategy.set(key, list)
    }

    return NextResponse.json({
      success: true,
      range: { from, to, timezone: timeZone },
      // Per-strategy readiness: median trade, the calibrated drag, net per trade, and peak concurrent
      // positions (which has to fit MAX_SOL_AT_RISK at the live size). Sorted best net first.
      readiness: buildStrategyReadiness(positions),
      records: rows.length,
      summary: summarizeLedger(positions),
      strategies: [...byStrategy.entries()]
        .map(([strategyId, list]) => ({ strategyId, ...summarizeLedger(list) }))
        .sort((a, b) => b.realizedPnlSol - a.realizedPnlSol),
      recentClosed: positions
        .filter((p) => p.closed)
        .slice(0, 25)
        .map((p) => ({
          strategyId: p.strategyId,
          symbol: p.symbol,
          mintAddress: p.mintAddress,
          costSol: p.costSol,
          proceedsSol: p.proceedsSol,
          pnlSol: p.pnlSol,
          pnlPct: p.pnlPct,
          closedAt: p.closedAt,
        })),
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
