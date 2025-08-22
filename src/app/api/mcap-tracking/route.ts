import { NextRequest, NextResponse } from 'next/server'
import { trackTokenMcap, getMcapDisplayString, isInTrackingRange, cleanupOldMcapRecords } from '@/utils/mcap-tracker'
import { supabase } from '@/utils/supabase'
import { getSolPriceUSD } from '@/utils/solana'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')
    const tokenAddress = searchParams.get('token')
    const tokenSymbol = searchParams.get('symbol')
    const mcap = searchParams.get('mcap')

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
        query = query.gte('current_mcap', parseFloat(minMcap))
      }
      if (maxMcap !== null) {
        query = query.lte('current_mcap', parseFloat(maxMcap))
      }

      // Apply sorting and pagination
      query = query
        .order(sortBy, { ascending: sortOrder === 'asc' })
        .range(offset, offset + limit - 1)

      const { data, error, count } = await query

      if (error) throw error

      // Get all data for comprehensive statistics
      const allDataQuery = await supabase
        .from('token_mcap_tracking')
        .select('mcap_growth_percent, current_mcap, first_mcap, first_seen_at, last_updated_at')

      const { data: allData } = allDataQuery

      if (!allData) {
        throw new Error('Failed to fetch statistics data')
      }

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

      // MCap-based analysis
      const under50k = allData.filter(item => item.current_mcap < 50000)
      const under200k = allData.filter(item => item.current_mcap < 200000)
      const under1M = allData.filter(item => item.current_mcap < 1000000)

      const mcapRangeAnalysis = {
        under50k: {
          count: under50k.length,
          avgMultiplier: under50k.length > 0 ?
            under50k.reduce((sum, item) => sum + (item.current_mcap / item.first_mcap), 0) / under50k.length : 0,
          maxDrawdown: under50k.length > 0 ?
            Math.min(...under50k.map(item => ((item.current_mcap - item.first_mcap) / item.first_mcap) * 100)) : 0,
          avgGrowth: under50k.length > 0 ?
            under50k.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / under50k.length : 0
        },
        under200k: {
          count: under200k.length,
          avgMultiplier: under200k.length > 0 ?
            under200k.reduce((sum, item) => sum + (item.current_mcap / item.first_mcap), 0) / under200k.length : 0,
          maxDrawdown: under200k.length > 0 ?
            Math.min(...under200k.map(item => ((item.current_mcap - item.first_mcap) / item.first_mcap) * 100)) : 0,
          avgGrowth: under200k.length > 0 ?
            under200k.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / under200k.length : 0
        },
        under1M: {
          count: under1M.length,
          avgMultiplier: under1M.length > 0 ?
            under1M.reduce((sum, item) => sum + (item.current_mcap / item.first_mcap), 0) / under1M.length : 0,
          maxDrawdown: under1M.length > 0 ?
            Math.min(...under1M.map(item => ((item.current_mcap - item.first_mcap) / item.first_mcap) * 100)) : 0,
          avgGrowth: under1M.length > 0 ?
            under1M.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / under1M.length : 0
        }
      }

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
      const enhancedData = (data || []).map(token => ({
        ...token,
        solPerToken: {
          first: token.first_mcap / solPriceUSD,
          current: token.current_mcap / solPriceUSD,
          growth: ((token.current_mcap / solPriceUSD) - (token.first_mcap / solPriceUSD)) / (token.first_mcap / solPriceUSD) * 100
        }
      }))

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