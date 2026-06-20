import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'
import { calculateGainPercentage } from '@/utils/trading-math'
import { sendTradeAlertDiscord, TradeAlertStatus, shouldEnableNotifications } from '@/utils/discord'

// Use same tables as other routes
const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

export const runtime = 'edge'

// GET endpoint for testing Discord notifications
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expected = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'

    if (secretKey !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check Discord configuration
    const discordEnabled = shouldEnableNotifications()
    const webhookUrl = process.env.DISCORD_WEBHOOK_AUTO_TRADE || process.env.DISCORD_WEBHOOK_URL || ''

    console.log('Discord Configuration Check:', {
      discordEnabled,
      webhookConfigured: !!webhookUrl,
      webhookUrl: webhookUrl ? `${webhookUrl.substring(0, 50)}...` : 'Not configured',
      env: {
        DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
        DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
        ENABLE_DISCORD_NOTIFICATIONS: process.env.ENABLE_DISCORD_NOTIFICATIONS
      }
    })

    // Test Discord notification
    let testResult = { success: false, error: 'Unknown error' }

    if (discordEnabled) {
      try {
        console.log('Sending test Discord notification...')
        await sendTradeAlertDiscord({
          tokenSymbol: 'TEST',
          status: 'buy' as TradeAlertStatus,
          isSimulated: false,
          currentGain: 25.5,
          peakGain: 30.2,
          priceUsd: 0.000123
        })

        testResult = { success: true, error: '' }
        console.log('Test Discord notification sent successfully')
      } catch (error) {
        testResult = {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to send test notification'
        }
        console.error('Test Discord notification failed:', error)
      }
    } else {
      testResult = { success: false, error: 'Discord notifications not enabled or webhook not configured' }
    }

    return NextResponse.json({
      success: true,
      message: 'Discord configuration test completed',
      discord: {
        enabled: discordEnabled,
        webhookConfigured: !!webhookUrl,
        testResult
      },
      environment: {
        NODE_ENV: process.env.NODE_ENV,
        DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
        DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
        ENABLE_DISCORD_NOTIFICATIONS: process.env.ENABLE_DISCORD_NOTIFICATIONS
      }
    })
  } catch (error) {
    console.error('Discord test endpoint error:', error)
    return NextResponse.json({
      error: 'Discord test failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expected = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'
    if (secretKey !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const thresholdParam = searchParams.get('threshold')
    const threshold = thresholdParam ? parseFloat(thresholdParam) : 0.5

    // Enhanced Discord configuration logging
    const discordEnabled = shouldEnableNotifications()
    const webhookUrl = process.env.DISCORD_WEBHOOK_AUTO_TRADE || process.env.DISCORD_WEBHOOK_URL || ''

    console.log('Price Monitor Discord Configuration:', {
      discordEnabled,
      webhookConfigured: !!webhookUrl,
      webhookUrl: webhookUrl ? `${webhookUrl.substring(0, 50)}...` : 'Not configured',
      env: {
        DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
        DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
        ENABLE_DISCORD_NOTIFICATIONS: process.env.ENABLE_DISCORD_NOTIFICATIONS
      }
    })

    // Fetch tokens with real trading positions still holding
    const { data: tokens, error } = await supabase
      .from(TRACKER_TABLE)
      .select('*')
      .eq('status', 'tracking')
      .not('trading_simulation', 'is', null)

    if (error) throw error

    const toProcess = (tokens || []).filter(t => {
      const sim = t.trading_simulation as any
      return sim && !sim.is_simulated && sim.current_status === 'holding'
    })

    let alertsSent = 0
    let alertsFailed = 0
    let updated = 0

    for (const token of toProcess) {
      try {
        // Build absolute URL for price API
        const vercelUrl = process.env.VERCEL_URL ?? ''
        const baseUrl = vercelUrl.startsWith('http') && vercelUrl !== ''
          ? vercelUrl
          : vercelUrl !== ''
            ? `https://${vercelUrl}`
            : 'https://reloadsol.app'

        const priceResp = await fetch(`${baseUrl}/api/tokens/prices?tokens=${token.token_address}`)
        if (!priceResp.ok) continue
        const { priceUsd } = await priceResp.json()
        if (!priceUsd || priceUsd <= 0) continue

        // Validate last_price_usd before calculating difference
        if (!token.last_price_usd || token.last_price_usd <= 0) {
          console.warn(`Skipping price difference calculation for ${token.token_symbol}: invalid last price ${token.last_price_usd}`)
          // Initialize last_price_usd with current price for future calculations
          const { error: initErr } = await supabase
            .from(TRACKER_TABLE)
            .update({ last_price_usd: priceUsd })
            .eq('id', token.id)
          if (initErr) console.error('Failed to initialize last_price_usd:', initErr)
          continue
        }

        const diffPercent = calculateGainPercentage(priceUsd, token.last_price_usd)
        if (Math.abs(diffPercent) < threshold) continue

        const peakGain = token.peak_gain_percentage
        let currentGain = 0
        if (token.initial_price_usd && token.initial_price_usd > 0) {
          currentGain = calculateGainPercentage(priceUsd, token.initial_price_usd)
        } else {
          console.warn(`Skipping gain calculation for ${token.token_symbol}: invalid initial price ${token.initial_price_usd}`)
        }

        // Update Supabase
        const { error: upErr } = await supabase
          .from(TRACKER_TABLE)
          .update({ last_price_usd: priceUsd, current_gain_percentage: currentGain })
          .eq('id', token.id)
        if (upErr) throw upErr
        updated++

        // Discord alert with enhanced logging
        if (!discordEnabled) {
          console.log('Discord notifications disabled, skipping alert for', token.token_symbol)
          continue
        }

        try {
          console.log('Attempting to send Discord alert for', token.token_symbol, {
            currentGain,
            peakGain,
            priceUsd,
            threshold,
            diffPercent,
            discordEnabled,
            webhookConfigured: !!webhookUrl
          })

          await sendTradeAlertDiscord({
            tokenSymbol: token.token_symbol,
            status: 'buy' as TradeAlertStatus,
            isSimulated: false,
            currentGain: currentGain,
            peakGain: peakGain,
            priceUsd: priceUsd
          })

          console.log('Discord alert sent successfully for', token.token_symbol)
          alertsSent++
        } catch (discordError) {
          console.error('Discord alert failed for', token.token_symbol, {
            error: discordError,
            discordEnabled,
            webhookConfigured: !!webhookUrl,
            errorMessage: discordError instanceof Error ? discordError.message : 'Unknown error'
          })
          alertsFailed++
        }
      } catch (inner) {
        console.error('Price monitor error for token', token.token_symbol, inner)
      }
    }

    return NextResponse.json({
      success: true,
      processed: toProcess.length,
      updated,
      alertsSent,
      alertsFailed,
      discord: {
        enabled: discordEnabled,
        webhookConfigured: !!webhookUrl
      }
    })
  } catch (err: any) {
    console.error('Price monitor route failed', err)
    return NextResponse.json({ error: err.message || 'internal' }, { status: 500 })
  }
}