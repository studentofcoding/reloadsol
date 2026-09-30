import { NextRequest, NextResponse, connection } from 'next/server'
import { trackTokenMcap, getMcapDisplayString, isInTrackingRange, cleanupOldMcapRecords, getTrackingHealthStats, STOP_LOSS_THRESHOLD, MAX_TRACKING_AGE_MS, TokenLabel, normalizeTrackingTimeline, type McapSnapshot } from '@/utils/mcap-tracker'
import { query, queryOne } from '@/utils/db'
import { getSolPriceUSD } from '@/utils/solana'
import { getAppLocalParts } from '@/utils/datetime'
import { log } from '@/utils/unified-logger'
import { parseStrategyChain } from '@/strategies/types'
import {
  buildTrackActionToasts,
  pushHighPerformersToast,
  scanListForPredictiveAlerts,
  type McapToast,
} from '@/app/api/mcap-tracking/mcap-toasts'
import { isTrackerSocialJoinEnabled } from '@/utils/tracker-flags'
import { loadTrackerSocialJoinMap } from '@/app/api/mcap-tracking/join-trending-social'
import type { TrendingSocialFields } from '@/utils/tracker-social-join'
import { buildMcapListWhere } from '@/app/api/mcap-tracking/list-where'
import { cacheGet, cacheSet, cacheSetNx } from '@/utils/redis-cache'

/**
 * The list payload is a page render (TrackerTab / BoardTab on load and on every filter change)
 * and its stats walk every tracked token, so it is cached per query string. Fresh for a
 * minute; kept for a day so an expired entry can still be served while a detached refresh
 * recomputes it (the caller never waits on the recompute).
 */
const MCAP_LIST_FRESH_TTL_S = 60
const MCAP_LIST_STALE_TTL_S = 24 * 60 * 60

const LIST_SORT_COLUMNS = new Set([
  'last_updated_at', 'first_seen_at', 'mcap_growth_percent',
  'current_mcap', 'first_mcap', 'token_symbol', 'token_address',
])

export async function GET(request: NextRequest) {
  await connection()
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
      const baseUrl =
        process.env.API_HOST || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'
      // `__refresh` is the detached-refresh marker, so it must not be part of the key.
      const cacheParams = new URLSearchParams(searchParams)
      cacheParams.delete('__refresh')
      const cacheQuery = cacheParams.toString()
      const listCacheKey = `mcap:tracking:list:v1:${cacheQuery}`
      const listStaleKey = `${listCacheKey}:stale`
      const isRefreshPass = searchParams.get('__refresh') === '1'

      if (!isRefreshPass) {
        const cachedList = await cacheGet<Record<string, unknown>>(listCacheKey)
        if (cachedList) {
          return NextResponse.json(cachedList, { headers: { 'X-Mcap-Cache': 'fresh' } })
        }
        const staleList = await cacheGet<Record<string, unknown>>(listStaleKey)
        if (staleList) {
          // Single-flight: one detached refresh at a time, and it never delays this response.
          if (await cacheSetNx(`${listCacheKey}:refresh`, '1', 120)) {
            void fetch(`${baseUrl}/api/mcap-tracking?${cacheQuery}&__refresh=1`, {
              headers: { 'x-internal-refresh': '1' },
            }).catch(() => {})
          }
          return NextResponse.json(staleList, { headers: { 'X-Mcap-Cache': 'stale' } })
        }
      }

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

      const filterParams = {
        chain: parseStrategyChain(searchParams.get('chain')),
        search,
        timeFilter,
        performanceFilter,
        minGrowth,
        maxGrowth,
        minMcap,
        maxMcap,
        label: searchParams.get('label'),
      }
      const { sql: whereClause, values: whereValues, error: whereError } = buildMcapListWhere(filterParams)
      if (whereError) {
        return NextResponse.json({ success: false, error: whereError }, { status: 400 })
      }

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

      const { sql: statsWhere, values: statsValues, error: statsError } = buildMcapListWhere({
        ...filterParams,
        statsOnly: true,
      })
      if (statsError) {
        return NextResponse.json({ success: false, error: statsError }, { status: 400 })
      }
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

      // Enhanced statistics: ONE pass instead of six filters plus three reduces.
      const totalTokens = allData.length
      let gainers = 0
      let losers = 0
      let zeroPercentTokens = 0
      let nonZeroCount = 0
      let sumGrowthAll = 0
      let sumGrowthNonZero = 0
      let totalMcap = 0
      let highestGrowth = totalTokens > 0 ? -Infinity : 0
      for (const item of allData) {
        const growth = Number(item.mcap_growth_percent)
        sumGrowthAll += growth
        totalMcap += item.current_mcap
        if (growth > 0) gainers++
        if (growth < 0) losers++
        if (Math.abs(growth) < 0.01) zeroPercentTokens++
        else {
          nonZeroCount++
          sumGrowthNonZero += growth
        }
        if (growth > highestGrowth) highestGrowth = growth
      }
      const zeroPercentage = totalTokens > 0 ? (zeroPercentTokens / totalTokens) * 100 : 0
      const avgGrowthAll = totalTokens > 0 ? sumGrowthAll / totalTokens : 0
      const avgGrowthExcludingZero = nonZeroCount > 0 ? sumGrowthNonZero / nonZeroCount : 0

      const bucketHourBangkok = (iso: string): string => {
        const { hour } = getAppLocalParts(new Date(iso))
        return hour.toString().padStart(2, '0')
      }

      // PnL Time Window Analysis
      const pnlThresholds = [50, 100, 200, 500, 1000, 2000, 5000]
      type PnlTimeWindow = {
        count: number
        timeDistribution: Record<string, number>
        peakHours: string[]
        avgTimeToReach: number
      }
      const pnlTimeWindows: Record<string, PnlTimeWindow> = {}
      const pnlBuyTimeWindows: Record<string, PnlTimeWindow> = {}

      // Precompute the per-token window facts ONCE. The threshold passes below used to run
      // their own `new Date()` and `Intl` (via bucketHourBangkok) per row per threshold —
      // 14 passes over every tracked token, on a page-render path.
      const tokenWindows = allData.map((token) => ({
        growth: Number(token.mcap_growth_percent),
        sellHour: bucketHourBangkok(token.last_updated_at),
        buyHour: bucketHourBangkok(token.first_seen_at),
        timeDiff:
          (new Date(token.last_updated_at).getTime() -
            new Date(token.first_seen_at).getTime()) /
          (1000 * 60 * 60),
      }))

      pnlThresholds.forEach(threshold => {
        const tokensAboveThreshold = tokenWindows.filter(w => w.growth >= threshold)

        // Time distribution analysis (24-hour format)
        const hourlyDistribution: Record<string, number> = {}
        for (let hour = 0; hour < 24; hour++) {
          hourlyDistribution[hour.toString().padStart(2, '0')] = 0
        }

        let totalTimeToReach = 0
        let validTimeCalculations = 0

        tokensAboveThreshold.forEach(token => {
          // Use last_updated_at hour in Asia/Bangkok as sell/exit bucket
          hourlyDistribution[token.sellHour]++

          // Calculate time to reach threshold (in hours)
          const timeDiff = token.timeDiff
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

      // Buy Time Window Analysis (ENTRY): based on first_seen_at hour in Asia/Bangkok
      pnlThresholds.forEach(threshold => {
        const tokensAboveThreshold = tokenWindows.filter(w => w.growth >= threshold)

        const hourlyDistribution: Record<string, number> = {}
        for (let hour = 0; hour < 24; hour++) {
          hourlyDistribution[hour.toString().padStart(2, '0')] = 0
        }

        let totalTimeToReach = 0
        let validTimeCalculations = 0

        tokensAboveThreshold.forEach(token => {
          // Use first_seen_at hour in Asia/Bangkok as the ENTRY bucket
          hourlyDistribution[token.buyHour]++

          // Same average time-to-target calculation as the sell windows
          const timeDiff = token.timeDiff
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

      // 30 local-day windows, then ONE pass over the rows and one over the windows. This used
      // to re-filter the whole set for each of the 30 days, parsing a Date per row per day.
      const dayWindows: Array<{ startMs: number; endMs: number; date: string }> = []
      for (let i = 29; i >= 0; i--) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        const dayStart = new Date(date.setHours(0, 0, 0, 0))
        const dayEnd = new Date(date.setHours(23, 59, 59, 999))
        dayWindows.push({
          startMs: dayStart.getTime(),
          endMs: dayEnd.getTime(),
          date: dayStart.toISOString().split('T')[0],
        })
      }

      const dayTotals = dayWindows.map(() => ({
        tokensAdded: 0,
        sumGrowth: 0,
        sumMcap: 0,
        gainers: 0,
        losers: 0,
      }))
      const thirtyDaysAgoMs = thirtyDaysAgo.getTime()
      let recentCount = 0
      let recentSumGrowth = 0

      for (const item of summaryData) {
        const seenMs = new Date(item.first_seen_at).getTime()
        if (!Number.isFinite(seenMs)) continue
        if (seenMs >= thirtyDaysAgoMs) {
          recentCount++
          recentSumGrowth += item.mcap_growth_percent
        }
        // Windows are contiguous and ascending, so a binary search finds the one containing it.
        let lo = 0
        let hi = dayWindows.length - 1
        let idx = -1
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (seenMs < dayWindows[mid]!.startMs) hi = mid - 1
          else if (seenMs > dayWindows[mid]!.endMs) lo = mid + 1
          else {
            idx = mid
            break
          }
        }
        if (idx < 0) continue
        const totals = dayTotals[idx]!
        totals.tokensAdded++
        totals.sumGrowth += item.mcap_growth_percent
        totals.sumMcap += item.current_mcap
        if (item.mcap_growth_percent > 0) totals.gainers++
        if (item.mcap_growth_percent < 0) totals.losers++
      }

      const dailyBreakdown = dayWindows.map((window, i) => {
        const totals = dayTotals[i]!
        return {
          date: window.date,
          tokensAdded: totals.tokensAdded,
          avgGrowth: totals.tokensAdded > 0 ? totals.sumGrowth / totals.tokensAdded : 0,
          totalMcap: totals.sumMcap,
          gainers: totals.gainers,
          losers: totals.losers,
        }
      })

      // Optionally fetch live trending data to refresh current mcap/price for dynamic PnL
      let liveTrendingMap = new Map<string, {
        mcap: number
        price: number
        twitter?: string
        telegram?: string
        website?: string
        organic_score?: number
        logo_url?: string
      }>()
      try {
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
              liveTrendingMap.set(t.token_address, {
                mcap,
                price,
                twitter: typeof t.twitter === 'string' ? t.twitter : undefined,
                telegram: typeof t.telegram === 'string' ? t.telegram : undefined,
                website: typeof t.website === 'string' ? t.website : undefined,
                organic_score: typeof t.organic_score === 'number' ? t.organic_score : undefined,
                logo_url: typeof t.logo_url === 'string' ? t.logo_url : undefined,
              })
            }
          }
        } else {
          console.warn('Trending API returned non-OK for live refresh:', trendingResp.status)
        }
      } catch (e) {
        console.warn('Failed to fetch live trending data for PnL refresh:', e)
      }

      let socialJoin = new Map<string, {
        social?: { twitter?: string; telegram?: string; website?: string }
        organic_score?: number | null
        logo_url?: string | null
      }>()
      if (isTrackerSocialJoinEnabled()) {
        try {
          const jupiterTokens: TrendingSocialFields[] = [...liveTrendingMap.entries()].map(
            ([token_address, row]) => ({
              token_address,
              twitter: row.twitter,
              telegram: row.telegram,
              website: row.website,
              organic_score: row.organic_score,
              logo_url: row.logo_url,
            }),
          )
          socialJoin = await loadTrackerSocialJoinMap({
            chain: parseStrategyChain(searchParams.get('chain')),
            jupiterTokens,
          })
        } catch (e) {
          console.warn('Failed to join trending social onto mcap list:', e)
        }
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
        const social = socialJoin.get(token.token_address)
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
          _live_price_usd: currentPrice,
          ...(social
            ? {
                social: social.social,
                organic_score: social.organic_score ?? null,
                logo_url: social.logo_url ?? null,
              }
            : {}),
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
        totalMcap,
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
          totalTokensAdded: recentCount,
          avgDailyGrowth: recentCount > 0 ? recentSumGrowth / recentCount : 0,
          dailyBreakdown
        }
      }

      // Toasts: tokens exceeding configured PnL threshold
      const pnlThresholdParam = searchParams.get('pnlThreshold')
      const pnlThreshold = pnlThresholdParam
        ? parseFloat(pnlThresholdParam)
        : parseFloat(process.env.NEXT_PUBLIC_MCAP_PNL_TOAST_THRESHOLD || process.env.MCAP_PNL_TOAST_THRESHOLD || '20')

      const toasts: McapToast[] = []
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

        pushHighPerformersToast(toasts, {
          count: uniqueAboveThreshold.length,
          pnlThreshold,
          upperCap,
          topNames,
          items,
          page,
          limit,
        })
      }

      const scanPredictive = searchParams.get('scanPredictive') === 'true'
      let listData = enhancedData
      if (scanPredictive) {
        const scanned = await scanListForPredictiveAlerts(enhancedData)
        listData = scanned.tokens
        toasts.push(...scanned.toasts)
      }

      const listedBody = {
        success: true,
        data: listData,
        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages: Math.ceil((count || 0) / limit)
        },
        stats,
        toasts
      }

      await cacheSet(listCacheKey, listedBody, MCAP_LIST_FRESH_TTL_S)
      await cacheSet(listStaleKey, listedBody, MCAP_LIST_STALE_TTL_S)

      return NextResponse.json(listedBody, {
        headers: { 'X-Mcap-Cache': isRefreshPass ? 'refresh' : 'miss' },
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

      const toasts = await buildTrackActionToasts({
        isFirstTime: !!result.isFirstTime,
        growthPercent: result.growthPercent,
        tokenAddress,
        symbol: tokenSymbol || 'UNKNOWN',
        mcapValue,
        pnlThreshold,
      })

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

        const pnlThresholdParam = searchParams.get('pnlThreshold')
        const pnlThreshold = pnlThresholdParam
          ? parseFloat(pnlThresholdParam)
          : parseFloat(process.env.NEXT_PUBLIC_MCAP_PNL_TOAST_THRESHOLD || process.env.MCAP_PNL_TOAST_THRESHOLD || '50')

        const toasts = await buildTrackActionToasts({
          isFirstTime: !!result.isFirstTime,
          growthPercent: result.growthPercent,
          tokenAddress,
          symbol: symbol || 'UNKNOWN',
          mcapValue: Number(liveTok.mcap),
          pnlThreshold,
        })

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
    const toasts: McapToast[] = []

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

      const trackToasts = await buildTrackActionToasts({
        isFirstTime: !!result.isFirstTime,
        growthPercent: result.growthPercent,
        tokenAddress: token.address,
        symbol: token.symbol,
        mcapValue: token.mcap,
        pnlThreshold,
      })
      toasts.push(...trackToasts)
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