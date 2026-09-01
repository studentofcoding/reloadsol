import { NextResponse } from 'next/server'
import { NextRequest, connection } from 'next/server'
import { query, queryOne } from '@/utils/db'
import {
  getAppDayBounds,
  getAppLocalDateString,
  getPreviousAppLocalDateString,
} from '@/utils/datetime'
import {
  isOpenTrackerPosition,
  isSimulatedTrackerPosition,
  resolveTrackerStrategyId,
} from '@/utils/trading-simulation'
import {
  countTrackerOutcomeStats,
  isPnlEligibleTrackerToken,
  resolveCompletedOutcome,
  sumSummaryTokenProfitPct,
} from '@/utils/trending-profit'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const STATS_REDIS_TTL_SECONDS = 60

function statsCacheKey(params: {
  date: string | null
  isSim: string | null
  strategy: string | null
}): string {
  return `stats:${params.date ?? 'latest'}:${params.isSim ?? 'all'}:${params.strategy ?? 'all'}`
}

// Force dynamic rendering for this route

// Dev vs prod table selection
const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'
const SUMMARY_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_summary_dev' : 'trending_token_summary'

type SummaryRow = Record<string, unknown> & {
  period_start: string
  period_end: string
  created_at: string
  top_winners?: unknown
  win_rate?: number
}

function coerceNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function coerceTrackerRow(row: TrackerRow): TrackerRow {
  return {
    ...row,
    initial_price_usd: coerceNum(row.initial_price_usd),
    peak_price_usd: coerceNum(row.peak_price_usd),
    last_price_usd: coerceNum(row.last_price_usd),
    peak_gain_percentage: coerceNum(row.peak_gain_percentage),
    current_gain_percentage: coerceNum(row.current_gain_percentage),
    market_cap: row.market_cap != null ? coerceNum(row.market_cap) : null,
  }
}

function coerceSummaryRow(row: SummaryRow): SummaryRow {
  return {
    ...row,
    win_rate: row.win_rate != null ? coerceNum(row.win_rate) : undefined,
    avg_peak_gain: row.avg_peak_gain != null ? coerceNum(row.avg_peak_gain) : undefined,
    max_peak_gain: row.max_peak_gain != null ? coerceNum(row.max_peak_gain) : undefined,
    avg_loss: row.avg_loss != null ? coerceNum(row.avg_loss) : undefined,
  }
}

type TrackerRow = Record<string, unknown> & {
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: number
  peak_price_usd: number
  last_price_usd: number
  peak_gain_percentage: number
  current_gain_percentage: number
  status: string
  tracking_started_at: string
  status_changed_at: string | null
  market_cap: number | null
  trading_simulation: unknown
  price_history: unknown
}

function mapPeriodTokens(summary: SummaryRow, tokens: TrackerRow[]) {
  const periodEnd = new Date(summary.period_end)
  return tokens.map((token) => {
    const trackingStart = new Date(token.tracking_started_at)
    const trackingDuration =
      (periodEnd.getTime() - trackingStart.getTime()) / (1000 * 60 * 60)

    return {
      token_address: token.token_address,
      token_symbol: token.token_symbol,
      token_name: token.token_name,
      logo_url: token.logo_url,
      initial_price_usd: coerceNum(token.initial_price_usd),
      peak_price_usd: coerceNum(token.peak_price_usd),
      last_price_usd: coerceNum(token.last_price_usd),
      peak_gain_percentage: coerceNum(token.peak_gain_percentage),
      tracking_duration_hours: Math.round(trackingDuration * 100) / 100,
      tracking_started_at: token.tracking_started_at,
      status_changed_at: token.status_changed_at || summary.period_end,
      status: token.status,
      current_gain_percentage: coerceNum(token.current_gain_percentage),
      market_cap: token.market_cap != null ? coerceNum(token.market_cap) : null,
      trading_simulation: token.trading_simulation,
      price_history: token.price_history,
    }
  })
}

async function fetchPeriodTokens(summary: SummaryRow): Promise<ReturnType<typeof mapPeriodTokens>> {
  try {
    const { rows: summaryPeriodTokens } = await query<TrackerRow>(
      `SELECT * FROM ${TRACKER_TABLE}
       WHERE tracking_started_at >= $1 AND tracking_started_at <= $2
       ORDER BY peak_gain_percentage DESC`,
      [summary.period_start, summary.period_end],
    )

    if (!summaryPeriodTokens || summaryPeriodTokens.length === 0) {
      return mapPeriodTokens(summary, (summary.top_winners as TrackerRow[]) ?? [])
    }

    return mapPeriodTokens(summary, summaryPeriodTokens)
  } catch {
    return mapPeriodTokens(summary, (summary.top_winners as TrackerRow[]) ?? [])
  }
}

function buildEnhancedSummary(
  summary: SummaryRow,
  periodTokens: ReturnType<typeof mapPeriodTokens>,
) {
  // PnL sums exclude skipped/waiting rows (they carry phantom gains but no trade).
  const eligible = periodTokens.filter(isPnlEligibleTrackerToken)
  const profitStats = sumSummaryTokenProfitPct(eligible)
  // Live-recomputed outcome stats override stale stored won/lost/win_rate.
  const outcomeStats = countTrackerOutcomeStats(periodTokens)
  return {
    ...summary,
    ...coerceSummaryRow(summary),
    top_winners: periodTokens,
    total_profit_pct: profitStats.totalProfitPct,
    average_profit_pct: profitStats.averageProfitPct,
    profit_token_count: profitStats.tokenCount,
    won_tokens: outcomeStats.won,
    lost_tokens: outcomeStats.lost,
    skipped_tokens: outcomeStats.skipped,
    win_rate: Math.round(outcomeStats.winRate * 100) / 100,
  }
}

function computeCohortStats(tokens: TrackerRow[]) {
  const normalized = tokens.map(coerceTrackerRow)
  const holding = normalized.filter((t) => t.status === 'tracking')
  const sortedByPeak = [...normalized].sort(
    (a, b) => coerceNum(b.peak_gain_percentage) - coerceNum(a.peak_gain_percentage),
  )
  const top = sortedByPeak[0]

  const avgCurrentGain =
    holding.length > 0
      ? holding.reduce((sum, t) => sum + coerceNum(t.current_gain_percentage), 0) /
        holding.length
      : normalized.length > 0
        ? normalized.reduce((sum, t) => sum + coerceNum(t.current_gain_percentage), 0) /
          normalized.length
        : 0

  const avgPeakGain =
    normalized.length > 0
      ? normalized.reduce((sum, t) => sum + coerceNum(t.peak_gain_percentage), 0) /
        normalized.length
      : 0

  return {
    statistics: {
      total_tracking: holding.length,
      positive_performers:
        normalized.filter((t) => coerceNum(t.current_gain_percentage) > 0).length || 0,
      negative_performers:
        normalized.filter((t) => coerceNum(t.current_gain_percentage) < 0).length || 0,
      at_risk:
        normalized.filter((t) => coerceNum(t.current_gain_percentage) <= -40).length ||
        0,
      top_performer: top
        ? {
            token_symbol: top.token_symbol,
            token_name: top.token_name,
            current_gain_percentage: coerceNum(top.current_gain_percentage),
            peak_gain_percentage: coerceNum(top.peak_gain_percentage),
          }
        : null,
    },
    averages: {
      current_gain: Math.round(avgCurrentGain * 100) / 100,
      peak_gain: Math.round(avgPeakGain * 100) / 100,
    },
    tokens: holding,
  }
}

async function findSummaryForDate(dateStr: string): Promise<SummaryRow | null> {
  const { start, end } = getAppDayBounds(dateStr)
  try {
    const data = await queryOne<SummaryRow>(
      `SELECT * FROM ${SUMMARY_TABLE}
       WHERE period_end >= $1 AND period_end <= $2
       ORDER BY period_end DESC
       LIMIT 1`,
      [start.toISOString(), end.toISOString()],
    )
    return data
  } catch (error) {
    console.warn(
      '[trending/stats] summary lookup failed:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

export async function GET(request: NextRequest) {
  try {
    await connection()
    const searchParams = request.nextUrl.searchParams
    const refresh = searchParams.get('refresh') === 'true'
    const nocache = searchParams.get('nocache') === 'true'
    const isSimParam = searchParams.get('is_simulated')
    const strategyFilter = searchParams.get('strategy_id')
    const dateParam = searchParams.get('date')

    const cacheKey = statsCacheKey({
      date: dateParam,
      isSim: isSimParam,
      strategy: strategyFilter,
    })

    if (!nocache && !refresh) {
      const cached = await cacheGet<Record<string, unknown>>(cacheKey)
      if (cached) {
        return NextResponse.json(
          { ...cached, cached: true },
          {
            status: 200,
            headers: {
              'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
              'X-Cache-Status': 'HIT',
            },
          },
        )
      }
    }

    const filterBySim = (token: { trading_simulation?: unknown }) => {
      if (isSimParam === null || isSimParam === '') return true
      const isSim = isSimulatedTrackerPosition(token)
      return isSimParam === 'true' ? isSim : !isSim
    }

    const filterByStrategy = (token: { trading_simulation?: unknown }) => {
      if (!strategyFilter) return true
      const sid = resolveTrackerStrategyId(
        token.trading_simulation as Record<string, unknown> | null | undefined,
      )
      return sid === strategyFilter
    }

    const applyFilters = <T extends { trading_simulation?: unknown }>(
      tokens: T[],
    ): T[] => {
      let filtered = tokens
      if (isSimParam !== null && isSimParam !== '') {
        filtered = filtered.filter(filterBySim)
      }
      if (strategyFilter) {
        filtered = filtered.filter(filterByStrategy)
      }
      return filtered
    }

    console.log(
      `📊 Fetching trending token statistics... ${refresh ? '(forced refresh)' : ''}${nocache ? '(no cache)' : ''}${dateParam ? ` date=${dateParam}` : ''}`,
    )

    const last7Days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const todayStr = getAppLocalDateString()
    const selectedDate =
      dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : null

    const [
      { rows: summaries },
      { rows: trackingResult },
      { rows: completedResult },
      { rows: historicalSummaries },
    ] = await Promise.all([
      query<SummaryRow>(
        `SELECT * FROM ${SUMMARY_TABLE} ORDER BY created_at DESC LIMIT 1`,
      ),
      query<TrackerRow>(
        `SELECT * FROM ${TRACKER_TABLE} WHERE status = 'tracking' ORDER BY peak_gain_percentage DESC`,
      ),
      query<TrackerRow>(
        `SELECT * FROM ${TRACKER_TABLE}
         WHERE status IN ('won', 'lost') AND status_changed_at >= $1
         ORDER BY status_changed_at DESC
         LIMIT 20`,
        [last7Days],
      ),
      query<SummaryRow>(
        `SELECT * FROM ${SUMMARY_TABLE}
         WHERE created_at >= $1
         ORDER BY created_at DESC
         LIMIT 7`,
        [last7Days],
      ),
    ])

    let trackingTokens = trackingResult.filter(isOpenTrackerPosition)
    let recentCompleted = completedResult

    let watchingCount = 0
    if (selectedDate) {
      const { start, end } = getAppDayBounds(selectedDate)
      const watchingRow = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ${TRACKER_TABLE}
         WHERE status = 'waiting'
           AND waiting_started_at >= $1
           AND waiting_started_at <= $2`,
        [start.toISOString(), end.toISOString()],
      )
      watchingCount = watchingRow?.count ?? 0
    } else {
      const watchingRow = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM ${TRACKER_TABLE} WHERE status = 'waiting'`,
      )
      watchingCount = watchingRow?.count ?? 0
    }

    trackingTokens = applyFilters(trackingTokens ?? [])
    recentCompleted = applyFilters(recentCompleted ?? [])

    let enhancedLatestSummary = null
    if (summaries && summaries.length > 0) {
      const periodTokens = await fetchPeriodTokens(summaries[0] as SummaryRow)
      enhancedLatestSummary = buildEnhancedSummary(
        summaries[0] as SummaryRow,
        periodTokens,
      )
    }

    let selectedSummary: typeof enhancedLatestSummary = null
    let summaryMode: 'dated' | 'live_fallback' | null = null
    let dateScopedTracking = {
      tokens: trackingTokens || [],
      statistics: {
        total_tracking: trackingTokens?.length || 0,
        positive_performers:
          trackingTokens?.filter((t) => t.current_gain_percentage > 0).length ||
          0,
        negative_performers:
          trackingTokens?.filter((t) => t.current_gain_percentage < 0).length ||
          0,
        at_risk:
          trackingTokens?.filter((t) => t.current_gain_percentage <= -40)
            .length || 0,
        top_performer:
          trackingTokens && trackingTokens.length > 0
            ? {
                token_symbol: trackingTokens[0].token_symbol,
                token_name: trackingTokens[0].token_name,
                current_gain_percentage: trackingTokens[0].current_gain_percentage,
                peak_gain_percentage: trackingTokens[0].peak_gain_percentage,
              }
            : null,
      },
      averages: {
        current_gain:
          trackingTokens && trackingTokens.length > 0
            ? Math.round(
                (trackingTokens.reduce(
                  (sum, t) => sum + (t.current_gain_percentage || 0),
                  0,
                ) /
                  trackingTokens.length) *
                  100,
              ) / 100
            : 0,
        peak_gain:
          trackingTokens && trackingTokens.length > 0
            ? Math.round(
                (trackingTokens.reduce(
                  (sum, t) => sum + (t.peak_gain_percentage || 0),
                  0,
                ) /
                  trackingTokens.length) *
                  100,
              ) / 100
            : 0,
      },
    }

    let winRateTrend = 0

    if (selectedDate) {
      let summaryForDate = await findSummaryForDate(selectedDate)

      if (!summaryForDate && selectedDate === todayStr && summaries?.[0]) {
        summaryForDate = summaries[0] as SummaryRow
        summaryMode = 'live_fallback'
      } else if (summaryForDate) {
        summaryMode = 'dated'
      }

      if (summaryForDate) {
        const rawPeriodTokens = await fetchPeriodTokens(summaryForDate)
        const filteredPeriodTokens = applyFilters(rawPeriodTokens)
        selectedSummary = buildEnhancedSummary(
          summaryForDate,
          filteredPeriodTokens,
        )

        const cohortStats = computeCohortStats(
          filteredPeriodTokens as unknown as TrackerRow[],
        )
        dateScopedTracking = {
          tokens: cohortStats.tokens as typeof trackingTokens,
          statistics: cohortStats.statistics,
          averages: cohortStats.averages,
        }

        const prevDate = getPreviousAppLocalDateString(selectedDate)
        const prevSummary = await findSummaryForDate(prevDate)
        if (prevSummary) {
          winRateTrend =
            Number(summaryForDate.win_rate ?? 0) -
            Number(prevSummary.win_rate ?? 0)
        }
      } else {
        summaryMode = 'dated'
        winRateTrend = 0
      }
    } else if (historicalSummaries && historicalSummaries.length >= 2) {
      const latestWinRate = coerceNum(historicalSummaries[0]?.win_rate)
      const previousWinRate = coerceNum(historicalSummaries[1]?.win_rate)
      winRateTrend = latestWinRate - previousWinRate
    }

    const activeSummary = selectedDate ? selectedSummary : enhancedLatestSummary
    const activeTracking = selectedDate ? dateScopedTracking : {
      tokens: trackingTokens || [],
      statistics: dateScopedTracking.statistics,
      averages: dateScopedTracking.averages,
    }

    const recentWinners =
      recentCompleted?.filter((t) => resolveCompletedOutcome(t) === 'won') || []
    const recentLosers =
      recentCompleted?.filter((t) => resolveCompletedOutcome(t) === 'lost') || []

    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      selected_date: selectedDate,
      summary_mode: summaryMode,
      latest_summary: enhancedLatestSummary,
      selected_summary: selectedSummary,
      active_summary: activeSummary,
      current_tracking: activeTracking,
      recent_completed: {
        winners: recentWinners.slice(0, 10),
        losers: recentLosers.slice(0, 10),
      },
      trends: {
        win_rate_change: Math.round(winRateTrend * 100) / 100,
        historical_summaries: historicalSummaries || [],
      },
      data_freshness: {
        tracking_tokens_count: activeTracking.statistics.total_tracking,
        watching_tokens_count: watchingCount,
        latest_summary_age_hours:
          activeSummary?.created_at
            ? Math.round(
                ((Date.now() -
                  new Date(activeSummary.created_at as string).getTime()) /
                  (1000 * 60 * 60)) *
                  100,
              ) / 100
            : null,
        last_updated: new Date().toISOString(),
      },
    }

    console.log(
      `✅ Stats fetched: ${activeTracking.statistics.total_tracking} holding, ${recentWinners.length} recent winners${selectedDate ? ` (date=${selectedDate}, mode=${summaryMode})` : ''}`,
    )

    const enhancedResponse = {
      ...response,
      cached: false,
      cache_age: 0,
      expires_in: nocache ? 0 : 300,
    }

    if (!nocache && !refresh) {
      await cacheSet(cacheKey, enhancedResponse, STATS_REDIS_TTL_SECONDS)
    }

    const cacheHeaders: Record<string, string> = nocache
      ? {
          'Cache-Control':
            'no-store, no-cache, must-revalidate, proxy-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        }
      : refresh
        ? {
            'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
          }
        : {
            'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
          }

    return NextResponse.json(enhancedResponse, {
      status: 200,
      headers: cacheHeaders,
    })
  } catch (error) {
    console.error('❌ Error fetching trending token stats:', error)
    return NextResponse.json(
      {
        error: 'Failed to fetch trending token statistics',
        message: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
