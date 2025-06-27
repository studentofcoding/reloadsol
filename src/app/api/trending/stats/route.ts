import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const refresh = searchParams.get('refresh') === 'true'
    const nocache = searchParams.get('nocache') === 'true'
    
    console.log(`📊 Fetching trending token statistics... ${refresh ? '(forced refresh)' : ''}${nocache ? '(no cache)' : ''}`)
    
    // Get the most recent summary
    const { data: summaries, error: summaryError } = await supabase
      .from('trending_token_summary')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)

    if (summaryError) {
      throw new Error(`Failed to fetch summaries: ${summaryError.message}`)
    }

    // Get currently tracked tokens (active tracking status)
    const { data: trackingTokens, error: trackingError } = await supabase
      .from('trending_token_tracker')
      .select('*')
      .eq('status', 'tracking')
      .order('peak_gain_percentage', { ascending: false })

    if (trackingError) {
      throw new Error(`Failed to fetch tracking tokens: ${trackingError.message}`)
    }

    // Get recent winners and losers for additional context
    const { data: recentCompleted, error: completedError } = await supabase
      .from('trending_token_tracker')
      .select('*')
      .in('status', ['won', 'lost'])
      .gte('status_changed_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()) // Last 7 days
      .order('status_changed_at', { ascending: false })
      .limit(20)

    if (completedError) {
      throw new Error(`Failed to fetch completed tokens: ${completedError.message}`)
    }

    // Get historical summaries for trends (last 7 days)
    const { data: historicalSummaries, error: historicalError } = await supabase
      .from('trending_token_summary')
      .select('*')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(7)

    if (historicalError) {
      console.error('Failed to fetch historical summaries:', historicalError)
    }

    // Calculate current tracking statistics
    const currentStats = {
      total_tracking: trackingTokens?.length || 0,
      positive_performers: trackingTokens?.filter(t => t.current_gain_percentage > 0).length || 0,
      negative_performers: trackingTokens?.filter(t => t.current_gain_percentage < 0).length || 0,
      at_risk: trackingTokens?.filter(t => t.current_gain_percentage <= -40).length || 0, // Close to -50% loss threshold
      top_performer: trackingTokens && trackingTokens.length > 0 
        ? {
            token_symbol: trackingTokens[0].token_symbol,
            token_name: trackingTokens[0].token_name,
            current_gain_percentage: trackingTokens[0].current_gain_percentage,
            peak_gain_percentage: trackingTokens[0].peak_gain_percentage
          }
        : null
    }

    // Separate recent winners and losers
    const recentWinners = recentCompleted?.filter(t => t.status === 'won') || []
    const recentLosers = recentCompleted?.filter(t => t.status === 'lost') || []

    // Calculate average performance metrics
    const avgCurrentGain = trackingTokens && trackingTokens.length > 0
      ? trackingTokens.reduce((sum, token) => sum + (token.current_gain_percentage || 0), 0) / trackingTokens.length
      : 0

    const avgPeakGain = trackingTokens && trackingTokens.length > 0
      ? trackingTokens.reduce((sum, token) => sum + (token.peak_gain_percentage || 0), 0) / trackingTokens.length
      : 0

    // Calculate trends from historical data
    let winRateTrend = 0
    if (historicalSummaries && historicalSummaries.length >= 2) {
      const latestWinRate = historicalSummaries[0]?.win_rate || 0
      const previousWinRate = historicalSummaries[1]?.win_rate || 0
      winRateTrend = latestWinRate - previousWinRate
    }

    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      
      // Latest 24-hour summary
      latest_summary: summaries && summaries.length > 0 ? summaries[0] : null,
      
      // Current tracking status
      current_tracking: {
        tokens: trackingTokens || [],
        statistics: currentStats,
        averages: {
          current_gain: Math.round(avgCurrentGain * 100) / 100,
          peak_gain: Math.round(avgPeakGain * 100) / 100
        }
      },
      
      // Recent performance
      recent_completed: {
        winners: recentWinners.slice(0, 10), // Top 10 recent winners
        losers: recentLosers.slice(0, 10)    // Top 10 recent losers
      },
      
      // Historical trends
      trends: {
        win_rate_change: Math.round(winRateTrend * 100) / 100,
        historical_summaries: historicalSummaries || []
      },
      
      // Metadata
      data_freshness: {
        tracking_tokens_count: trackingTokens?.length || 0,
        latest_summary_age_hours: summaries && summaries.length > 0 
          ? Math.round((Date.now() - new Date(summaries[0].created_at).getTime()) / (1000 * 60 * 60) * 100) / 100
          : null,
        last_updated: new Date().toISOString()
      }
    }

    console.log(`✅ Stats fetched: ${currentStats.total_tracking} tracking, ${recentWinners.length} recent winners, ${recentLosers.length} recent losers`)
    
    // Add cache metadata to response
    const enhancedResponse = {
      ...response,
      cached: false, // Always false for fresh data
      cache_age: 0,  // Fresh data
      expires_in: nocache ? 0 : 300 // 5 minutes unless nocache is requested
    }
    
    // Determine cache headers based on parameters
    const cacheHeaders: Record<string, string> = nocache 
      ? {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      : refresh
      ? {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' // Shorter cache for refresh
        }
      : {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' // 5-minute cache
        }
    
    return NextResponse.json(enhancedResponse, {
      status: 200,
      headers: cacheHeaders
    })
    
  } catch (error) {
    console.error('❌ Error fetching trending token stats:', error)
    return NextResponse.json({
      error: 'Failed to fetch trending token statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
} 