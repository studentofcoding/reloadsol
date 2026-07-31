import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { queryOne } from '@/utils/db'
import { withUnifiedLogging } from '@/utils/unified-logger'
import {
  shouldEnableNotifications,
  sendNewTokenDetectionDiscord,
  sendBuyNotificationDiscord,
  sendTradeAlertDiscord,
} from '@/utils/discord'
import { formatAppDateTime } from '@/utils/datetime'
import type { JupiterResponse } from '@/types'
import { getCurrentBotStrategySync } from '@/strategies/load-strategy'
import { DISCORD_WEBHOOK_URL, TRACKER_TABLE } from '@/strategies/trending-track/constants'
import {
  performEnhancedFiltering,
  parseCustomFilterConfig,
} from '@/strategies/trending-track/filtering'
import { setTradingMode } from '@/strategies/trending-track/trading-mode'
import { diagnoseTradingWallet } from '@/strategies/trending-track/wallet'
import { internalTrackPost } from '@/strategies/trending-track/cycle'

// ====================================================================================================
// REAL TRADING SETUP INSTRUCTIONS:
// ====================================================================================================
// To enable REAL trading (not simulation), you need to set up the following environment variables:
//
// 1. TRADING_KEYPAIR_JSON: Your wallet's private key as a JSON array
//    Example: [123,45,67,89...] (the secret key from your Solana wallet)
//    You can get this from your wallet export or Phantom wallet's "Export Private Key"
//
// 2. DISCORD_WEBHOOK_AUTO_TRADE: Discord webhook URL for trade notifications
//    Example: https://discord.com/api/webhooks/YOUR_WEBHOOK_URL
//
// 3. Optional safety limits:
//    - MAX_SOL_AT_RISK=1.0 (maximum SOL that can be at risk across all trades)
//    - MIN_SOL_BALANCE=0.1 (minimum SOL balance to maintain)
//
// To activate real trading for new tokens, use the PUT endpoint:
// PUT /api/trending/track?key=YOUR_SECRET_KEY
// Body: { "isSimulated": false }
//
// The system will then show "🔥 LIVE TRADING" in Discord notifications instead of "💻 SIMULATION"
// ====================================================================================================

export const PUT = withUnifiedLogging(async (request: NextRequest, logger) => {
  try {
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'
    const testDiscord = searchParams.get('test') === 'discord'
    const testFilter = searchParams.get('test') === 'filter'

    if (secretKey !== expectedSecretKey) {
      logger.warn('api_request', 'Unauthorized attempt to change trading mode', {
        ip: request.headers.get('x-forwarded-for') ||
          request.headers.get('x-real-ip') ||
          'unknown',
      })
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (testFilter) {
      try {
        console.log('Track Filter Test: Starting enhanced filtering test...')

        // Fetch trending tokens from Jupiter API (same logic as main tracking)
        const JUPITER_TRENDING_URLS = [
          'https://datapi.jup.ag/v1/pools/toptrending/1h',
        ]

        let response: Response | null = null

        for (const url of JUPITER_TRENDING_URLS) {
          try {
            console.log(`Fetching trending tokens from: ${url}`)
            response = await fetch(url, {
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'ReloadSol-TrendingTracker/1.0'
              },
              next: { revalidate: 0 }
            })

            if (response.ok) {
              console.log(`✅ Successfully fetched from ${url}`)
              break
            }

            if (response.status === 429) {
              console.log(`⏳ Rate limited on ${url}, waiting 500ms...`)
              await new Promise(res => setTimeout(res, 500))
              continue
            }

            throw new Error(`Jupiter API responded with status: ${response.status}`)
          } catch (err) {
            console.error(`Error fetching trending tokens from ${url}:`, err)
          }
        }

        if (!response || !response.ok) {
          throw new Error('All Jupiter trending API endpoints failed')
        }

        const data = await response.json() as JupiterResponse
        console.log(`Track Filter Test: Fetched ${data.pools.length} pools from Jupiter API`)

        // Perform enhanced filtering
        const currentStrategy = getCurrentBotStrategySync()
        const customFilterConfig = parseCustomFilterConfig()
        const { results: filterResults, summary: filteringSummary } = await performEnhancedFiltering(
          data.pools,
          currentStrategy,
          customFilterConfig || {}
        )

        // Extract accepted tokens
        const acceptedTokens = filterResults
          .filter(result => result.passed)
          .map(result => ({
            address: result.token.baseAsset.id,
            symbol: result.token.baseAsset.symbol,
            name: result.token.baseAsset.name,
            marketCap: result.token.baseAsset.mcap,
            volume1h: result.token.baseAsset.stats1h?.buyVolume || 0,
            organicScore: result.token.baseAsset.organicScore,
            currentPrice: result.token.baseAsset.usdPrice,
            priceChange1h: result.token.baseAsset.stats1h?.priceChange || 0,
            priceChange5m: result.token.baseAsset.stats5m?.priceChange || 0,
            priceChange6h: result.token.baseAsset.stats6h?.priceChange || 0
          }))

        // Extract rejected tokens with their rejection reasons
        const rejectedTokens = filterResults
          .filter(result => !result.passed)
          .map(result => ({
            address: result.token.baseAsset.id,
            symbol: result.token.baseAsset.symbol,
            name: result.token.baseAsset.name,
            marketCap: result.token.baseAsset.mcap,
            volume1h: result.token.baseAsset.stats1h?.buyVolume || 0,
            organicScore: result.token.baseAsset.organicScore,
            currentPrice: result.token.baseAsset.usdPrice,
            priceChange1h: result.token.baseAsset.stats1h?.priceChange || 0,
            priceChange5m: result.token.baseAsset.stats5m?.priceChange || 0,
            priceChange6h: result.token.baseAsset.stats6h?.priceChange || 0,
            rejectionReasons: result.rejectionReasons
          }))

        const summary = {
          totalTokens: data.pools.length,
          acceptedCount: acceptedTokens.length,
          rejectedCount: rejectedTokens.length,
          acceptanceRate: `${((acceptedTokens.length / data.pools.length) * 100).toFixed(1)}%`,
          processingTime: filteringSummary.processingTime
        }

        console.log('Track Filter Test: Filtering completed successfully', summary)

        return NextResponse.json({
          success: true,
          message: 'Track filter test completed successfully',
          summary,
          acceptedTokens,
          rejectedTokens,
          rejectionDetails: filteringSummary.rejectionDetails
        })

      } catch (error) {
        console.error('Track Filter Test: Error during filtering test', error)
        return NextResponse.json({
          success: false,
          message: 'Track filter test failed',
          error: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 })
      }
    }

    // Handle Discord testing
    if (testDiscord) {
      // Check Discord configuration
      const discordEnabled = shouldEnableNotifications()
      const webhookUrl = DISCORD_WEBHOOK_URL

      console.log('Track Discord Configuration Test:', {
        discordEnabled,
        webhookConfigured: !!webhookUrl,
        webhookUrl: webhookUrl ? `${webhookUrl.substring(0, 50)}...` : 'Not configured',
        env: {
          DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
          DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
          ENABLE_DISCORD_NOTIFICATIONS: process.env.ENABLE_DISCORD_NOTIFICATIONS
        }
      })

      // Test different types of Discord notifications
      const testResults = []

      // Test 1: New Token Detection
      try {
        console.log('Testing new token detection notification...')
        await sendNewTokenDetectionDiscord({
          tokenAddress: 'TESTDISCORD1234567890',
          tokenSymbol: 'DTEST',
          tokenName: 'Discord Test Token',
          currentPrice: 0.000123,
          marketCap: 500000,
          organicScore: 85.5,
          volume1h: 25000,
          isRealTrading: false
        })
        testResults.push({ type: 'new_token_detection', success: true })
        console.log('New token detection test: SUCCESS')
      } catch (error) {
        testResults.push({
          type: 'new_token_detection',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
        console.error('New token detection test: FAILED', error)
      }

      // Test 2: Buy Notification
      try {
        console.log('Testing buy notification...')
        await sendBuyNotificationDiscord({
          tokenSymbol: 'DTEST',
          tokenAddress: 'TESTDISCORD1234567890',
          isSimulated: true,
          amountSOL: 0.1,
          tokensReceived: '1000000',
          priceUSD: 0.000123,
          provider: 'jupiter',
          rpcUsed: 'test-rpc',
          responseTime: 150,
          totalFees: 0.001,
          marketCap: 50000,
          riskAssessment: {
            riskLevel: 'LOW',
            assessmentMethod: 'basic'
          },
          graduatedAt: '2025-01-10T12:56:39Z'
        })
        testResults.push({ type: 'buy_notification', success: true })
        console.log('Buy notification test: SUCCESS')
      } catch (error) {
        testResults.push({
          type: 'buy_notification',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
        console.error('Buy notification test: FAILED', error)
      }

      // Test 3: Trade Alert
      try {
        console.log('Testing trade alert notification...')
        await sendTradeAlertDiscord({
          tokenSymbol: 'TEST',
          status: 'buy' as any,
          isSimulated: true,
          currentGain: 15.5,
          peakGain: 20.2,
          priceUsd: 0.000145,
          provider: 'jupiter',
          rpcUsed: 'test-rpc',
          responseTime: 200
        })
        testResults.push({ type: 'trade_alert', success: true })
        console.log('Trade alert test: SUCCESS')
      } catch (error) {
        testResults.push({
          type: 'trade_alert',
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
        console.error('Trade alert test: FAILED', error)
      }

      const successCount = testResults.filter(r => r.success).length
      const totalTests = testResults.length

      return NextResponse.json({
        success: true,
        message: 'Track Discord configuration test completed',
        discord: {
          enabled: discordEnabled,
          webhookConfigured: !!webhookUrl,
          testResults,
          summary: `${successCount}/${totalTests} tests passed`
        },
        environment: {
          NODE_ENV: process.env.NODE_ENV,
          DISCORD_WEBHOOK_AUTO_TRADE: !!process.env.DISCORD_WEBHOOK_AUTO_TRADE,
          DISCORD_WEBHOOK_URL: !!process.env.DISCORD_WEBHOOK_URL,
          ENABLE_DISCORD_NOTIFICATIONS: process.env.ENABLE_DISCORD_NOTIFICATIONS
        }
      })
    }

    const body = await request.json()
    const { isSimulated, keypairPath } = body

    if (typeof isSimulated !== 'boolean') {
      logger.warn('api_request', 'Invalid body for trading mode change', { body })
      return NextResponse.json({ error: 'isSimulated must be a boolean' }, { status: 400 })
    }

    if (!isSimulated && !keypairPath && !process.env.TRADING_KEYPAIR_JSON) {
      logger.error('api_request', 'Trading keypair not configured for real mode')
      return NextResponse.json({ error: 'Trading keypair not configured. Provide keypairPath or set TRADING_KEYPAIR_JSON' }, { status: 400 })
    }

    await setTradingMode(isSimulated, keypairPath)
    logger.info('api_request', `Trading mode changed to ${isSimulated ? 'simulated' : 'real'}`)

    // Send Discord notification about trading mode change
    if (shouldEnableNotifications()) {
      try {
        const mode = isSimulated ? 'SIMULATION' : 'LIVE TRADING'
        const emoji = isSimulated ? '💻' : '🔥'
        const content = [
          `${emoji} Trading Mode Changed`,
          `Mode: ${mode}`,
          `Keypair: ${keypairPath || 'Not specified'}`,
          `Time: ${formatAppDateTime(new Date())}`,
          `Status: Successfully activated`
        ].join('\n')

        await fetch(DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content })
        })

        logger.info('discord_notification', 'Discord notification sent for trading mode change')
      } catch (discordError) {
        logger.error('discord_notification', 'Failed to send Discord notification for trading mode change', discordError as Error)
        // Don't fail the operation if Discord fails
      }
    }

    return NextResponse.json({
      success: true,
      mode: isSimulated ? 'simulated' : 'real',
      message: `Successfully switched to ${isSimulated ? 'simulated' : 'real'} trading mode`
    })

  } catch (error) {
    logger.critical('api_request', 'Error in PUT /api/trending/track', error as Error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
})


export const POST = withUnifiedLogging(async (request: NextRequest, logger) => {
  try {
    logger.info('api_request', 'Starting trending token tracking...')

    // Run wallet diagnostics to help troubleshoot balance issues
    await diagnoseTradingWallet()

    return await internalTrackPost(request, logger)
  } catch (error) {
    logger.critical('api_request', 'Error in POST handler', error as Error)
    return NextResponse.json({
      error: 'Failed to process tracking request',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
})

export const GET = withUnifiedLogging(async (request: NextRequest, logger) => {
  try {
    const { searchParams } = new URL(request.url)
    const tokenAddress = searchParams.get('token')

    if (!tokenAddress) {
      logger.warn('api_request', 'Token address missing from request')
      return NextResponse.json({ error: 'Token address is required', example: '/api/trending/track?token=TOKEN_ADDRESS' }, { status: 400 })
    }

    logger.info('api_request', 'Fetching token tracking data', { tokenAddress })

    // Get token data with trade comparison
    const token = await queryOne<Record<string, unknown>>(
      `SELECT * FROM ${TRACKER_TABLE} WHERE token_address = $1 LIMIT 1`,
      [tokenAddress],
    )

    if (!token) {
      logger.warn('api_request', 'Tracked token not found', { tokenAddress })
      return NextResponse.json({ error: 'Token not found', token_address: tokenAddress }, { status: 404 })
    }

    logger.info('api_request', 'Successfully retrieved tracked token', { tokenAddress, status: token.status })

    return NextResponse.json({
      success: true,
      token: {
        id: token.id,
        token_address: token.token_address,
        token_symbol: token.token_symbol,
        token_name: token.token_name,
        logo_url: token.logo_url,
        initial_price_usd: token.initial_price_usd,
        last_price_usd: token.last_price_usd,
        peak_price_usd: token.peak_price_usd,
        current_gain_percentage: token.current_gain_percentage,
        peak_gain_percentage: token.peak_gain_percentage,
        status: token.status,
        organic_score: token.organic_score,
        market_cap: token.market_cap,
        volume_1h: token.volume_1h,
        tracking_started_at: token.tracking_started_at,
        status_changed_at: token.status_changed_at,
        trade_comparison_data: token.trade_comparison_data,
        trading_simulation: token.trading_simulation,
        price_history: token.price_history || []
      },
      timestamp: new Date().toISOString()
    })

  } catch (error) {
    logger.error('api_request', 'Error retrieving token trade comparison', error as Error)
    return NextResponse.json({
      error: 'Failed to retrieve token trade comparison',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }, { status: 500 })
  }
})
