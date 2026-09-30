import { NextRequest, NextResponse, connection } from 'next/server'
import { loadDayClosedTrades } from '@/strategies/db'
import {
  DEFAULT_REPORT_TIMEZONE,
  resolveReportTimeZone,
} from '@/strategies/best-trade-windows'
import { isValidDayString } from '@/strategies/token-pnl-export'

/**
 * Every closed trade on one day, for the dashboard's expandable per-day section.
 *
 * Separate from the range endpoint on purpose: a 90-day range would otherwise ship thousands of rows
 * to render one expanded day.
 */
export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const day = searchParams.get('date') ?? ''
    const timeZone = resolveReportTimeZone(
      searchParams.get('tz') ?? DEFAULT_REPORT_TIMEZONE,
    )
    if (!isValidDayString(day)) {
      return NextResponse.json(
        { success: false, error: 'date must be YYYY-MM-DD' },
        { status: 400 },
      )
    }

    const trades = await loadDayClosedTrades({ day, timeZone })
    return NextResponse.json({
      success: true,
      day,
      timezone: timeZone,
      count: trades.length,
      trades,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
