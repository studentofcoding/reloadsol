import { NextRequest, NextResponse } from 'next/server'
import { trackTokenMcap, getMcapDisplayString, isInTrackingRange, cleanupOldMcapRecords, getTrackingHealthStats, STOP_LOSS_THRESHOLD, MAX_TRACKING_AGE_MS } from '@/utils/mcap-tracker'
import { supabase } from '@/utils/supabase'
import { getSolPriceUSD } from '@/utils/solana'
import { log } from '@/utils/unified-logger'

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

      const offset = (page - 1) * limit

      // Get current SOL price for calculations
      const solPriceUSD = await getSolPriceUSD()

      // Build query
      let query = supabase
        .from('token_mcap_tracking')
        .select('*', { count: 'exact' })

      // Apply search filter
      if (search) {
        query = query.or(`token_symbol.ilike.%${search}%,token_address.ilike.%${search}%`)
      }

      // Apply growth filters
      if (minGrowth !== null) {
        query = query.gte('mcap_growth_percent', parseFloat(minGrowth))
      }
      if (maxGrowth !== null) {
        query = query.lte('mcap_growth_percent', parseFloat(maxGrowth))
      }

      // Apply MCap filters
      if (minMcap !== null) {
        query = query.gte('first_mcap', parseFloat(minMcap))
      }
      if (maxMcap !== null) {
        query = query.lte('first_mcap', parseFloat(maxMcap))
      }

      // Apply sorting and pagination
      query = query
        .order(sortBy, { ascending: sortOrder === 'asc' })
        .range(offset, offset + limit - 1)

      const { data, error, count } = await query

      if (error) throw error

      // Get all data for comprehensive statistics with proper validation
      const allDataQuery = await supabase
        .from('token_mcap_tracking')
        .select('mcap_growth_percent, current_mcap, first_mcap, first_seen_at, last_updated_at, when_reach_80mc, when_reach_120mc, when_reach_200mc, is_tracking_stuck')
        .not('mcap_growth_percent', 'is', null)
        .not('current_mcap', 'is', null)
        .not('first_mcap', 'is', null)
        .gt('first_mcap', 0)
        .gt('current_mcap', 0)

      const { data: allData } = allDataQuery

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

          // Use last_updated_at as the time when threshold was reached
          const reachedHour = lastUpdatedDate.getHours()
          hourlyDistribution[reachedHour.toString().padStart(2, '0')]++

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

          // Use UTC hour of when the token was first_seen as the ENTRY bucket
          const startHourUTC = firstSeenDate.getUTCHours()
          hourlyDistribution[startHourUTC.toString().padStart(2, '0')]++

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
        sellPeaks: 'last_updated_at (server local time)',
        buyPeaks: 'first_seen_at (UTC)',
        thresholds: pnlThresholds
      })

      // MCap-based analysis with debugging
      const under50k = validData.filter(item => item.first_mcap < 50000)
      const from51to100k = validData.filter(item => item.first_mcap >= 50001 && item.first_mcap <= 100000)
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

      const recentTokens = allData.filter(item =>
        new Date(item.first_seen_at) >= thirtyDaysAgo
      )

      // Calculate daily breakdown for the past 30 days
      const dailyBreakdown = []
      for (let i = 29; i >= 0; i--) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        const dayStart = new Date(date.setHours(0, 0, 0, 0))
        const dayEnd = new Date(date.setHours(23, 59, 59, 999))

        const dayTokens = allData.filter(item => {
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

      // Add SOL per token calculations to the data
      const enhancedData = (data || []).map(token => {
        const firstSeenMs = new Date(token.first_seen_at).getTime()
        const nowMs = Date.now()
        const ageMs = nowMs - firstSeenMs
        const isFinished = ageMs >= MAX_TRACKING_AGE_MS
        const finishedAt = isFinished ? new Date(firstSeenMs + MAX_TRACKING_AGE_MS).toISOString() : null
        return {
          ...token,
          is_finished: isFinished,
          finished_at: finishedAt,
          solPerToken: {
            first: token.first_mcap / solPriceUSD,
            current: token.current_mcap / solPriceUSD,
            growth: ((token.current_mcap / solPriceUSD) - (token.first_mcap / solPriceUSD)) / (token.first_mcap / solPriceUSD) * 100
          }
        }
      })

      const stats = {
        total: count || 0,
        gainers,
        losers,
        zeroPercent: zeroPercentTokens,
        zeroPercentage,
        avgGrowth: excludeZeroPnl ? avgGrowthExcludingZero : avgGrowthAll,
        avgGrowthAll,
        avgGrowthExcludingZero,
        totalMcap: allData.reduce((sum, item) => sum + item.current_mcap, 0),
        solPriceUSD,
        pnlTimeWindows, // Sell/exit timing (by last_updated_at, server local time)
        pnlBuyTimeWindows, // Buy/entry timing (by first_seen_at, UTC)
        timeWindowMeta: {
          sellPeakHourBasis: 'last_updated_at',
          sellPeakHourTimezone: 'server_local',
          buyPeakHourBasis: 'first_seen_at',
          buyPeakHourTimezone: 'UTC'
        },
        mcapRangeAnalysis,
        thirtyDaysSummary: {
          totalTokensAdded: recentTokens.length,
          avgDailyGrowth: recentTokens.length > 0 ?
            recentTokens.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / recentTokens.length : 0,
          dailyBreakdown
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
        stats
      })
    }

    if (action === 'track' && tokenAddress && tokenSymbol && mcap) {
      const mcapValue = parseInt(mcap)
      const result = await trackTokenMcap(tokenAddress, tokenSymbol, mcapValue)
      const displayString = getMcapDisplayString(result)

      return NextResponse.json({
        success: true,
        tracking: result,
        display: displayString,
        inRange: isInTrackingRange(mcapValue)
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
        // Fetch current price and market cap from trending API
        const trendingResponse = await fetch(`${process.env.API_HOST || process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/trending/search?query=${tokenAddress}`)

        if (!trendingResponse.ok) {
          throw new Error('Failed to fetch current token data')
        }

        const trendingData = await trendingResponse.json()
        const tokenData = Array.isArray(trendingData) ? trendingData.find(t => t.id === tokenAddress) : null

        if (!tokenData || !tokenData.mcap) {
          return NextResponse.json({
            success: false,
            error: 'Token not found or no market cap data available'
          }, { status: 404 })
        }

        // Get token symbol from database if not provided
        let symbol = tokenSymbol || 'UNKNOWN'
        if (!symbol) {
          const { data: existingRecord } = await supabase
            .from('token_mcap_tracking')
            .select('token_symbol')
            .eq('token_address', tokenAddress)
            .single()

          symbol = existingRecord?.token_symbol || tokenData.symbol || 'UNKNOWN'
        }

        // Track the updated MCap
        const result = await trackTokenMcap(tokenAddress, symbol, tokenData.mcap)
        const displayString = getMcapDisplayString(result)

        return NextResponse.json({
          success: true,
          tracking: result,
          display: displayString,
          inRange: isInTrackingRange(tokenData.mcap),
          currentMcap: tokenData.mcap,
          currentPrice: tokenData.price || 0,
          tokenData: {
            symbol: tokenData.symbol,
            name: tokenData.name,
            price: tokenData.price,
            mcap: tokenData.mcap,
            volume24h: tokenData.volume24h
          }
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
    const { tokens } = await request.json()

    if (!Array.isArray(tokens)) {
      return NextResponse.json({
        success: false,
        error: 'Tokens must be an array'
      }, { status: 400 })
    }

    const results = new Map()

    for (const token of tokens) {
      if (!token.address || !token.symbol || typeof token.mcap !== 'number') {
        continue
      }

      const result = await trackTokenMcap(token.address, token.symbol, token.mcap)
      results.set(token.address, {
        ...result,
        display: getMcapDisplayString(result),
        inRange: isInTrackingRange(token.mcap)
      })
    }

    return NextResponse.json({
      success: true,
      results: Object.fromEntries(results),
      totalTracked: results.size
    })

  } catch (error) {
    console.error('Error in bulk MCap tracking:', error)
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}