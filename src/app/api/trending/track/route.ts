import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'

interface JupiterBaseAsset {
  id: string
  name: string
  symbol: string
  icon: string
  decimals: number
  usdPrice: number
  stats1h: {
    priceChange: number
    numNetBuyers: number
    buyVolume: number
  }
  stats5m: {
    priceChange: number
  }
  mcap: number
  organicScore: number
}

interface JupiterPool {
  id: string
  baseAsset: JupiterBaseAsset
  volume24h: number
  createdAt: string | number
}

interface JupiterResponse {
  pools: JupiterPool[]
}

interface TrackedToken {
  id: string
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: number
  last_price_usd: number
  peak_price_usd: number
  current_gain_percentage: number
  peak_gain_percentage: number
  status: 'tracking' | 'won' | 'lost'
  organic_score: number | null
  market_cap: number | null
  volume_1h: number | null
  tracking_started_at: string
  status_changed_at: string | null
  created_at: string
  updated_at: string
}

// Add TopWinner interface for summary functionality
interface TopWinner {
  token_address: string
  token_symbol: string | null
  token_name: string | null
  logo_url: string | null
  initial_price_usd: number
  peak_price_usd: number
  peak_gain_percentage: number
  tracking_duration_hours: number
  status_changed_at: string
}

// Helper function to check when last summary was run
async function checkLastSummaryTime(): Promise<Date | null> {
  try {
    const { data, error } = await supabase
      .from('trending_token_summary')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)

    if (error || !data || data.length === 0) {
      return null
    }

    return new Date(data[0].created_at)
  } catch (error) {
    console.error('Error checking last summary time:', error)
    return null
  }
}

// Helper function to determine if daily summary should run
function shouldRunDailySummary(currentTime: Date, lastSummaryTime: Date | null): boolean {
  if (!lastSummaryTime) {
    return true // No previous summary, run it
  }

  // Check if it's been more than 23 hours since last summary
  const hoursSinceLastSummary = (currentTime.getTime() - lastSummaryTime.getTime()) / (1000 * 60 * 60)
  
  // Run daily summary once per day (allow 23+ hours gap to avoid missing due to slight timing differences)
  return hoursSinceLastSummary >= 23
}

// Helper function to check if PnL update should run (once daily at 2 AM UTC)
function shouldRunPnLUpdate(currentTime: Date): boolean {
  const hour = currentTime.getUTCHours()
  const minute = currentTime.getUTCMinutes()
  
  // Run PnL update at 2 AM UTC (allow 5-minute window: 2:00-2:05)
  return hour === 2 && minute < 5
}

// Helper function to run PnL update
async function runPnLUpdate(): Promise<void> {
  try {
    console.log('🔄 Running PnL update...')
    
    // Call the PnL update API internally
    const pnlResponse = await fetch(`${process.env.VERCEL_URL || 'http://localhost:3000'}/api/pnl/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'vercel-cron-internal'
      }
    })
    
    if (pnlResponse.ok) {
      const pnlResult = await pnlResponse.json()
      console.log('✅ PnL update completed:', pnlResult)
    } else {
      console.error('❌ PnL update failed:', pnlResponse.status, await pnlResponse.text())
    }
  } catch (error) {
    console.error('❌ Error running PnL update:', error)
    // Don't throw - let tracking continue even if PnL update fails
  }
}

// Helper function to run daily summary
async function runDailySummary(currentTime: Date): Promise<void> {
  try {
    const periodStart = new Date(currentTime.getTime() - 24 * 60 * 60 * 1000) // 24 hours ago
    
    // Get all tokens that were tracked in the last 24 hours
    const { data: allTokens, error: fetchError } = await supabase
      .from('trending_token_tracker')
      .select('*')
      .gte('tracking_started_at', periodStart.toISOString())

    if (fetchError) {
      throw new Error(`Failed to fetch tracked tokens: ${fetchError.message}`)
    }

    if (!allTokens || allTokens.length === 0) {
      console.log('📭 No tokens tracked in the last 24 hours for summary')
      return
    }

    const tokens = allTokens as TrackedToken[]
    console.log(`🔍 Found ${tokens.length} tokens tracked in the last 24 hours for summary`)

    // Categorize tokens
    const trackingTokens = tokens.filter(t => t.status === 'tracking')
    const lostTokens = tokens.filter(t => t.status === 'lost')
    const wonTokens = tokens.filter(t => t.status === 'won')

    // Identify top 5 performers among tracking tokens
    const topPerformers = trackingTokens
      .filter(token => token.peak_gain_percentage > 0) // Only consider profitable tokens
      .sort((a, b) => b.peak_gain_percentage - a.peak_gain_percentage)
      .slice(0, 5)

    console.log(`🏆 Found ${topPerformers.length} top performers to mark as winners`)

    // Mark top performers as "won"
    const updatePromises: Promise<any>[] = []
    topPerformers.forEach(token => {
      updatePromises.push(
        (async () => {
          const { error } = await supabase
            .from('trending_token_tracker')
            .update({
              status: 'won',
              status_changed_at: currentTime.toISOString()
            })
            .eq('id', token.id)
          if (error) throw error
        })()
      )
    })

    // Execute all updates
    const results = await Promise.allSettled(updatePromises)
    const failedUpdates = results.filter(result => result.status === 'rejected')
    
    if (failedUpdates.length > 0) {
      console.error(`⚠️ ${failedUpdates.length} winner updates failed:`, failedUpdates)
    }

    // Calculate statistics
    const totalCompleted = lostTokens.length + topPerformers.length + wonTokens.length
    const totalWon = topPerformers.length + wonTokens.length
    const winRate = totalCompleted > 0 ? (totalWon / totalCompleted) * 100 : 0

    // Calculate summary statistics
    const allGains = [...topPerformers, ...wonTokens].map(t => t.peak_gain_percentage)
    const allLosses = lostTokens.map(t => Math.abs(t.current_gain_percentage))
    
    const avgPeakGain = allGains.length > 0 ? allGains.reduce((a, b) => a + b, 0) / allGains.length : 0
    const maxPeakGain = allGains.length > 0 ? Math.max(...allGains) : 0
    const avgLoss = allLosses.length > 0 ? allLosses.reduce((a, b) => a + b, 0) / allLosses.length : 0

    // Prepare top winners data for storage
    const topWinnersData: TopWinner[] = topPerformers.map(token => {
      const trackingStart = new Date(token.tracking_started_at)
      const trackingDuration = (currentTime.getTime() - trackingStart.getTime()) / (1000 * 60 * 60)
      
      return {
        token_address: token.token_address,
        token_symbol: token.token_symbol,
        token_name: token.token_name,
        logo_url: token.logo_url,
        initial_price_usd: token.initial_price_usd,
        peak_price_usd: token.peak_price_usd,
        peak_gain_percentage: token.peak_gain_percentage,
        tracking_duration_hours: Math.round(trackingDuration * 100) / 100,
        status_changed_at: currentTime.toISOString()
      }
    })

    // Create summary record
    const summaryId = `summary_${Date.now()}`
    const { error: summaryError } = await supabase
      .from('trending_token_summary')
      .insert({
        id: summaryId,
        period_start: periodStart.toISOString(),
        period_end: currentTime.toISOString(),
        total_tokens_tracked: tokens.length,
        won_tokens: totalWon,
        lost_tokens: lostTokens.length,
        still_tracking: trackingTokens.length - topPerformers.length,
        win_rate: Math.round(winRate * 100) / 100,
        top_winners: topWinnersData,
        avg_peak_gain: Math.round(avgPeakGain * 100) / 100,
        max_peak_gain: Math.round(maxPeakGain * 100) / 100,
        avg_loss: Math.round(avgLoss * 100) / 100
      })

    if (summaryError) {
      throw new Error(`Failed to save summary: ${summaryError.message}`)
    }

    console.log(`✅ Daily summary completed: ${tokens.length} tokens tracked, ${totalWon} won, ${lostTokens.length} lost, win rate: ${winRate.toFixed(1)}%`)
  } catch (error) {
    console.error('❌ Error running daily summary:', error)
    // Don't throw - let tracking continue even if summary fails
  }
}

export async function POST(request: NextRequest) {
  try {
    // Validate authentication (server-side only)
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'trending-track-secret'
    
    // Check if this is a Vercel cron job (has special headers)
    const isVercelCron = request.headers.get('vercel-cron') === '1' || 
                        request.headers.get('user-agent')?.includes('vercel-cron') ||
                        process.env.VERCEL === '1' && !secretKey && !request.headers.get('referer')
    
    // Allow calls from:
    // 1. Vercel cron jobs (internal calls)
    // 2. Localhost in development (no secret needed)
    // 3. Valid secret key (manual/external calls)
    const isDevelopment = process.env.NODE_ENV === 'development'
    const isLocalhost = request.headers.get('host')?.includes('localhost') || request.headers.get('host')?.includes('127.0.0.1')
    
    if (isVercelCron) {
      console.log('🤖 Vercel cron job detected: allowing combined tracking+summary API call')
    } else if (isDevelopment && isLocalhost && !secretKey) {
      console.log('🔓 Development mode: allowing combined tracking+summary API call without secret key')
    } else if (secretKey !== expectedSecretKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Determine if we should run daily summary (runs once per day at ~midnight)
    const currentTime = new Date()
    const lastSummaryCheck = await checkLastSummaryTime()
    const shouldRunSummary = shouldRunDailySummary(currentTime, lastSummaryCheck)

    if (shouldRunSummary) {
      console.log('📊 Running daily summary before tracking update...')
      await runDailySummary(currentTime)
    }

    // Also check if we should run PnL update (once daily at 2 AM UTC)
    const shouldRunPnL = shouldRunPnLUpdate(currentTime)
    if (shouldRunPnL) {
      console.log('💰 Running daily PnL update...')
      await runPnLUpdate()
    }

    console.log('🔍 Starting 5-minute trending token tracking...')
    
    // Fetch current trending tokens from Jupiter API
    const response = await fetch('https://datapi.jup.ag/v1/pools/toptrending/1h', {
      headers: {
        'accept': 'application/json',
        'cache-control': 'no-cache',
      },
    })

    if (!response.ok) {
      throw new Error(`Jupiter API responded with status: ${response.status}`)
    }

    const data = await response.json() as JupiterResponse
    
    // Filter tokens using the same criteria as the main trending API
    const filteredTokens = data.pools
      .filter(pool => 
        pool.baseAsset.stats5m?.priceChange > -40 && // Not dropping more than 40% in 5m
        pool.baseAsset.organicScore >= 70.0 &&
        pool.baseAsset.mcap > 300000 &&
        pool.baseAsset.mcap < 2000000
      )
      .map(pool => ({
        token_address: pool.baseAsset.id,
        token_symbol: pool.baseAsset.symbol,
        token_name: pool.baseAsset.name,
        logo_url: pool.baseAsset.icon,
        current_price: pool.baseAsset.usdPrice,
        organic_score: pool.baseAsset.organicScore,
        market_cap: pool.baseAsset.mcap,
        volume_1h: pool.baseAsset.stats1h.buyVolume,
        change_1h: (pool.baseAsset.stats1h?.priceChange ?? 0) / 100,
        change_5m: (pool.baseAsset.stats5m?.priceChange ?? 0) / 100
      }))

    console.log(`📊 Found ${filteredTokens.length} trending tokens to process`)

    // Get currently tracked tokens
    const { data: trackedTokens, error: fetchError } = await supabase
      .from('trending_token_tracker')
      .select('*')
      .eq('status', 'tracking')

    if (fetchError) {
      throw new Error(`Failed to fetch tracked tokens: ${fetchError.message}`)
    }

    const trackedTokensMap = new Map<string, TrackedToken>()
    trackedTokens?.forEach(token => {
      trackedTokensMap.set(token.token_address, token as TrackedToken)
    })

    let newTokensAdded = 0
    let tokensUpdated = 0
    let tokensLost = 0
    const updatesPromises: Promise<any>[] = []

    // Process each trending token
    for (const token of filteredTokens) {
      const existingToken = trackedTokensMap.get(token.token_address)
      
      if (!existingToken) {
        // New token - start tracking it
        const tokenId = `track_${token.token_address}_${Date.now()}`
        
        updatesPromises.push(
          (async () => {
            const { error } = await supabase
              .from('trending_token_tracker')
              .insert({
                id: tokenId,
                token_address: token.token_address,
                token_symbol: token.token_symbol,
                token_name: token.token_name,
                logo_url: token.logo_url,
                initial_price_usd: token.current_price,
                last_price_usd: token.current_price,
                peak_price_usd: token.current_price,
                current_gain_percentage: 0,
                peak_gain_percentage: 0,
                status: 'tracking',
                organic_score: token.organic_score,
                market_cap: token.market_cap,
                volume_1h: token.volume_1h,
                tracking_started_at: new Date().toISOString()
              })
            if (error) throw error
          })()
        )
        
        newTokensAdded++
        console.log(`✅ Adding new token to track: ${token.token_symbol} (${token.token_address})`)
      } else {
        // Existing token - update price and check for loss
        const currentGain = ((token.current_price - existingToken.initial_price_usd) / existingToken.initial_price_usd) * 100
        const newPeakPrice = Math.max(existingToken.peak_price_usd, token.current_price)
        const peakGain = ((newPeakPrice - existingToken.initial_price_usd) / existingToken.initial_price_usd) * 100
        
        // Check if token has dropped more than 50% from initial price
        const isLost = currentGain <= -50
        
        if (isLost && existingToken.status === 'tracking') {
          // Mark as lost
          updatesPromises.push(
            (async () => {
              const { error } = await supabase
                .from('trending_token_tracker')
                .update({
                  last_price_usd: token.current_price,
                  peak_price_usd: newPeakPrice,
                  current_gain_percentage: currentGain,
                  peak_gain_percentage: peakGain,
                  status: 'lost',
                  status_changed_at: new Date().toISOString(),
                  organic_score: token.organic_score,
                  market_cap: token.market_cap,
                  volume_1h: token.volume_1h
                })
                .eq('id', existingToken.id)
              if (error) throw error
            })()
          )
          
          tokensLost++
          console.log(`❌ Token lost (${currentGain.toFixed(2)}%): ${token.token_symbol} (${token.token_address})`)
        } else if (existingToken.status === 'tracking') {
          // Update tracking token with new price data
          updatesPromises.push(
            (async () => {
              const { error } = await supabase
                .from('trending_token_tracker')
                .update({
                  last_price_usd: token.current_price,
                  peak_price_usd: newPeakPrice,
                  current_gain_percentage: currentGain,
                  peak_gain_percentage: peakGain,
                  organic_score: token.organic_score,
                  market_cap: token.market_cap,
                  volume_1h: token.volume_1h
                })
                .eq('id', existingToken.id)
              if (error) throw error
            })()
          )
          
          tokensUpdated++
          if (currentGain > 10) {
            console.log(`📈 Token performing well (${currentGain.toFixed(2)}%): ${token.token_symbol}`)
          }
        }
      }
    }

    // Execute all updates in parallel
    const results = await Promise.allSettled(updatesPromises)
    const failedUpdates = results.filter(result => result.status === 'rejected')
    
    if (failedUpdates.length > 0) {
      console.error(`⚠️ ${failedUpdates.length} updates failed:`, failedUpdates)
    }

    // Get updated statistics
    const { data: currentStats, error: statsError } = await supabase
      .from('trending_token_tracker')
      .select('status')
    
    if (statsError) {
      console.error('Failed to fetch current stats:', statsError)
    }

    const stats = {
      tracking: currentStats?.filter(t => t.status === 'tracking').length || 0,
      won: currentStats?.filter(t => t.status === 'won').length || 0,
      lost: currentStats?.filter(t => t.status === 'lost').length || 0
    }

    const summary = {
      success: true,
      timestamp: new Date().toISOString(),
      processed: filteredTokens.length,
      new_tokens_added: newTokensAdded,
      tokens_updated: tokensUpdated,
      tokens_lost: tokensLost,
      failed_updates: failedUpdates.length,
      current_stats: stats,
      message: `Tracked ${filteredTokens.length} tokens: ${newTokensAdded} new, ${tokensUpdated} updated, ${tokensLost} lost`
    }

    console.log('✅ 5-minute tracking completed:', summary)
    
    // Set a timestamp for cache invalidation (could be used by other APIs)
    const headers: Record<string, string> = {
      'X-Data-Updated': new Date().toISOString(),
      'Cache-Control': 'no-cache' // Track route should never be cached
    }
    
    return NextResponse.json(summary, { 
      status: 200, 
      headers 
    })
    
  } catch (error) {
    console.error('❌ Error in trending token tracking:', error)
    return NextResponse.json({
      error: 'Failed to track trending tokens',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
} 