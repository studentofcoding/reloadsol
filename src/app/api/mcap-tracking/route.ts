import { NextRequest, NextResponse } from 'next/server'
import { trackTokenMcap, getMcapDisplayString, isInTrackingRange, cleanupOldMcapRecords, getTrackingHealthStats, STOP_LOSS_THRESHOLD, MAX_TRACKING_AGE_MS, TokenLabel, normalizeTrackingTimeline, type McapSnapshot } from '@/utils/mcap-tracker'
import { query, queryOne } from '@/utils/db'
import { getSolPriceUSD } from '@/utils/solana'
import { getAppLocalParts } from '@/utils/datetime'
import { log } from '@/utils/unified-logger'

const LIST_SORT_COLUMNS = new Set([
  'last_updated_at', 'first_seen_at', 'mcap_growth_percent',
  'current_mcap', 'first_mcap', 'token_symbol', 'token_address',
])

function getTimeFilterCutoff(timeFilter: string): Date | null {
  if (timeFilter === 'all') return null
  const now = new Date()
  switch (timeFilter) {
    case '1h': return new Date(now.getTime() - 60 * 60 * 1000)
    case '4h': return new Date(now.getTime() - 4 * 60 * 60 * 1000)
    case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000)
    case '3d': return new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
    case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case '1m': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    default: return null
  }
}

type McapListFilterParams = {
  search?: string
  timeFilter?: string
  performanceFilter?: string
  minGrowth?: string | null
  maxGrowth?: string | null
  minMcap?: string | null
  maxMcap?: string | null
  statsOnly?: boolean
}

function buildMcapListWhere(params: McapListFilterParams): { sql: string; values: unknown[] } {
  const conditions: string[] = []
  const values: unknown[] = []

  if (params.statsOnly) {
    conditions.push('mcap_growth_percent IS NOT NULL')
    conditions.push('current_mcap IS NOT NULL')
    conditions.push('first_mcap IS NOT NULL')
    conditions.push('first_mcap > 0')
    conditions.push('current_mcap > 0')
  }

  if (params.search) {
    values.push(`%${params.search}%`)
    conditions.push(`(token_symbol ILIKE $${values.length} OR token_address ILIKE $${values.length})`)
  }

  const cutoff = getTimeFilterCutoff(params.timeFilter || 'all')
  if (cutoff) {
    values.push(cutoff.toISOString())
    conditions.push(`first_seen_at >= $${values.length}`)
  }

  const performanceFilter = params.performanceFilter || 'all'
  if (performanceFilter === 'gainers') {
    conditions.push('mcap_growth_percent > 0')
  } else if (performanceFilter === 'losers') {
    conditions.push('mcap_growth_percent < 0')
  } else if (performanceFilter === 'top_performers') {
    conditions.push('mcap_growth_percent >= 100')
  }

  if (params.minGrowth != null && params.minGrowth !== '') {
    values.push(parseFloat(params.minGrowth))
    conditions.push(`mcap_growth_percent >= $${values.length}`)
  }
  if (params.maxGrowth != null && params.maxGrowth !== '') {
    values.push(parseFloat(params.maxGrowth))
    conditions.push(`mcap_growth_percent <= $${values.length}`)
  }
  if (params.minMcap != null && params.minMcap !== '') {
    values.push(parseFloat(params.minMcap))
    conditions.push(`first_mcap >= $${values.length}`)
  }
  if (params.maxMcap != null && params.maxMcap !== '') {
    values.push(parseFloat(params.maxMcap))
    conditions.push(`first_mcap <= $${values.length}`)
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { sql, values }
}

// Server-side toast deduplication to reduce duplicate notifications across quick successive calls.
// Note: This is a best-effort in-memory window and may not cover multi-instance deployments.
const TOAST_DEDUP_WINDOW_MS: number = Number(
  process.env.MCAP_TOAST_DEDUP_WINDOW_MS || process.env.NEXT_PUBLIC_MCAP_TOAST_DEDUP_WINDOW_MS || 30000
)
const recentToastKeys: Map<string, number> = new Map()

function pruneRecentToastKeys(now: number) {
  const keysToDelete: string[] = []
  recentToastKeys.forEach((ts, key) => {
    if (now - ts > TOAST_DEDUP_WINDOW_MS) {
      keysToDelete.push(key)
    }
  })
  keysToDelete.forEach((key) => {
    recentToastKeys.delete(key)
  })
}

function computeToastKey(
  prefix: string,
  items: Array<{ address: string; growthPercent?: number }>,
  extra?: Record<string, any>
): string {
  const parts = [prefix]
  if (extra) {
    // Include relevant numeric params with safe rounding for stability
    if (typeof extra.threshold === 'number') parts.push(`thr:${Math.round(extra.threshold * 10) / 10}`)
    if (typeof extra.cap === 'number') parts.push(`cap:${Math.round(extra.cap * 10) / 10}`)
    if (typeof extra.page === 'number') parts.push(`pg:${extra.page}`)
    if (typeof extra.limit === 'number') parts.push(`lm:${extra.limit}`)
  }
  const itemSig = items
    .map(i => `${i.address}:${typeof i.growthPercent === 'number' ? Math.round(i.growthPercent * 10) / 10 : 'NA'}`)
    .sort()
    .join('|')
  parts.push(itemSig)
  return parts.join('|')
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')
    const tokenAddress = searchParams.get('token')
    const tokenSymbol = searchParams.get('symbol')
    const mcap = searchParams.get('mcap')

    log.info('mcap_tracker', 'GET /api/mcap-tracking invoked', {
      action,
      tokenAddress,
      tokenSymbol,
      mcap
    })

    // Add this new action in the GET handler 
    if (action === 'health') {
      const healthStats = await getTrackingHealthStats()

      return NextResponse.json({
        success: true,
        health: healthStats,
        recommendations: {
          isHealthy: healthStats.healthPercentage >= 99,
          issues: [
            ...(healthStats.healthPercentage < 99 ? [`Health at ${healthStats.healthPercentage.toFixed(1)}% (target: 99%)`] : []),
            ...(healthStats.zeroGrowthTokens > healthStats.totalTokens * 0.1 ? [`High zero-growth tokens: ${healthStats.zeroGrowthTokens}`] : []),
            ...(healthStats.recentlyUpdated < healthStats.totalTokens * 0.8 ? [`Low recent updates: ${healthStats.recentlyUpdated}/${healthStats.totalTokens}`] : [])
          ]
        }
      })
    }

    // New action to fetch all MCap tracking data with enhanced statistics
    if (action === 'list') {
      const page = parseInt(searchParams.get('page') || '1')
      const limit = parseInt(searchParams.get('limit') || '50')
      const search = searchParams.get('search') || ''
      const sortBy = searchParams.get('sortBy') || 'last_updated_at'
      const sortOrder = searchParams.get('sortOrder') || 'desc'
      const minGrowth = searchParams.get('minGrowth')
      const maxGrowth = searchParams.get('maxGrowth')
      const minMcap = searchParams.get('minMcap')
      const maxMcap = searchParams.get('maxMcap')
      const excludeZeroPnl = searchParams.get('excludeZeroPnl') === 'true'
      const timeFilter = searchParams.get('timeFilter') || 'all'
      const performanceFilter = searchParams.get('performanceFilter') || 'all'

      const offset = (page - 1) * limit

      // Get current SOL price for calculations
      const solPriceUSD = await getSolPriceUSD()

      const filterParams: McapListFilterParams = {
        search,
        timeFilter,
        performanceFilter,
        minGrowth,
        maxGrowth,
        minMcap,
        maxMcap,
      }
      const { sql: whereClause, values: whereValues } = buildMcapListWhere(filterParams)

      const sortColumn = LIST_SORT_COLUMNS.has(sortBy) ? sortBy : 'last_updated_at'
      const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC'

      const countRow = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM token_mcap_tracking ${whereClause}`,
        whereValues,
      )
      const count = countRow?.count ?? 0

      const listValues = [...whereValues, limit, offset]
      const limitIdx = whereValues.length + 1
      const offsetIdx = whereValues.length + 2
      const { rows: data } = await query<McapSnapshot>(
        `SELECT * FROM token_mcap_tracking ${whereClause}
         ORDER BY ${sortColumn} ${sortDir}
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        listValues,
      )

      const { sql: statsWhere, values: statsValues } = buildMcapListWhere({
        ...filterParams,
        statsOnly: true,
      })
      const { rows: allData } = await query<{
        mcap_growth_percent: number
        current_mcap: number
        first_mcap: number
        first_seen_at: string
        last_updated_at: string
        when_reach_80pct: string | null
        when_reach_120pct: string | null
        when_reach_200pct: string | null
        is_tracking_stuck: boolean
      }>(
        `SELECT mcap_growth_percent, current_mcap, first_mcap, first_seen_at, last_updated_at,
                when_reach_80pct, when_reach_120pct, when_reach_200pct, is_tracking_stuck
         FROM token_mcap_tracking ${statsWhere}
         LIMIT 100000`,
        statsValues,
      )

      if (!allData) {
        throw new Error('Failed to fetch statistics data')
      }

      // Filter out any remaining invalid records
      const validData = allData.filter(item =>
        item.current_mcap != null &&
        item.first_mcap != null &&
        item.mcap_growth_percent != null &&
        item.current_mcap > 0 &&
        item.first_mcap > 0
      )

      // Enhanced statistics calculations
      const totalTokens = allData.length
      const gainers = allData.filter(item => item.mcap_growth_percent > 0).length
      const losers = allData.filter(item => item.mcap_growth_percent < 0).length
      const zeroPercentTokens = allData.filter(item => Math.abs(item.mcap_growth_percent) < 0.01).length
      const zeroPercentage = totalTokens > 0 ? (zeroPercentTokens / totalTokens) * 100 : 0

      // Calculate average growth with and without 0% PnL
      const nonZeroTokens = allData.filter(item => Math.abs(item.mcap_growth_percent) >= 0.01)
      const avgGrowthAll = totalTokens > 0 ?
        allData.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / totalTokens : 0
      const avgGrowthExcludingZero = nonZeroTokens.length > 0 ?
        nonZeroTokens.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / nonZeroTokens.length : 0

      const highestGrowth = allData.length > 0
        ? Math.max(...allData.map((item) => item.mcap_growth_percent))
        : 0

      const bucketHourBangkok = (iso: string): string => {
        const { hour } = getAppLocalParts(new Date(iso))
        return hour.toString().padStart(2, '0')
      }

      // PnL Time Window Analysis
      const pnlThresholds = [50, 100, 200, 500, 1000, 2000, 5000]
      const pnlTimeWindows: Record<string, {
        count: number
        timeDistribution: Record<string, number>
        peakHours: string[]
        avgTimeToReach: number
      }> = {}

      pnlThresholds.forEach(threshold => {
        const tokensAboveThreshold = allData.filter(item => item.mcap_growth_percent >= threshold)

        // Time distribution analysis (24-hour format)
        const hourlyDistribution: Record<string, number> = {}
        for (let hour = 0; hour < 24; hour++) {
          hourlyDistribution[hour.toString().padStart(2, '0')] = 0
        }

        let totalTimeToReach = 0
        let validTimeCalculations = 0

        tokensAboveThreshold.forEach(token => {
          // Analyze when the token first reached this threshold
          const firstSeenDate = new Date(token.first_seen_at)
          const lastUpdatedDate = new Date(token.last_updated_at)

          // Use last_updated_at hour in Asia/Bangkok as sell/exit bucket
          const reachedHour = bucketHourBangkok(token.last_updated_at)
          hourlyDistribution[reachedHour]++

          // Calculate time to reach threshold (in hours)
          const timeDiff = (lastUpdatedDate.getTime() - firstSeenDate.getTime()) / (1000 * 60 * 60)
          if (timeDiff >= 0 && timeDiff <= 168) { // Within a week
            totalTimeToReach += timeDiff
            validTimeCalculations++
          }
        })

        // Find peak hours (top 3 hours with most occurrences)
        const sortedHours = Object.entries(hourlyDistribution)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .filter(([, count]) => count > 0)
          .map(([hour]) => `${hour}:00`)

        pnlTimeWindows[`PnL > ${threshold}%`] = {
          count: tokensAboveThreshold.length,
          timeDistribution: hourlyDistribution,
          peakHours: sortedHours,
          avgTimeToReach: validTimeCalculations > 0 ? totalTimeToReach / validTimeCalculations : 0
        }
      })

      // Buy Time Window Analysis (ENTRY): based on first_seen_at UTC hour
      const pnlBuyTimeWindows: Record<string, {
        count: number
        timeDistribution: Record<string, number>
        peakHours: string[]
        avgTimeToReach: number
      }> = {}

      pnlThresholds.forEach(threshold => {
        const tokensAboveThreshold = allData.filter(item => item.mcap_growth_percent >= threshold)

        const hourlyDistribution: Record<string, number> = {}
        for (let hour = 0; hour < 24; hour++) {
          hourlyDistribution[hour.toString().padStart(2, '0')] = 0
        }

        let totalTimeToReach = 0
        let validTimeCalculations = 0

        tokensAboveThreshold.forEach(token => {
          const firstSeenDate = new Date(token.first_seen_at)
          const lastUpdatedDate = new Date(token.last_updated_at)

          // Use first_seen_at hour in Asia/Bangkok as the ENTRY bucket
          const startHour = bucketHourBangkok(token.first_seen_at)
          hourlyDistribution[startHour]++

          // Keep the same average time-to-target calculation for comparability
          const timeDiff = (lastUpdatedDate.getTime() - firstSeenDate.getTime()) / (1000 * 60 * 60)
          if (timeDiff >= 0 && timeDiff <= 168) {
            totalTimeToReach += timeDiff
            validTimeCalculations++
          }
        })

        const sortedHours = Object.entries(hourlyDistribution)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .filter(([, count]) => count > 0)
          .map(([hour]) => `${hour}:00`)

        pnlBuyTimeWindows[`PnL > ${threshold}%`] = {
          count: tokensAboveThreshold.length,
          timeDistribution: hourlyDistribution,
          peakHours: sortedHours,
          avgTimeToReach: validTimeCalculations > 0 ? totalTimeToReach / validTimeCalculations : 0
        }
      })

      // Optional: single info-level log to document bases/timezones (no noisy per-token logs)
      log.info('mcap_tracker', 'Computed PnL time windows', {
        sellPeaks: 'last_updated_at (Asia/Bangkok)',
        buyPeaks: 'first_seen_at (Asia/Bangkok)',
        thresholds: pnlThresholds
      })

      // MCap-based analysis with debugging
      const under50k = validData.filter(item => item.first_mcap < 50000)
      const from51to100k = validData.filter(item => item.first_mcap >= 50000 && item.first_mcap <= 100000)
      const from101to200k = validData.filter(item => item.first_mcap >= 100001 && item.first_mcap <= 200000)
      const from201to500k = validData.filter(item => item.first_mcap >= 200001 && item.first_mcap <= 500000)
      const from501kto1M = validData.filter(item => item.first_mcap >= 500001 && item.first_mcap <= 1000000)
      const over1M = validData.filter(item => item.first_mcap > 1000000)

      // Add debugging logs
      console.log('MCap Range Debug Info:');
      console.log('Total validData:', validData.length);
      console.log('under50k count:', under50k.length);
      console.log('from51to100k count:', from51to100k.length);
      console.log('from101to200k count:', from101to200k.length);
      console.log('from201to500k count:', from201to500k.length);
      console.log('from501kto1M count:', from501kto1M.length);
      console.log('over1M count:', over1M.length);

      // Sample data from each range for debugging
      if (from51to100k.length > 0) {
        console.log('Sample from51to100k record:', {
          current_mcap: from51to100k[0].current_mcap,
          first_mcap: from51to100k[0].first_mcap,
          mcap_growth_percent: from51to100k[0].mcap_growth_percent
        });
      }

      // Helper function to safely calculate statistics with enhanced debugging
      const calculateRangeStats = (data: typeof validData, rangeName: string) => {
        console.log(`\nCalculating stats for ${rangeName}:`);
        console.log(`Total records: ${data.length}`);

        // Simple percentile with linear interpolation
        const percentile = (values: number[], p: number) => {
          if (values.length === 0) return 0
          const sorted = [...values].sort((a, b) => a - b)
          const rank = (p / 100) * (sorted.length - 1)
          const low = Math.floor(rank)
          const high = Math.ceil(rank)
          if (low === high) return sorted[low]
          const weight = rank - low
          return sorted[low] + (sorted[high] - sorted[low]) * weight
        }

        const stddev = (values: number[]) => {
          if (values.length === 0) return 0
          const mean = values.reduce((s, v) => s + v, 0) / values.length
          const variance = values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length
          return Math.sqrt(variance)
        }

        const buildHistogram = (values: number[]) => {
          const bins = [
            { label: '<= -90%', min: -Infinity, max: -90 },
            { label: '-90% to -50%', min: -90, max: -50 },
            { label: '-50% to 0%', min: -50, max: 0 },
            { label: '0% to 20%', min: 0, max: 20 },
            { label: '20% to 50%', min: 20, max: 50 },
            { label: '50% to 100%', min: 50, max: 100 },
            { label: '100% to 200%', min: 100, max: 200 },
            { label: '200% to 500%', min: 200, max: 500 },
            { label: '500% to 1000%', min: 500, max: 1000 },
            { label: '> 1000%', min: 1000, max: Infinity }
          ]
          return bins.map(b => {
            const count = values.reduce((acc, v) => {
              if (v >= b.min && v < b.max) return acc + 1
              // include upper Infinity
              if (b.max === Infinity && v >= b.min) return acc + 1
              // include lower -Infinity
              if (b.min === -Infinity && v < b.max) return acc + 1
              return acc
            }, 0)
            return { range: b.label, count }
          })
        }

        if (data.length === 0) {
          console.log(`${rangeName}: No data, returning zeros`);
          return {
            count: 0,
            avgMultiplier: 0,
            maxDrawdown: 0,
            avgGrowth: 0,
            medianMultiplier: 0,
            medianGrowth: 0,
            p75Growth: 0,
            p90Growth: 0,
            p25Growth: 0,
            worstGrowth: 0,
            stopLossRate: 0,
            stuckRate: 0,
            hitRate120: 0,
            bucketVolatility: 0,
            p75Multiplier: 0,
            growthHistogram: []
          }
        }

        const validRecords = data.filter(item =>
          item.first_mcap > 0 &&
          item.current_mcap > 0 &&
          !isNaN(item.mcap_growth_percent)
        )

        console.log(`${rangeName}: Valid records after filtering: ${validRecords.length}`);

        if (validRecords.length === 0) {
          console.log(`${rangeName}: No valid records, returning count only`);
          return {
            count: data.length,
            avgMultiplier: 0,
            maxDrawdown: 0,
            avgGrowth: 0,
            medianMultiplier: 0,
            medianGrowth: 0,
            p75Growth: 0,
            p90Growth: 0,
            p25Growth: 0,
            worstGrowth: 0,
            stopLossRate: 0,
            stuckRate: 0,
            hitRate120: 0,
            bucketVolatility: 0,
            p75Multiplier: 0,
            growthHistogram: []
          }
        }

        const multipliers = validRecords.map(item => item.current_mcap / item.first_mcap)
        // Use tracked growth for consistency
        const growthPercentages = validRecords.map(item => item.mcap_growth_percent)

        console.log(`${rangeName}: Sample multiplier: ${multipliers[0]}, Sample growth: ${growthPercentages[0]}`);

        const avgMultiplier = multipliers.reduce((sum, mult) => sum + mult, 0) / multipliers.length
        const avgGrowth = validRecords.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / validRecords.length

        const medianMultiplier = percentile(multipliers, 50)
        const medianGrowth = percentile(growthPercentages, 50)
        const p75Growth = percentile(growthPercentages, 75)
        const p90Growth = percentile(growthPercentages, 90)
        const p25Growth = percentile(growthPercentages, 25)
        const worstGrowth = Math.min(...growthPercentages)
        const stopLossRate = validRecords.length > 0
          ? (validRecords.filter(item => item.mcap_growth_percent <= STOP_LOSS_THRESHOLD).length / validRecords.length) * 100
          : 0
        const stuckRate = validRecords.length > 0
          ? (validRecords.filter(item => item.is_tracking_stuck === true).length / validRecords.length) * 100
          : 0
        const hitRate120 = validRecords.length > 0
          ? (validRecords.filter(item => item.mcap_growth_percent >= 120).length / validRecords.length) * 100
          : 0
        const bucketVolatility = stddev(growthPercentages)
        const p75Multiplier = percentile(multipliers, 75)
        const growthHistogram = buildHistogram(growthPercentages)

        const result = {
          count: data.length,
          avgMultiplier,
          maxDrawdown: worstGrowth,
          avgGrowth,
          medianMultiplier,
          medianGrowth,
          p75Growth,
          p90Growth,
          p25Growth,
          worstGrowth,
          stopLossRate,
          stuckRate,
          hitRate120,
          bucketVolatility,
          p75Multiplier,
          growthHistogram
        }

        console.log(`${rangeName}: Final result:`, result);
        return result;
      }

      const mcapRangeAnalysis = {
        under50k: calculateRangeStats(under50k, 'under50k'),
        from51to100k: calculateRangeStats(from51to100k, 'from51to100k'),
        from101to200k: calculateRangeStats(from101to200k, 'from101to200k'),
        from201to500k: calculateRangeStats(from201to500k, 'from201to500k'),
        from501kto1M: calculateRangeStats(from501kto1M, 'from501kto1M'),
        over1M: calculateRangeStats(over1M, 'over1M')
      }

      console.log('Final mcapRangeAnalysis:', JSON.stringify(mcapRangeAnalysis, null, 2));

      // 30-day PnL summary calculation
      const thirtyDaysAgo = new Date()
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

      // Use a separate query for 30-day stats to ensure we have the full history
      // regardless of the current list filters (which might limit to 24h, etc.)
      const { rows: thirtyDayData } = await query<{
        first_seen_at: string
        mcap_growth_percent: number
        current_mcap: number
      }>(
        `SELECT first_seen_at, mcap_growth_percent, current_mcap
         FROM token_mcap_tracking
         WHERE first_seen_at >= $1
         LIMIT 100000`,
        [thirtyDaysAgo.toISOString()],
      )

      const summaryData = thirtyDayData || []

      const recentTokens = summaryData.filter(item =>
        new Date(item.first_seen_at) >= thirtyDaysAgo
      )

      // Calculate daily breakdown for the past 30 days
      const dailyBreakdown = []
      for (let i = 29; i >= 0; i--) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        const dayStart = new Date(date.setHours(0, 0, 0, 0))
        const dayEnd = new Date(date.setHours(23, 59, 59, 999))

        const dayTokens = summaryData.filter(item => {
          const tokenDate = new Date(item.first_seen_at)
          return tokenDate >= dayStart && tokenDate <= dayEnd
        })

        const dayStats = {
          date: dayStart.toISOString().split('T')[0],
          tokensAdded: dayTokens.length,
          avgGrowth: dayTokens.length > 0 ?
            dayTokens.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / dayTokens.length : 0,
          totalMcap: dayTokens.reduce((sum, item) => sum + item.current_mcap, 0),
          gainers: dayTokens.filter(item => item.mcap_growth_percent > 0).length,
          losers: dayTokens.filter(item => item.mcap_growth_percent < 0).length
        }

        dailyBreakdown.push(dayStats)
      }

      // Optionally fetch live trending data to refresh current mcap/price for dynamic PnL
      let liveTrendingMap = new Map<string, { mcap: number; price: number }>()
      try {
        const baseUrl = process.env.API_HOST || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
        const trendingResp = await fetch(`${baseUrl}/api/trending?cache=off&nocache=true`, {
          headers: { 'x-no-cache': '1' },
          next: { revalidate: 0 }
        })
        if (trendingResp.ok) {
          const trendingJson = await trendingResp.json()
          const tokensArr = Array.isArray(trendingJson.tokens) ? trendingJson.tokens : []
          for (const t of tokensArr) {
            if (t && typeof t.token_address === 'string') {
              // Ensure numeric values
              const mcap = typeof t.mcap === 'number' ? t.mcap : 0
              const price = typeof t.price === 'number' ? t.price : 0
              liveTrendingMap.set(t.token_address, { mcap, price })
            }
          }
        } else {
          console.warn('Trending API returned non-OK for live refresh:', trendingResp.status)
        }
      } catch (e) {
        console.warn('Failed to fetch live trending data for PnL refresh:', e)
      }

      // Add SOL per token calculations to the data (prefer live mcap if available)
      for (const token of data || []) {
        normalizeTrackingTimeline(token as McapSnapshot)
      }

      const enhancedData = (data || []).map(token => {
        const live = liveTrendingMap.get(token.token_address)
        const currentMcap = typeof live?.mcap === 'number' && live.mcap > 0 ? live.mcap : token.current_mcap
        const firstMcap = token.first_mcap
        const refreshedGrowth = (firstMcap && firstMcap > 0 && typeof currentMcap === 'number')
          ? ((currentMcap - firstMcap) / firstMcap) * 100
          : token.mcap_growth_percent
        const currentPrice = typeof live?.price === 'number' && live.price > 0 ? live.price : undefined
        const firstSeenMs = new Date(token.first_seen_at).getTime()
        const nowMs = Date.now()
        const ageMs = nowMs - firstSeenMs
        const isFinished = ageMs >= MAX_TRACKING_AGE_MS
        const finishedAt = isFinished ? new Date(firstSeenMs + MAX_TRACKING_AGE_MS).toISOString() : null
        return {
          ...token,
          // Prefer refreshed values when available
          current_mcap: currentMcap,
          mcap_growth_percent: refreshedGrowth,
          is_finished: isFinished,
          finished_at: finishedAt,
          solPerToken: {
            first: token.first_mcap / solPriceUSD,
            current: currentMcap / solPriceUSD,
            growth: ((currentMcap / solPriceUSD) - (token.first_mcap / solPriceUSD)) / (token.first_mcap / solPriceUSD) * 100
          },
          // Inform consumers that this snapshot may include live refresh
          _live_refresh: Boolean(live),
          _live_price_usd: currentPrice
        }
      })

      const stats = {
        total: totalTokens,
        gainers,
        losers,
        zeroPercent: zeroPercentTokens,
        zeroPercentage,
        avgGrowth: excludeZeroPnl ? avgGrowthExcludingZero : avgGrowthAll,
        avgGrowthAll,
        avgGrowthExcludingZero,
        highestGrowth,
        totalMcap: allData.reduce((sum, item) => sum + item.current_mcap, 0),
        solPriceUSD,
        pnlTimeWindows,
        pnlBuyTimeWindows,
        timeWindowMeta: {
          sellPeakHourBasis: 'last_updated_at',
          sellPeakHourTimezone: 'Asia/Bangkok',
          buyPeakHourBasis: 'first_seen_at',
          buyPeakHourTimezone: 'Asia/Bangkok'
        },
        mcapRangeAnalysis,
        thirtyDaysSummary: {
          totalTokensAdded: recentTokens.length,
          avgDailyGrowth: recentTokens.length > 0 ?
            recentTokens.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / recentTokens.length : 0,
          dailyBreakdown
        }
      }

      // Toasts: tokens exceeding configured PnL threshold
      const pnlThresholdParam = searchParams.get('pnlThreshold')
      const pnlThreshold = pnlThresholdParam
        ? parseFloat(pnlThresholdParam)
        : parseFloat(process.env.NEXT_PUBLIC_MCAP_PNL_TOAST_THRESHOLD || process.env.MCAP_PNL_TOAST_THRESHOLD || '20')

      const toasts: Array<{ type: string; title: string; message: string; items?: Array<{ symbol: string; address: string; growthPercent: number }>; key?: string }> = []
      // Apply upper cap of 30% for High Performers bucket
      const upperCap = 30
      const tokensAboveThreshold = (enhancedData || []).filter(token =>
        typeof token.mcap_growth_percent === 'number' &&
        token.mcap_growth_percent >= pnlThreshold &&
        token.mcap_growth_percent <= upperCap
      )

      // Ensure unique tokens by address to avoid duplicates within a single response
      const seenAddr = new Set<string>()
      const uniqueAboveThreshold = tokensAboveThreshold.filter(t => {
        const addr = t.token_address
        if (!addr) return false
        if (seenAddr.has(addr)) return false
        seenAddr.add(addr)
        return true
      })

      if (uniqueAboveThreshold.length > 0) {
        const topNames = uniqueAboveThreshold.slice(0, 3).map(t => t.token_symbol || 'UNKNOWN').filter(Boolean)
        const items = uniqueAboveThreshold.map(t => ({
          symbol: t.token_symbol || 'UNKNOWN',
          address: t.token_address,
          growthPercent: typeof t.mcap_growth_percent === 'number' ? t.mcap_growth_percent : 0
        }))

        // Server-side dedup within a short window for identical toast content
        const now = Date.now()
        pruneRecentToastKeys(now)
        const key = computeToastKey('list', items.map(i => ({ address: i.address, growthPercent: i.growthPercent })), {
          threshold: pnlThreshold,
          cap: upperCap,
          page,
          limit
        })
        const last = recentToastKeys.get(key)
        if (!last || now - last > TOAST_DEDUP_WINDOW_MS) {
          recentToastKeys.set(key, now)
          toasts.push({
            type: 'info',
            title: 'High Performers',
            message: `${uniqueAboveThreshold.length} tokens ≥ ${pnlThreshold}% ≤ ${upperCap}% ${topNames.length ? `(${topNames.join(', ')}...)` : ''}`,
            items,
            key
          })
        }
      }

      return NextResponse.json({
        success: true,
        data: enhancedData,
        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages: Math.ceil((count || 0) / limit)
        },
        stats,
        toasts
      })
    }

    if (action === 'track' && tokenAddress && tokenSymbol && mcap) {
      // Respect stop_reason: if 'rug', skip tracking
      try {
        const stopRecord = await queryOne<{ stop_reason: string | null }>(
          `SELECT stop_reason FROM token_mcap_tracking WHERE token_address = $1`,
          [tokenAddress],
        )

        const stopReason = (stopRecord?.stop_reason || '').toString().toLowerCase()
        if (stopReason === 'rug') {
          return NextResponse.json({
            success: true,
            skipped: true,
            reason: 'rug',
            message: 'Tracking stopped due to stop_reason=rug',
            toasts: []
          })
        }
      } catch (e) {
        // If lookup fails, proceed; no hard stop
      }

      const mcapValue = parseInt(mcap)
      const pnlThresholdParam = searchParams.get('pnlThreshold')
      const pnlThreshold = pnlThresholdParam
        ? parseFloat(pnlThresholdParam)
        : parseFloat(process.env.NEXT_PUBLIC_MCAP_PNL_TOAST_THRESHOLD || process.env.MCAP_PNL_TOAST_THRESHOLD || '50')

      const result = await trackTokenMcap(tokenAddress, tokenSymbol, mcapValue)
      const displayString = getMcapDisplayString(result)

      const toasts: Array<{ type: string; title: string; message: string; items?: Array<{ symbol: string; address: string; growthPercent: number }>; key?: string }> = []
      const symbolForMsg = tokenSymbol || 'UNKNOWN'

      // Toast: new token tracked
      if (result.isFirstTime) {
        const now = Date.now()
        pruneRecentToastKeys(now)
        const key = computeToastKey('tracked', [{ address: tokenAddress }])
        const last = recentToastKeys.get(key)
        if (!last || now - last > TOAST_DEDUP_WINDOW_MS) {
          recentToastKeys.set(key, now)
          toasts.push({
            type: 'success',
            title: 'New Token Tracked',
            message: `${symbolForMsg} now tracked at $${mcapValue.toLocaleString()}`,
            items: [{ symbol: symbolForMsg || 'UNKNOWN', address: tokenAddress, growthPercent: typeof result.growthPercent === 'number' ? result.growthPercent : 0 }],
            key
          })
        }
      }

      // Toast: growth exceeds configured PnL threshold
      if (typeof result.growthPercent === 'number' && result.growthPercent >= pnlThreshold) {
        const now = Date.now()
        pruneRecentToastKeys(now)
        const key = computeToastKey('threshold', [{ address: tokenAddress, growthPercent: result.growthPercent }], { threshold: pnlThreshold })
        const last = recentToastKeys.get(key)
        if (!last || now - last > TOAST_DEDUP_WINDOW_MS) {
          recentToastKeys.set(key, now)
          toasts.push({
            type: 'info',
            title: 'PnL Threshold Reached',
            message: `${symbolForMsg} growth ${result.growthPercent.toFixed(1)}% ≥ ${pnlThreshold}%`,
            items: [{ symbol: symbolForMsg || 'UNKNOWN', address: tokenAddress, growthPercent: result.growthPercent }],
            key
          })
        }
      }

      return NextResponse.json({
        success: true,
        tracking: result,
        display: displayString,
        inRange: isInTrackingRange(mcapValue),
        toasts
      })
    }

    if (action === 'cleanup') {
      const days = parseInt(searchParams.get('days') || '30')
      await cleanupOldMcapRecords(days)

      return NextResponse.json({
        success: true,
        message: `Cleaned up MCap records older than ${days} days`
      })
    }

    // New refetch action to get current MCap and update tracking
    if (action === 'refetch' && tokenAddress) {
      try {
        // Respect stop_reason: if 'rug', skip refetch tracking
        try {
          const stopRecord = await queryOne<{ stop_reason: string | null }>(
            `SELECT stop_reason FROM token_mcap_tracking WHERE token_address = $1`,
            [tokenAddress],
          )

          const stopReason = (stopRecord?.stop_reason || '').toString().toLowerCase()
          if (stopReason === 'rug') {
            return NextResponse.json({
              success: true,
              skipped: true,
              reason: 'rug',
              message: 'Refetch skipped due to stop_reason=rug',
              toasts: []
            })
          }
        } catch { }

        // Fetch current price and market cap from trending API (live, no cache)
        const baseUrl = process.env.API_HOST || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
        
        let trendingResponse;
        try {
          trendingResponse = await fetch(`${baseUrl}/api/trending?cache=off&nocache=true`, {
            headers: { 'x-no-cache': '1' },
            next: { revalidate: 0 }
          });
        } catch (fetchError) {
          console.error('Fetch failed for trending API:', fetchError);
          return NextResponse.json({
            success: false,
            error: 'Failed to fetch current token data from trending API',
            details: fetchError instanceof Error ? fetchError.message : 'Unknown error'
          }, { status: 502 }); // Bad Gateway
        }

        if (!trendingResponse.ok) {
          throw new Error('Failed to fetch current token data from trending')
        }

        const trendingJson = await trendingResponse.json()
        const tokensArr = Array.isArray(trendingJson.tokens) ? trendingJson.tokens : []
        const liveTok = tokensArr.find((t: any) => t?.token_address === tokenAddress)

        if (!liveTok || typeof liveTok.mcap !== 'number' || liveTok.mcap <= 0) {
          return NextResponse.json({
            success: false,
            error: 'Token not found in trending or no market cap data available'
          }, { status: 404 })
        }

        // Get token symbol from database if not provided
        let symbol = tokenSymbol || 'UNKNOWN'
        if (!symbol) {
          const existingRecord = await queryOne<{ token_symbol: string }>(
            `SELECT token_symbol FROM token_mcap_tracking WHERE token_address = $1`,
            [tokenAddress],
          )

          symbol = existingRecord?.token_symbol || liveTok?.token_symbol || 'UNKNOWN'
        }

        // Track the updated MCap
        const result = await trackTokenMcap(tokenAddress, symbol, liveTok.mcap)
        const displayString = getMcapDisplayString(result)

        // Toasts for refetch action
        const pnlThresholdParam = searchParams.get('pnlThreshold')
        const pnlThreshold = pnlThresholdParam
          ? parseFloat(pnlThresholdParam)
          : parseFloat(process.env.NEXT_PUBLIC_MCAP_PNL_TOAST_THRESHOLD || process.env.MCAP_PNL_TOAST_THRESHOLD || '50')
        const toasts: Array<{ type: string; title: string; message: string; items?: Array<{ symbol: string; address: string; growthPercent: number }>; key?: string }> = []

        if (result.isFirstTime) {
          const now = Date.now()
          pruneRecentToastKeys(now)
          const key = computeToastKey('tracked', [{ address: tokenAddress }])
          const last = recentToastKeys.get(key)
          if (!last || now - last > TOAST_DEDUP_WINDOW_MS) {
            recentToastKeys.set(key, now)
            toasts.push({
              type: 'success',
              title: 'New Token Tracked',
              message: `${symbol || 'UNKNOWN'} now tracked at $${Number(liveTok.mcap).toLocaleString()}`,
              items: [{ symbol: symbol || 'UNKNOWN', address: tokenAddress, growthPercent: typeof result.growthPercent === 'number' ? result.growthPercent : 0 }],
              key
            })
          }
        }

        if (typeof result.growthPercent === 'number' && result.growthPercent >= pnlThreshold) {
          const now = Date.now()
          pruneRecentToastKeys(now)
          const key = computeToastKey('threshold', [{ address: tokenAddress, growthPercent: result.growthPercent }], { threshold: pnlThreshold })
          const last = recentToastKeys.get(key)
          if (!last || now - last > TOAST_DEDUP_WINDOW_MS) {
            recentToastKeys.set(key, now)
            toasts.push({
              type: 'info',
              title: 'PnL Threshold Reached',
              message: `${symbol || 'UNKNOWN'} growth ${result.growthPercent.toFixed(1)}% ≥ ${pnlThreshold}%`,
              items: [{ symbol: symbol || 'UNKNOWN', address: tokenAddress, growthPercent: result.growthPercent }],
              key
            })
          }
        }

        return NextResponse.json({
          success: true,
          tracking: result,
          display: displayString,
          inRange: isInTrackingRange(liveTok.mcap),
          currentMcap: liveTok.mcap,
          currentPrice: typeof liveTok.price === 'number' ? liveTok.price : 0,
          tokenData: {
            symbol: liveTok.token_symbol,
            name: liveTok.token_symbol,
            price: typeof liveTok.price === 'number' ? liveTok.price : 0,
            mcap: liveTok.mcap,
            volume24h: typeof liveTok.volume_1h === 'number' ? liveTok.volume_1h : undefined
          },
          toasts
        })
      } catch (error) {
        console.error('Error refetching MCap data:', error)
        return NextResponse.json({
          success: false,
          error: error instanceof Error ? error.message : 'Failed to refetch MCap data'
        }, { status: 500 })
      }
    }

    return NextResponse.json({
      success: false,
      error: 'Invalid action or missing parameters'
    }, { status: 400 })

  } catch (error) {
    console.error('Error in MCap tracking API:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const searchParams = new URL(request.url).searchParams
    const action = searchParams.get('action')

    // Bulk update stop_reason labels
    if (action === 'stop') {
      const { addresses, reason } = await request.json()

      if (!Array.isArray(addresses) || addresses.length === 0) {
        return NextResponse.json({ success: false, error: 'addresses must be a non-empty array' }, { status: 400 })
      }
      if (reason !== null && typeof reason !== 'string') {
        return NextResponse.json({ success: false, error: 'reason must be a string or null' }, { status: 400 })
      }

      // Normalize reason; treat 'continue' as null
      const normalizedReason = (reason || '').toString().toLowerCase() === 'continue' ? null : (reason || null)

      const cap = Math.min(addresses.length, 200)
      const target = addresses.slice(0, cap)

      await query(
        `UPDATE token_mcap_tracking SET stop_reason = $1 WHERE token_address = ANY($2::text[])`,
        [normalizedReason, target],
      )

      log.info('mcap_tracker', 'Updated stop_reason for tokens', { count: target.length, reason: normalizedReason || 'null' })

      return NextResponse.json({ success: true, updated: target.length, reason: normalizedReason || null })
    }

    const { tokens } = await request.json()

    if (!Array.isArray(tokens)) {
      return NextResponse.json({
        success: false,
        error: 'Tokens must be an array'
      }, { status: 400 })
    }

    const pnlThresholdParam = searchParams.get('pnlThreshold')
    const pnlThreshold = pnlThresholdParam
      ? parseFloat(pnlThresholdParam)
      : parseFloat(process.env.NEXT_PUBLIC_MCAP_PNL_TOAST_THRESHOLD || process.env.MCAP_PNL_TOAST_THRESHOLD || '50')

    const results = new Map()
    const toasts: Array<{ type: string; title: string; message: string; items?: Array<{ symbol: string; address: string; growthPercent: number }>; key?: string }> = []

    for (const token of tokens) {
      if (!token.address || !token.symbol || typeof token.mcap !== 'number') {
        continue
      }

      // Respect stop_reason: if 'rug', skip bulk tracking
      try {
        const stopRecord = await queryOne<{ stop_reason: string | null }>(
          `SELECT stop_reason FROM token_mcap_tracking WHERE token_address = $1`,
          [token.address],
        )
        const stopReason = (stopRecord?.stop_reason || '').toString().toLowerCase()
        if (stopReason === 'rug') {
          results.set(token.address, {
            skipped: true,
            reason: 'rug'
          })
          continue
        }
      } catch { }

      const result = await trackTokenMcap(token.address, token.symbol, token.mcap)
      results.set(token.address, {
        ...result,
        display: getMcapDisplayString(result),
        inRange: isInTrackingRange(token.mcap)
      })

      if (result.isFirstTime) {
        const now = Date.now()
        pruneRecentToastKeys(now)
        const key = computeToastKey('tracked', [{ address: token.address }])
        const last = recentToastKeys.get(key)
        if (!last || now - last > TOAST_DEDUP_WINDOW_MS) {
          recentToastKeys.set(key, now)
          toasts.push({
            type: 'success',
            title: 'New Token Tracked',
            message: `${token.symbol} now tracked at $${token.mcap.toLocaleString()}`,
            items: [{ symbol: token.symbol, address: token.address, growthPercent: typeof result.growthPercent === 'number' ? result.growthPercent : 0 }],
            key
          })
        }
      }

      if (typeof result.growthPercent === 'number' && result.growthPercent >= pnlThreshold) {
        const now = Date.now()
        pruneRecentToastKeys(now)
        const key = computeToastKey('threshold', [{ address: token.address, growthPercent: result.growthPercent }], { threshold: pnlThreshold })
        const last = recentToastKeys.get(key)
        if (!last || now - last > TOAST_DEDUP_WINDOW_MS) {
          recentToastKeys.set(key, now)
          toasts.push({
            type: 'info',
            title: 'PnL Threshold Reached',
            message: `${token.symbol} growth ${result.growthPercent.toFixed(1)}% ≥ ${pnlThreshold}%`,
            items: [{ symbol: token.symbol, address: token.address, growthPercent: result.growthPercent }],
            key
          })
        }
      }
    }

    return NextResponse.json({
      success: true,
      results: Object.fromEntries(results),
      totalTracked: results.size,
      toasts
    })

  } catch (error) {
    console.error('Error in bulk MCap tracking:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}