import { NextRequest, NextResponse, connection } from 'next/server'
import { aggregateTokenPnlByToken } from '@/strategies/db'
import {
  DEFAULT_REPORT_TIMEZONE,
  resolveReportTimeZone,
} from '@/strategies/best-trade-windows'
import type { StrategyChain } from '@/strategies/types'
import {
  buildTokenPnlCsv,
  dayInTimeZone,
  isValidDayString,
  summarizeTokens,
  tokenPnlFileName,
  topTokens,
  worstTokens,
} from '@/strategies/token-pnl-export'

/** Paper position size. The notional column is only meaningful next to an explicit size. */
const DEFAULT_POSITION_SIZE_SOL = Number(
  process.env.PNL_EXPORT_POSITION_SIZE_SOL || '0.005',
)
const TOP_N = 10
const DEFAULT_RANGE_DAYS = 3

/**
 * Omitted means ALL chains. Deliberately not `parseStrategyChain`, which coerces anything it
 * does not recognise to 'sol' — that would silently drop the Robinhood twin (measured: 261 of
 * the 627 sim rows over three days).
 */
function resolveChainFilter(raw: string | null): StrategyChain | undefined {
  return raw === 'sol' || raw === 'robinhood' ? raw : undefined
}

export async function GET(request: NextRequest) {
  // Hoisted above the try/catch: an `await connection()` inside it swallows the prerender-abort
  // rejection and logs it as a spurious 500 during the page-data collection pass.
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const timeZone = resolveReportTimeZone(
      searchParams.get('tz') ?? DEFAULT_REPORT_TIMEZONE,
    )
    const chain = resolveChainFilter(searchParams.get('chain'))
    const isSimulated = searchParams.get('is_simulated') !== 'false'
    const format = searchParams.get('format') ?? 'csv'
    const parsedSize = Number(searchParams.get('position_size'))
    const positionSizeSol =
      Number.isFinite(parsedSize) && parsedSize > 0
        ? parsedSize
        : DEFAULT_POSITION_SIZE_SOL

    const now = new Date()
    const to = searchParams.get('to') ?? dayInTimeZone(now, timeZone)
    const from =
      searchParams.get('from') ??
      dayInTimeZone(
        new Date(now.getTime() - (DEFAULT_RANGE_DAYS - 1) * 86_400_000),
        timeZone,
      )

    if (!isValidDayString(from) || !isValidDayString(to)) {
      return NextResponse.json(
        { success: false, error: 'from/to must be YYYY-MM-DD' },
        { status: 400 },
      )
    }
    if (from > to) {
      return NextResponse.json(
        { success: false, error: 'from must not be after to' },
        { status: 400 },
      )
    }

    const data = await aggregateTokenPnlByToken({
      chain,
      isSimulated,
      from,
      to,
      timeZone,
    })
    const summary = summarizeTokens({
      tokens: data.tokens,
      ...data.totals,
      peakConcurrent: data.peakConcurrent,
      positionSizeSol,
      concentrationTop: TOP_N,
    })

    if (format === 'json') {
      return NextResponse.json({
        success: true,
        range: {
          from,
          to,
          timezone: timeZone,
          position_size_sol: positionSizeSol,
          chain: chain ?? 'all',
          chains: data.chains,
        },
        summary,
        truncated: data.truncated,
        top_tokens: topTokens(data.tokens, TOP_N),
        worst_tokens: worstTokens(data.tokens, TOP_N),
        tokens: data.tokens,
      })
    }

    const csv = buildTokenPnlCsv({
      summary,
      tokens: data.tokens,
      positionSizeSol,
      from,
      to,
      timeZone,
      chains: data.chains,
      topN: TOP_N,
    })
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${tokenPnlFileName(from, to)}"`,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
