import { NextRequest, NextResponse } from 'next/server'
import { trackTokenMcap, getMcapDisplayString, isInTrackingRange, cleanupOldMcapRecords } from '@/utils/mcap-tracker'
import { supabase } from '@/utils/supabase'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')
    const tokenAddress = searchParams.get('token')
    const tokenSymbol = searchParams.get('symbol')
    const mcap = searchParams.get('mcap')

    // New action to fetch all MCap tracking data
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

      const offset = (page - 1) * limit

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

      // Calculate statistics
      const statsQuery = await supabase
        .from('token_mcap_tracking')
        .select('mcap_growth_percent, current_mcap, first_mcap')

      const { data: statsData } = statsQuery

      const stats = {
        total: count || 0,
        gainers: statsData?.filter(item => item.mcap_growth_percent > 0).length || 0,
        losers: statsData?.filter(item => item.mcap_growth_percent < 0).length || 0,
        avgGrowth: statsData?.length ?
          statsData.reduce((sum, item) => sum + item.mcap_growth_percent, 0) / statsData.length : 0,
        totalMcap: statsData?.reduce((sum, item) => sum + item.current_mcap, 0) || 0
      }

      return NextResponse.json({
        success: true,
        data: data || [],
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