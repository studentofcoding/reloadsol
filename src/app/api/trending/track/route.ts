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
      console.log('🤖 Vercel cron job detected: allowing tracking API call')
    } else if (isDevelopment && isLocalhost && !secretKey) {
      console.log('🔓 Development mode: allowing tracking API call without secret key')
    } else if (secretKey !== expectedSecretKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
    
    return NextResponse.json(summary)
    
  } catch (error) {
    console.error('❌ Error in trending token tracking:', error)
    return NextResponse.json({
      error: 'Failed to track trending tokens',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
} 