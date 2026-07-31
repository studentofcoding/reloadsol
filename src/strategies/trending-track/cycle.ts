// Orchestrating 5-minute trending track cycle extracted from
// src/app/api/trending/track/route.ts (REL-19). REL-20 batched writes
// (WriteBatch/flushBatch inside Promise.allSettled accounting) are preserved
// verbatim — this is a pure code move.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { query, queryOne, bulkInsert, bulkUpdateByKey, WriteBatch, type BulkWriteStats } from '@/utils/db'
import { log, logTradeOperation } from '@/utils/unified-logger'
import {
  shouldEnableNotifications,
  sendNewTokenDetectionDiscord,
  sendTradeAlertDiscord,
} from '@/utils/discord'
import { addSLTPPosition } from '@/utils/sl-tp-tracker'
import { fetchTokenPricesForTracking } from '@/utils/trading-tracker'
import { assessTokenRisk } from '@/utils/risk-assessment'
import { calculateGainPercentage } from '@/utils/trading-math'
import { trendingListDiscordViaCronOnly } from '@/utils/trending-notification-dedup'
import { formatAppDateTime } from '@/utils/datetime'
import type { JupiterResponse } from '@/types'
import { assignTokenToStrategy } from '@/strategies/assign'
import { tokenMatchesTrendingBotStrategy } from '@/strategies/strategy-filters'
import {
  refreshTrackStrategyCache,
  resolveTradingStrategy,
  getActiveStrategiesSync,
  getTrackStrategyRegistry,
  getStrategyStatusSummary,
  getUnionFilterForActiveStrategies,
} from '@/strategies/load-strategy'
import { runTrendingBotRhSimCycle } from '@/strategies/trending-bot-rh-sim'
import { resolveTrendingSimMode } from '@/utils/trending-execution-mode'
import { TRACKER_TABLE, DISCORD_WEBHOOK_URL, DEBUG_LOG } from './constants'
import {
  initializeStrategyTracking,
  activeTrades,
  activeTradesByStrategy,
  tradingKeypair,
} from './state'
import { performEnhancedFiltering, parseCustomFilterConfig } from './filtering'
import {
  sendFilteringSummaryDiscord,
  sendRejectedTokensDiscord,
  sendSkippedTokenDiscord,
  getNotificationStatus,
} from './discord'
import { checkForManualPositionsAndSL } from './manual-positions'
import { performEnhancedDuplicateCheck } from './wallet'
import { createTradingSimulation, calculatePeakPrice } from './mappers'
import { attachBuyEntryFeatures } from './entry-features'
import {
  executeBuyOperationWithStrategy,
  performSellOperation,
  shouldSellToken,
} from './trade-ops'
import { isWithinTradingHours } from './schedule'
import type { TrackedToken, TradingSimulation, PriceRecord, PriceTracking } from './types'

export async function internalTrackPost(request: NextRequest, logger: any) {
  const requestStartTime = Date.now()
  const requestId = Math.random().toString(36).substring(7)

  const { acquireJobLock, releaseJobLock } = await import('@/utils/bot-job-lock')
  const jobLock = await acquireJobLock('trending_track', 600)
  if (!jobLock.acquired) {
    console.log(`⏭️ Skipping track cycle: ${jobLock.reason}`)
    return NextResponse.json(
      { success: false, skipped: true, reason: jobLock.reason },
      { status: 409 },
    )
  }

  try {
    await refreshTrackStrategyCache()

    // Validate authentication (server-side only)
    const { searchParams } = new URL(request.url)
    const secretKey = searchParams.get('key')
    const expectedSecretKey = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'

    // Allow calls from:
    // 1. Vercel cron jobs (internal calls)
    // 2. Localhost in development (no secret needed)
    // 3. Valid secret key (manual/external calls)
    const isDevelopment = process.env.NODE_ENV === 'development'
    const isLocalhost = request.headers.get('host')?.includes('localhost') || request.headers.get('host')?.includes('127.0.0.1')

    if (isDevelopment && isLocalhost && !secretKey) {
      console.log('🔓 Development mode: allowing combined tracking+summary API call without secret key')
    } else if (secretKey !== expectedSecretKey) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Robinhood twin runs on GMGN market rank; a failure there must not stop Solana.
    try {
      await runTrendingBotRhSimCycle()
    } catch (rhError) {
      logger.error('api_request', 'Robinhood trending sim cycle failed', rhError as Error)
    }

    // Log incoming request
    logger.info('api_request', 'Tracking Request Started', {
      userAgent: request.headers.get('user-agent'),
      source: request.headers.get('user-agent')?.includes('reloadsol-cron-service') ? 'cron' : 'browser'
    })

    // Log strategy status at startup
    const strategyStatus = await getStrategyStatusSummary()
    console.log(`🎯 Strategy Status Summary:`)
    console.log(`  ✅ Active (${strategyStatus.is_active.length}): ${strategyStatus.is_active.join(', ') || 'none'}`)
    console.log(`  ❌ Inactive (${strategyStatus.is_inactive.length}): ${strategyStatus.is_inactive.join(', ') || 'none'}`)
    console.log(`  📊 Total: ${strategyStatus.total} strategies`)

    // Get active strategies with their configurations
    const { strategies: activeStrategies, configs: activeConfigs, allocation } = getActiveStrategiesSync()

    if (activeStrategies.length === 0) {
      console.warn('⏭️ No active strategies available for trading — skipping track cycle')
      return NextResponse.json(
        {
          success: false,
          skipped: true,
          reason: 'No active strategies available for trading',
        },
        { status: 200 },
      )
    }

    console.log(`🚀 Starting trading cycle with ${activeStrategies.length} active strategies`)

    // Check trading hours restriction
    const timeCheck = isWithinTradingHours()
    if (!timeCheck.allowed) {
      console.log(`⏰ ${timeCheck.reason}`)

      // Send Discord notification about time restriction
      if (shouldEnableNotifications()) {
        try {
          const content = [
            `⏰ Trading Request Rejected - Outside Trading Hours`,
            ``,
            `Current Time: ${timeCheck.currentTime}`,
            `Trading Hours: 16:00 - 04:00 GMT+7`,
            `Reason: ${timeCheck.reason}`,
            ``,
            `⏰ ${formatAppDateTime(new Date())}`
          ].join('\n')

          await fetch(DISCORD_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
          })

          logger.info('discord_notification', 'Discord notification sent for time restriction')
        } catch (discordError) {
          logger.error('discord_notification', 'Failed to send Discord notification for time restriction', discordError as Error)
        }
      }

      return NextResponse.json({
        error: 'Trading not allowed at this time',
        message: timeCheck.reason,
        currentTime: timeCheck.currentTime,
        tradingHours: '16:00 - 04:00 GMT+7',
        timestamp: new Date().toISOString()
      }, { status: 403 })
    }

    console.log(`✅ Trading allowed at ${timeCheck.currentTime}`)

    console.log('🔍 Starting 5-minute trending token tracking...')

    // Fetch current trending tokens from Jupiter API with fallback & retry
    const TRENDING_URLS = [
      'https://datapi.jup.ag/v1/pools/toptrending/1h',
      'https://api.jup.ag/v1/pools/toptrending/1h',
    ]

    let response: Response | null = null

    for (const url of TRENDING_URLS) {
      try {
        response = await fetch(url, {
          headers: {
            accept: 'application/json',
            'cache-control': 'no-cache',
            'user-agent': 'reloadsol-bot/1.0 (+https://reloadsol.xyz)'
          }
        })

        if (response.ok) break

        if (response.status === 403 || response.status === 429) {
          console.warn(`Trending track API ${url} responded with ${response.status}. Retrying next mirror...`)
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

    if (!Array.isArray(data?.pools)) {
      throw new Error('Invalid Jupiter trending response: missing pools array')
    }

    // Enhanced filtering with comprehensive tracking
    console.log(`🔍 Starting enhanced token filtering for ${data.pools.length} tokens...`)
    const customFilterConfig = parseCustomFilterConfig()
    const { filterConfig: unionFilter } = await getUnionFilterForActiveStrategies()

    const effectiveFilter =
      customFilterConfig && Object.keys(customFilterConfig).length > 0
        ? { ...unionFilter, ...customFilterConfig }
        : unionFilter

    console.log(`🎯 Active strategies: ${activeStrategies.join(', ')}`)
    console.log(`🔧 Union pre-filter config:`, effectiveFilter)

    const { results: filterResults, summary: filteringSummary } =
      await performEnhancedFiltering(data.pools, undefined, effectiveFilter)

    // Extract accepted tokens
    const filteredTokens = filterResults
      .filter(result => result.passed)
      .map(result => result.mappedToken)

    // Extract rejected tokens
    const rejectedTokens = filterResults.filter(result => !result.passed)

    console.log(`📊 Filtering complete: ${filteringSummary.acceptedTokens} accepted, ${filteringSummary.rejectedTokens} rejected`)

    // Determine if real trading is enabled
    const hasKeypair = !!process.env.TRADING_KEYPAIR_JSON
    const hasWebhook = !!process.env.DISCORD_WEBHOOK_AUTO_TRADE
    const isRealTrading = hasKeypair && hasWebhook

    try {
      if (trendingListDiscordViaCronOnly()) {
        log.info('discord_notification', 'Skipping track filtering Discord — list alerts owned by cron workers')
      } else {
      log.info('discord_notification', 'Starting Discord filtering notifications', {
        totalTokens: filteringSummary.totalTokens,
        acceptedTokens: filteringSummary.acceptedTokens,
        rejectedTokens: filteringSummary.rejectedTokens,
        rejectedTokensArrayLength: rejectedTokens.length,
        isRealTrading
      })

      // Send filtering summary
      log.debug('discord_notification', 'Calling sendFilteringSummaryDiscord')
      await sendFilteringSummaryDiscord(filteringSummary, isRealTrading)
      log.info('discord_notification', 'sendFilteringSummaryDiscord completed successfully')

      // Send rejected tokens details (if any)
      if (rejectedTokens.length > 0) {
        log.debug('discord_notification', 'Calling sendRejectedTokensDiscord')
        await sendRejectedTokensDiscord(rejectedTokens, isRealTrading)
        log.info('discord_notification', 'sendRejectedTokensDiscord completed successfully')
      } else {
        log.warn('discord_notification', 'No rejected tokens to send Discord notification for')
      }

      log.info('discord_notification', 'All Discord filtering notifications completed successfully')
      }
    } catch (discordError) {
      log.error('discord_notification', 'Error sending Discord filtering notifications', discordError as Error, {
        message: discordError instanceof Error ? discordError.message : String(discordError),
        stack: discordError instanceof Error ? discordError.stack : undefined
      })
      // Continue processing even if Discord notifications fail
    }

    // Get currently tracked and waiting tokens
    const { rows: trackedTokens } = await query<TrackedToken>(
      `SELECT id, token_address, token_symbol, token_name, logo_url,
              initial_price_usd, last_price_usd, peak_price_usd,
              current_gain_percentage, peak_gain_percentage, status,
              organic_score, market_cap, volume_1h,
              tracking_started_at, updated_at,
              trading_simulation, price_history,
              waiting_started_at, waiting_initial_price, volume_5m, status_changed_at, created_at
       FROM ${TRACKER_TABLE}
       WHERE status = ANY($1::text[])`,
      [['tracking', 'waiting']],
    )

    // Check for manual sells before processing new tokens
    if (trackedTokens && trackedTokens.length > 0) {
      try {
        // await checkForManualSells(trackedTokens as TrackedToken[])
        await checkForManualPositionsAndSL(trackedTokens as TrackedToken[])
      } catch (error) {
        console.error('❌ Error checking for manual sells:', error)
        // Continue processing even if manual sell detection fails
      }
    }

    const trackedTokensMap = new Map<string, TrackedToken>()
    trackedTokens?.forEach(token => {
      trackedTokensMap.set(token.token_address, token as TrackedToken)
    })

    let newTokensAdded = 0
    let tokensUpdated = 0
    let tokensLost = 0
    let updatesPromises: Promise<any>[] = []

    // ------------------------------------------------------------------
    // REL-20: batched tracker-table writes. Rows are collected during the
    // per-token loop and flushed as single UNNEST statements afterwards,
    // replacing one round-trip per token. Conditions per token are
    // unchanged — rows are only collected where the old code awaited a
    // write.
    // ------------------------------------------------------------------
    const rel20Stats: { name: string; stats: BulkWriteStats; ok: boolean }[] = []

    const upsertErrorHooks = (token: any, existingAnyStatus: unknown) => ({
      onError: (err: unknown) => {
        const pgErr = err as { code?: string; message?: string }
        logTradeOperation('Database Upsert Error', {
          tokenSymbol: token.token_symbol,
          tokenAddress: token.token_address,
          errorCode: pgErr.code,
          errorMessage: pgErr.message,
          isRestart: !!existingAnyStatus
        }, err instanceof Error ? err : new Error(String(err)))
        console.error(`❌ Failed to upsert token ${token.token_symbol}:`, err)
      },
    })

    const flushBatch = (batch: WriteBatch) =>
      batch.flush().then(({ stats, ok }) => {
        rel20Stats.push({ name: batch.name, stats, ok })
        return ok
          ? { success: true, tokenSymbol: batch.name }
          : { success: false, error: 'batch flush failed', tokenSymbol: batch.name }
      })

    const cText = (name: string) => ({ name, type: 'text' })
    const cFloat = (name: string) => ({ name, type: 'float8' })
    const cJsonb = (name: string) => ({ name, type: 'jsonb' })
    const cTs = (name: string) => ({ name, type: 'timestamptz' })

    // INSERT ... ON CONFLICT (token_address) upserts. Values are deduped by
    // token_address (last wins) inside the statement because one INSERT cannot
    // upsert the same key twice; hooks still fire per collected row, matching
    // the old per-row upsert behavior.
    const makeUpsertBatch = (
      name: string,
      columns: { name: string; type: string }[],
    ) =>
      new WriteBatch(name, (rows) => {
        const deduped = new Map<string, unknown[]>()
        for (const r of rows) deduped.set(r[1] as string, r)
        return bulkInsert({
          table: TRACKER_TABLE,
          columns,
          rows: [...deduped.values()],
          conflictTarget: '(token_address)',
          updateColumns: columns.map((c) => c.name).filter((c) => c !== 'token_address'),
          extraSet: ['updated_at = NOW()'],
        })
      })

    const waitingUpsert = makeUpsertBatch('waiting-upsert', [
      cText('id'), cText('token_address'), cText('token_symbol'), cText('token_name'), cText('logo_url'),
      cFloat('initial_price_usd'), cFloat('last_price_usd'), cFloat('peak_price_usd'),
      cFloat('current_gain_percentage'), cFloat('peak_gain_percentage'), cText('status'),
      cFloat('organic_score'), cFloat('market_cap'), cFloat('volume_1h'), cTs('tracking_started_at'),
      cJsonb('trading_simulation'), cJsonb('price_history'), cTs('waiting_started_at'), cFloat('waiting_initial_price'),
    ])

    const trackingUpsert = makeUpsertBatch('tracking-upsert', [
      cText('id'), cText('token_address'), cText('token_symbol'), cText('token_name'), cText('logo_url'),
      cFloat('initial_price_usd'), cFloat('last_price_usd'), cFloat('peak_price_usd'),
      cFloat('current_gain_percentage'), cFloat('peak_gain_percentage'), cText('status'),
      cFloat('organic_score'), cFloat('market_cap'), cFloat('volume_1h'), cTs('tracking_started_at'),
      cJsonb('trading_simulation'), cJsonb('price_history'),
    ])

    const makeUpdateBatch = (
      name: string,
      columns: { name: string; type: string }[],
    ) =>
      new WriteBatch(name, (rows) =>
        bulkUpdateByKey({
          table: TRACKER_TABLE,
          key: cText('id'),
          columns,
          rows,
          extraSet: ['updated_at = NOW()'],
        }),
      )

    // waiting → skipped on 1h timeout (initial and peak both reset to waiting initial)
    const waitingTimeoutUpdate = makeUpdateBatch('waiting-timeout-update', [
      cText('status'), cTs('status_changed_at'), cFloat('last_price_usd'),
      cFloat('initial_price_usd'), cFloat('peak_price_usd'),
      cFloat('current_gain_percentage'), cFloat('peak_gain_percentage'),
    ])

    // waiting → tracking conversion after 15% dip buy
    const dipConvertUpdate = makeUpdateBatch('dip-convert-update', [
      cText('status'), cTs('status_changed_at'), cFloat('initial_price_usd'),
      cFloat('last_price_usd'), cFloat('peak_price_usd'),
      cFloat('current_gain_percentage'), cFloat('peak_gain_percentage'),
      cJsonb('trading_simulation'),
    ])

    // waiting price-only touch (failed dip buy / conversion error)
    const waitingPriceTouch = makeUpdateBatch('waiting-price-touch', [
      cFloat('last_price_usd'),
    ])

    // still-waiting price/metrics update
    const waitingMetricsUpdate = makeUpdateBatch('waiting-metrics-update', [
      cFloat('last_price_usd'), cFloat('organic_score'), cFloat('market_cap'), cFloat('volume_1h'),
    ])

    // stale / too-old → stopped
    const stoppedUpdate = makeUpdateBatch('stopped-update', [
      cText('status'), cTs('status_changed_at'), cFloat('last_price_usd'),
      cFloat('current_gain_percentage'), cFloat('peak_gain_percentage'),
      cFloat('organic_score'), cFloat('market_cap'), cFloat('volume_1h'),
    ])

    // main-loop terminal/periodic update (lost + tracking share one shape)
    const trackingStateUpdate = makeUpdateBatch('tracking-state-update', [
      cFloat('last_price_usd'), cFloat('peak_price_usd'), cFloat('current_gain_percentage'),
      cFloat('peak_gain_percentage'), cText('status'), cTs('status_changed_at'),
      cFloat('organic_score'), cFloat('market_cap'), cFloat('volume_1h'),
      cJsonb('trading_simulation'), cJsonb('price_history'),
    ])

    // orphaned token lost update
    const orphanLostUpdate = makeUpdateBatch('orphan-lost-update', [
      cFloat('last_price_usd'), cFloat('peak_price_usd'), cFloat('current_gain_percentage'),
      cFloat('peak_gain_percentage'), cText('status'), cTs('status_changed_at'),
      cJsonb('trading_simulation'), cJsonb('price_history'),
    ])

    // orphaned token periodic update
    const orphanUpdate = makeUpdateBatch('orphan-update', [
      cFloat('last_price_usd'), cFloat('peak_price_usd'), cFloat('current_gain_percentage'),
      cFloat('peak_gain_percentage'), cJsonb('trading_simulation'), cJsonb('price_history'),
    ])

    // at the top of POST handler, just after you fetch `trackedTokens`
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const purgeIds = trackedTokens
      ?.filter(t => t.status !== 'tracking' && new Date(t.updated_at) < cutoff24h)
      .map(t => t.id)

    if (purgeIds?.length) {
      await query(`DELETE FROM ${TRACKER_TABLE} WHERE id = ANY($1::text[])`, [purgeIds])
    }

    // Assign strategies to filtered tokens
    console.log(`🎯 Assigning strategies to ${filteredTokens.length} filtered tokens...`)

    // Use the already fetched active strategies from startup
    initializeStrategyTracking(activeStrategies)

    // Group tokens by assigned strategy
    const tokensByStrategy = new Map<string, any[]>()
    activeStrategies.forEach(strategyId => tokensByStrategy.set(strategyId, []))

    // Process each trending token
    for (const token of filteredTokens) {
      const existingToken = trackedTokensMap.get(token.token_address)

      if (!existingToken) {
        // Check if token exists in database with ANY status (not just tracking)
        const existingAnyStatus = await queryOne<TrackedToken>(
          `SELECT * FROM ${TRACKER_TABLE}
           WHERE token_address = $1 AND token_symbol = $2
           LIMIT 1`,
          [token.token_address, token.token_symbol],
        )

        if (existingAnyStatus) {
          // Enhanced logging with detailed token information
          const timeSinceTracking = existingAnyStatus.tracking_started_at
            ? Math.round((Date.now() - new Date(existingAnyStatus.tracking_started_at).getTime()) / (1000 * 60 * 60 * 24) * 100) / 100
            : 'Unknown'

          const timeSinceStatusChange = existingAnyStatus.status_changed_at
            ? Math.round((Date.now() - new Date(existingAnyStatus.status_changed_at).getTime()) / (1000 * 60 * 60 * 24) * 100) / 100
            : 'N/A'

          const lastUpdateTime = existingAnyStatus.updated_at
            ? Math.round((Date.now() - new Date(existingAnyStatus.updated_at).getTime()) / (1000 * 60)) / 100
            : 'Unknown'

          const { strategies: activeStrategies } = getActiveStrategiesSync()
          const strategyInfo = activeStrategies.length > 0 ? `[Strategies: ${activeStrategies.join(', ')}]` : '[No active strategies]'
          console.warn(`⏭️ Token ${token.token_symbol}, from strategy:${strategyInfo} already exists in database. Skipping duplicate`)
          console.log(`📊 ${token.token_symbol} Details:`, {
            status: existingAnyStatus.status,
            initial_price: `$${existingAnyStatus.initial_price_usd?.toFixed(6) || 'N/A'}`,
            last_price: `$${existingAnyStatus.last_price_usd?.toFixed(6) || 'N/A'}`,
            peak_price: `$${existingAnyStatus.peak_price_usd?.toFixed(6) || 'N/A'}`,
            current_pnl: `${existingAnyStatus.current_gain_percentage?.toFixed(2) || '0.00'}%`,
            peak_pnl: `${existingAnyStatus.peak_gain_percentage?.toFixed(2) || '0.00'}%`,
            tracking_started: `${timeSinceTracking} days ago`,
            status_changed: existingAnyStatus.status_changed_at ? `${timeSinceStatusChange} days ago` : 'Never',
            last_updated: `${lastUpdateTime} minutes ago`,
            current_vs_peak: existingAnyStatus.peak_price_usd && existingAnyStatus.last_price_usd
              ? `${((existingAnyStatus.last_price_usd / existingAnyStatus.peak_price_usd - 1) * 100).toFixed(2)}%`
              : 'N/A'
          })

          // Send Discord notification for skipped token
          await sendSkippedTokenDiscord({
            tokenSymbol: token.token_symbol,
            tokenAddress: token.token_address,
            currentPriceAPI: token.current_price,
            existingTokenData: {
              status: existingAnyStatus.status,
              initial_price_usd: existingAnyStatus.initial_price_usd,
              last_price_usd: existingAnyStatus.last_price_usd,
              peak_price_usd: existingAnyStatus.peak_price_usd,
              current_gain_percentage: existingAnyStatus.current_gain_percentage,
              peak_gain_percentage: existingAnyStatus.peak_gain_percentage,
              tracking_started_at: existingAnyStatus.tracking_started_at,
              status_changed_at: existingAnyStatus.status_changed_at,
              updated_at: existingAnyStatus.updated_at
            }
          })

          continue
        }

        // Enhanced duplicate check before starting new token tracking
        const duplicateCheck = await performEnhancedDuplicateCheck(token.token_address, token.token_symbol, token.current_price)
        if (!duplicateCheck.canPurchase) {
          console.warn(`🚫 Skipping ${token.token_symbol} due to duplicate prevention: ${duplicateCheck.reason}`)
          continue
        }

        // Log if this is a re-buy scenario
        if (duplicateCheck.isRebuy) {
          console.log(`🔄 Re-buy scenario detected for ${token.token_symbol} - will use ${(duplicateCheck.rebuyMultiplier! * 100)}% of normal buy amount`)
        }

        // Check if token has pumped more than 120% in the last hour
        const hourlyPumpPercentage = (token.change_1h || 0) * 100
        const shouldWaitForDip = hourlyPumpPercentage > 120

        if (shouldWaitForDip) {
          console.log(`🚀 Token ${token.token_symbol} pumped ${hourlyPumpPercentage.toFixed(1)}% - adding to waiting queue`)
        } else {
          console.log(`📈 Token ${token.token_symbol} change ${hourlyPumpPercentage.toFixed(1)}% - proceeding with immediate tracking`)
        }

        if (shouldWaitForDip) {
          // Route highly pumped tokens to waiting system
          const tokenId = (existingAnyStatus as any)?.id || `wait_${token.token_address}_${Date.now()}`

          // Create initial price history record
          const initialPriceRecord: PriceRecord = {
            timestamp: new Date().toISOString(),
            price_usd: token.current_price,
            volume_5m: token.volume_5m ?? null,
            market_cap: token.market_cap ?? null,
          }

          const currentTime = new Date().toISOString()

          // REL-20: collected and flushed as one UNNEST upsert after the loop
          waitingUpsert.add(
            [
              tokenId,
              token.token_address,
              token.token_symbol,
              token.token_name,
              token.logo_url,
              token.current_price,
              token.current_price,
              0,
              0,
              0,
              'waiting',
              token.organic_score,
              token.market_cap,
              token.volume_1h,
              currentTime,
              null,
              JSON.stringify([initialPriceRecord]),
              currentTime,
              token.current_price,
            ],
            upsertErrorHooks(token, existingAnyStatus),
          )

          newTokensAdded++
          console.log(`⏳ Adding pumped token to waiting queue: ${token.token_symbol} (${token.token_address}) - waiting for 15% dip`)

        } else {
          // Proceed with immediate buy and tracking for tokens that haven't pumped excessively
          const tokenId = (existingAnyStatus as any)?.id || `track_${token.token_address}_${Date.now()}`

          // Perform buy operation for new tokens (simulation or real trading)
          let tradingSimulation: TradingSimulation | null = null
          try {
            // Check if real trading mode is activated - improved logic
            let isRealTradingActive = false
            let keypairPath: string | undefined = undefined

            // First, check if TRADING_KEYPAIR_JSON environment variable is set
            const hasEnvKeypair = !!process.env.TRADING_KEYPAIR_JSON
            console.log(`🔑 Keypair detection for ${token.token_symbol}:`)
            console.log(`  - TRADING_KEYPAIR_JSON env var: ${hasEnvKeypair ? 'SET' : 'NOT SET'}`)

            // Check if any existing tracked token has real trading enabled
            const existingRealTradeTokens = trackedTokens?.filter(t =>
              t.trading_simulation && !t.trading_simulation.is_simulated
            ) || []

            console.log(`  - Existing real trade tokens found: ${existingRealTradeTokens.length}`)

            // Find a token with both real trading AND a valid keypair_path
            const validRealTradeToken = existingRealTradeTokens.find(t =>
              t.trading_simulation?.keypair_path
            )

            if (validRealTradeToken?.trading_simulation) {
              console.log(`  - Valid existing token with keypair found: ${validRealTradeToken.token_symbol}`)
            }

            // Determine trading mode and keypair path with better validation
            if (hasEnvKeypair) {
              // Environment variable is available - use real trading
              isRealTradingActive = true
              keypairPath = undefined // Will use environment variable
              console.log(`🔥 Real trading mode detected via TRADING_KEYPAIR_JSON - new token ${token.token_symbol} will use REAL trading`)
            } else if (validRealTradeToken?.trading_simulation?.keypair_path) {
              // Copy from existing token that has valid keypair
              isRealTradingActive = true
              keypairPath = validRealTradeToken.trading_simulation.keypair_path
              console.log(`🔥 Real trading mode detected via existing token ${validRealTradeToken.token_symbol} - new token ${token.token_symbol} will use REAL trading`)
            } else {
              // No valid keypair configuration found - use simulation
              if (existingRealTradeTokens.length > 0) {
                console.warn(`⚠️ Found ${existingRealTradeTokens.length} tokens with real trading enabled but no valid keypair_path!`)
                console.warn(`⚠️ This indicates a configuration issue. Falling back to simulation mode for ${token.token_symbol}`)
              } else {
                console.log(`💻 No real trading configuration found - new token ${token.token_symbol} will use simulation`)
              }
              isRealTradingActive = false
              keypairPath = undefined
            }

            // Perform comprehensive risk assessment before assignment
            let riskAssessment: any
            try {
              riskAssessment = await assessTokenRisk({
                token_address: token.token_address,
                token_symbol: token.token_symbol,
                mcap: token.market_cap,
                price: token.current_price,
                change_1h: token.change_1h,
                change_5m: token.change_5m,
                organic_score: token.organic_score
              }, { enableLogging: true, fallbackToBasic: true })

              console.log(`🔍 Risk assessment for ${token.token_symbol}: ${riskAssessment.riskLevel} (method: ${riskAssessment.assessmentMethod})`)
            } catch (riskError) {
              console.error(`❌ Risk assessment failed for ${token.token_symbol}:`, riskError)
              riskAssessment = { riskLevel: 'HIGH', assessmentMethod: 'error_fallback' }
            }

            // Assign token to strategy
            const assignedStrategy = assignTokenToStrategy(token, activeStrategies, allocation, getTrackStrategyRegistry())
            if (!assignedStrategy) {
              console.log(`🚫 Token ${token.token_symbol} rejected: no active strategy matches mcap/organic/holders band`)
              continue
            }

            const strategy = resolveTradingStrategy(assignedStrategy)

            if (!tokenMatchesTrendingBotStrategy(token, strategy)) {
              console.log(`🚫 Token ${token.token_symbol} rejected by strategy '${assignedStrategy}': outside filtering band`)
              continue
            }

            // Risk level constraints - using comprehensive risk assessment
            if (strategy.conditions?.max_risk_level && riskAssessment) {
              const tokenRisk = riskAssessment.riskLevel.toLowerCase() // Convert uppercase to lowercase
              const allowedRisks = strategy.conditions.max_risk_level === 'low' ? ['low'] :
                strategy.conditions.max_risk_level === 'medium' ? ['low', 'med'] :
                  ['low', 'med', 'high']

              if (!allowedRisks.includes(tokenRisk)) {
                console.log(`🚫 Token ${token.token_symbol} rejected by strategy '${assignedStrategy}': Risk level ${riskAssessment.riskLevel} exceeds maximum ${strategy.conditions.max_risk_level.toUpperCase()} (assessment: ${riskAssessment.assessmentMethod})`)
                continue
              } else {
                console.log(`✅ Token ${token.token_symbol} approved for strategy '${assignedStrategy}': Risk level ${riskAssessment.riskLevel} within allowed ${strategy.conditions.max_risk_level.toUpperCase()} threshold`)
              }
            }

            const { executionModes } = getActiveStrategiesSync()
            const simMode = resolveTrendingSimMode(
              executionModes[assignedStrategy],
              isRealTradingActive,
            )
            if (simMode.skipBuy) {
              console.warn(
                `⏭️ Skipping buy for ${token.token_symbol} (${assignedStrategy}): ${simMode.reason}`,
              )
            } else {
            const useRealTrading = !simMode.isSimulated

            // Create initial simulation configuration (use detected trading mode)
            const initialSimulation = createTradingSimulation(
              token,
              assignedStrategy, // Use assigned strategy instead of environment variable
              useRealTrading,
              keypairPath,
              new Date().toISOString()
            )

            // Perform buy operation using the strategy-aware system
            const buyOperation = await executeBuyOperationWithStrategy(
              token,
              assignedStrategy,
              useRealTrading ? 'real' : 'simulation',
              initialSimulation
            )

            if (buyOperation) {
              initialSimulation.buy_operation = buyOperation
              initialSimulation.current_status = 'holding'
              initialSimulation.remaining_token_amount = buyOperation.token_amount_received
              initialSimulation.initial_token_amount = buyOperation.token_amount_received
              ;(initialSimulation as unknown as Record<string, unknown>).strategy_id = assignedStrategy
              ;(initialSimulation as unknown as Record<string, unknown>).entry_market_cap = token.market_cap
              await attachBuyEntryFeatures(initialSimulation, token)
              tradingSimulation = initialSimulation

              console.log(`💰 Buy operation completed for ${token.token_symbol}: ${buyOperation.token_amount_received} tokens (${initialSimulation.is_simulated ? 'simulated' : 'real'}) using ${assignedStrategy} strategy`)

              // Add position to SL/TP tracker for real-time monitoring
              if (!initialSimulation.is_simulated && tradingKeypair) {
                try {
                  const strategy = resolveTradingStrategy(assignedStrategy)
                  await addSLTPPosition({
                    walletAddress: tradingKeypair.publicKey.toString(),
                    tokenAddress: token.token_address,
                    tokenSymbol: token.token_symbol,
                    positionSize: parseFloat(buyOperation.token_amount_received),
                    entryPrice: token.current_price,
                    stopLossPercentage: strategy.stop_loss_percentage,
                    takeProfitPercentage: strategy.take_profit_levels.tp2_percentage,
                    positionType: 'bot',
                    strategyId: assignedStrategy,
                    tp1Percentage: strategy.take_profit_levels.tp1_percentage,
                    tp1SellPercentage: strategy.take_profit_levels.tp1_sell_percentage,
                    tp2Percentage: strategy.take_profit_levels.tp2_percentage,
                    tp3Percentage: strategy.take_profit_levels.tp3_percentage,
                    tp3Enabled: strategy.take_profit_levels.tp3_enabled
                  })

                  console.log(`✅ Added ${token.token_symbol} to SL/TP tracker for real-time monitoring`)
                } catch (slTpError) {
                  console.error('❌ Failed to add position to SL/TP tracker:', slTpError)
                }
              }
            } else {
              console.warn(`❌ Buy operation failed for ${token.token_symbol}`)
            }
            }
          } catch (error) {
            console.error(`❌ Buy operation error for ${token.token_symbol}:`, error)
          }

          // Create initial price history record for new token
          const initialPriceRecord: PriceRecord = {
            timestamp: new Date().toISOString(),
            price_usd: token.current_price,
            volume_5m: token.volume_5m ?? null,
            market_cap: token.market_cap ?? null,
          }

          if (tradingSimulation) {
          // REL-20: collected and flushed as one UNNEST upsert after the loop;
          // Discord notification stays gated on the batched write succeeding.
          trackingUpsert.add(
            [
              tokenId,
              token.token_address,
              token.token_symbol,
              token.token_name,
              token.logo_url,
              token.current_price,
              token.current_price,
              0,
              0,
              0,
              'tracking',
              token.organic_score,
              token.market_cap,
              token.volume_1h,
              new Date().toISOString(),
              JSON.stringify(tradingSimulation),
              JSON.stringify([initialPriceRecord]),
            ],
            {
              ...upsertErrorHooks(token, existingAnyStatus),
              after: async () => {
                // Send Discord notification for new token detection
                if (shouldEnableNotifications()) {
                  try {
                    await sendNewTokenDetectionDiscord({
                      tokenAddress: token.token_address,
                      tokenSymbol: token.token_symbol,
                      tokenName: token.token_name,
                      currentPrice: token.current_price,
                      marketCap: token.market_cap,
                      organicScore: token.organic_score,
                      volume1h: token.volume_1h,
                      isRealTrading: tradingSimulation?.is_simulated === false
                    })
                  } catch (discordError) {
                    console.error('❌ Failed to send new token Discord notification:', discordError)
                    // Don't fail the operation if Discord fails
                  }
                }
              },
            },
          )

          newTokensAdded++
          console.log(`✅ Adding new token to immediate tracking: ${token.token_symbol} (${token.token_address})`)
          } else {
            console.warn(`⏭️ Skipping tracker upsert for ${token.token_symbol} — buy did not complete`)
          }
        }
      } else {
        // Validate prices
        if (token.current_price <= 0) {
          console.warn(`Invalid current price for ${token.token_symbol}:`, token.current_price)
          continue
        }

        // Handle waiting tokens (check for 15% dip trigger or 1-hour timeout)
        if (existingToken.status === 'waiting') {
          const waitingStartTime = new Date(existingToken.waiting_started_at!)
          const currentTime = new Date()
          const waitingDurationHours = (currentTime.getTime() - waitingStartTime.getTime()) / (1000 * 60 * 60)

          // Check for 1-hour timeout
          if (waitingDurationHours >= 1.0) {
            console.log(`⏰ Waiting timeout for ${token.token_symbol} after ${waitingDurationHours.toFixed(1)}h - removing from queue`)

            // Remove from waiting queue (mark as skipped due to timeout)
            // REL-20: collected for batched flush
            {
              const waitingInitial = existingToken.waiting_initial_price ?? token.current_price
              waitingTimeoutUpdate.add([
                'skipped',
                currentTime.toISOString(),
                token.current_price,
                waitingInitial,
                waitingInitial,
                0,
                0,
                existingToken.id,
              ])
            }
            continue
          }

          // Calculate dip percentage from waiting initial price
          const dipFromWaitingStart = calculateGainPercentage(token.current_price, existingToken.waiting_initial_price!)

          console.log(`📊 Waiting token ${token.token_symbol}: ${dipFromWaitingStart.toFixed(2)}% change (waiting ${waitingDurationHours.toFixed(1)}h)`)

          // Check for 15% dip trigger
          if (dipFromWaitingStart <= -15.0) {
            console.log(`🎯 15% dip detected for ${token.token_symbol}! Converting from waiting to tracking status`)

            // Execute buy operation and convert to tracking
            try {
              // Check if real trading mode is activated - improved logic
              let isRealTradingActive = false
              let keypairPath: string | undefined = undefined

              // First, check if TRADING_KEYPAIR_JSON environment variable is set
              const hasEnvKeypair = !!process.env.TRADING_KEYPAIR_JSON
              console.log(`🔑 Keypair detection for ${token.token_symbol}:`)
              console.log(`  - TRADING_KEYPAIR_JSON env var: ${hasEnvKeypair ? 'SET' : 'NOT SET'}`)

              // Check if any existing tracked token has real trading enabled
              const existingRealTradeTokens = trackedTokens?.filter(t =>
                t.trading_simulation && !t.trading_simulation.is_simulated
              ) || []

              console.log(`  - Existing real trade tokens found: ${existingRealTradeTokens.length}`)

              // Find a token with both real trading AND a valid keypair_path
              const validRealTradeToken = existingRealTradeTokens.find(t =>
                t.trading_simulation?.keypair_path
              )

              if (validRealTradeToken?.trading_simulation) {
                console.log(`  - Valid existing token with keypair found: ${validRealTradeToken.token_symbol}`)
              }

              // Determine trading mode and keypair path with better validation
              if (hasEnvKeypair) {
                // Environment variable is available - use real trading
                isRealTradingActive = true
                keypairPath = undefined // Will use environment variable
                console.log(`🔥 Real trading mode detected via TRADING_KEYPAIR_JSON - new token ${token.token_symbol} will use REAL trading`)
              } else if (validRealTradeToken?.trading_simulation?.keypair_path) {
                // Copy from existing token that has valid keypair
                isRealTradingActive = true
                keypairPath = validRealTradeToken.trading_simulation.keypair_path
                console.log(`🔥 Real trading mode detected via existing token ${validRealTradeToken.token_symbol} - new token ${token.token_symbol} will use REAL trading`)
              } else {
                // No valid keypair configuration found - use simulation
                if (existingRealTradeTokens.length > 0) {
                  console.warn(`⚠️ Found ${existingRealTradeTokens.length} tokens with real trading enabled but no valid keypair_path!`)
                  console.warn(`⚠️ This indicates a configuration issue. Falling back to simulation mode for ${token.token_symbol}`)
                } else {
                  console.log(`💻 No real trading configuration found - new token ${token.token_symbol} will use simulation`)
                }
                isRealTradingActive = false
                keypairPath = undefined
              }

              // Perform comprehensive risk assessment before assignment
              let riskAssessment: any
              try {
                riskAssessment = await assessTokenRisk({
                  token_address: token.token_address,
                  token_symbol: token.token_symbol,
                  mcap: token.market_cap,
                  price: token.current_price,
                  change_1h: token.change_1h,
                  change_5m: token.change_5m,
                  organic_score: token.organic_score
                }, { enableLogging: true, fallbackToBasic: true })
                console.log(`🔍 Risk assessment for ${token.token_symbol}: ${riskAssessment.riskLevel} (method: ${riskAssessment.assessmentMethod})`)
              } catch (riskError) {
                console.error(`❌ Risk assessment failed for ${token.token_symbol}:`, riskError)
                riskAssessment = { riskLevel: 'HIGH', assessmentMethod: 'error_fallback' }
              }

              // Assign token to strategy
              const assignedStrategy = assignTokenToStrategy(token, activeStrategies, allocation, getTrackStrategyRegistry())
              if (!assignedStrategy) {
                console.log(`🚫 Dip buy ${token.token_symbol} rejected: no active strategy matches band`)
                continue
              }

              const strategy = resolveTradingStrategy(assignedStrategy)

              if (!tokenMatchesTrendingBotStrategy(token, strategy)) {
                console.log(`🚫 Dip buy ${token.token_symbol} rejected by '${assignedStrategy}': outside filtering band`)
                continue
              }

              // Risk level constraints - using comprehensive risk assessment
              if (strategy.conditions?.max_risk_level && riskAssessment) {
                const tokenRisk = riskAssessment.riskLevel.toLowerCase()
                const allowedRisks = strategy.conditions.max_risk_level === 'low' ? ['low'] :
                  strategy.conditions.max_risk_level === 'medium' ? ['low', 'med'] :
                    ['low', 'med', 'high']

                if (!allowedRisks.includes(tokenRisk)) {
                  console.log(`🚫 Token ${token.token_symbol} rejected by strategy '${assignedStrategy}': Risk level ${riskAssessment.riskLevel} exceeds maximum ${strategy.conditions.max_risk_level.toUpperCase()} (assessment: ${riskAssessment.assessmentMethod})`)
                  continue
                } else {
                  console.log(`✅ Token ${token.token_symbol} approved for strategy '${assignedStrategy}': Risk level ${riskAssessment.riskLevel} within allowed ${strategy.conditions.max_risk_level.toUpperCase()} threshold`)
                }
              }

              const { executionModes: dipExecutionModes } = getActiveStrategiesSync()
              const dipSimMode = resolveTrendingSimMode(
                dipExecutionModes[assignedStrategy],
                isRealTradingActive,
              )
              if (dipSimMode.skipBuy) {
                console.warn(
                  `⏭️ Skipping dip buy for ${token.token_symbol} (${assignedStrategy}): ${dipSimMode.reason}`,
                )
              } else {
              const useRealTrading = !dipSimMode.isSimulated

              // Create initial simulation configuration (use detected trading mode)
              const initialSimulation = createTradingSimulation(
                token,
                assignedStrategy, // Use assigned strategy instead of environment variable
                useRealTrading,
                keypairPath,
                currentTime.toISOString()
              )

              // Override TP1 sell percentage for dip buys
              initialSimulation.take_profit_levels.tp1_sell_percentage = 95

              // Perform buy operation using the strategy-aware system
              const buyOperation = await executeBuyOperationWithStrategy(
                token,
                assignedStrategy,
                useRealTrading ? 'real' : 'simulation',
                initialSimulation
              )

              if (buyOperation) {
                initialSimulation.buy_operation = buyOperation
                initialSimulation.current_status = 'holding'
                initialSimulation.remaining_token_amount = buyOperation.token_amount_received
                initialSimulation.initial_token_amount = buyOperation.token_amount_received
                ;(initialSimulation as unknown as Record<string, unknown>).strategy_id = assignedStrategy
                ;(initialSimulation as unknown as Record<string, unknown>).entry_market_cap = token.market_cap
                await attachBuyEntryFeatures(initialSimulation, token)

                console.log(`💰 Buy operation completed for ${token.token_symbol}: ${buyOperation.token_amount_received} tokens (${initialSimulation.is_simulated ? 'simulated' : 'real'}) using ${assignedStrategy} strategy`)

                // Add position to SL/TP tracker for real-time monitoring
                if (!initialSimulation.is_simulated && tradingKeypair) {
                  try {
                    const strategy = resolveTradingStrategy(assignedStrategy)
                    await addSLTPPosition({
                      walletAddress: tradingKeypair.publicKey.toString(),
                      tokenAddress: token.token_address,
                      tokenSymbol: token.token_symbol,
                      positionSize: parseFloat(buyOperation.token_amount_received),
                      entryPrice: token.current_price,
                      stopLossPercentage: strategy.stop_loss_percentage,
                      takeProfitPercentage: strategy.take_profit_levels.tp2_percentage,
                      positionType: 'bot',
                      strategyId: assignedStrategy,
                      tp1Percentage: strategy.take_profit_levels.tp1_percentage,
                      tp1SellPercentage: strategy.take_profit_levels.tp1_sell_percentage,
                      tp2Percentage: strategy.take_profit_levels.tp2_percentage,
                      tp3Percentage: strategy.take_profit_levels.tp3_percentage,
                      tp3Enabled: strategy.take_profit_levels.tp3_enabled
                    })

                    console.log(`✅ Added ${token.token_symbol} to SL/TP tracker for real-time monitoring`)
                  } catch (slTpError) {
                    console.error('❌ Failed to add position to SL/TP tracker:', slTpError)
                  }
                }

                // Update token status to tracking with buy simulation
                // REL-20: collected for batched flush
                dipConvertUpdate.add([
                  'tracking',
                  currentTime.toISOString(),
                  token.current_price,
                  token.current_price,
                  token.current_price,
                  0,
                  0,
                  JSON.stringify(initialSimulation),
                  existingToken.id,
                ])

                // Send Discord notification for successful dip buy
                if (shouldEnableNotifications()) {
                  try {
                    await sendNewTokenDetectionDiscord({
                      tokenAddress: token.token_address,
                      tokenSymbol: token.token_symbol,
                      tokenName: token.token_name,
                      currentPrice: token.current_price,
                      marketCap: token.market_cap,
                      organicScore: token.organic_score,
                      volume1h: token.volume_1h,
                      isRealTrading: !initialSimulation.is_simulated
                    })
                  } catch (discordError) {
                    console.error('❌ Failed to send dip buy Discord notification:', discordError)
                  }
                }

                tokensUpdated++
                console.log(`✅ ${token.token_symbol} converted from waiting to tracking after 15% dip`)
              } else {
                console.warn(`❌ Buy operation failed for waiting token ${token.token_symbol}`)
                // Keep in waiting status for next attempt
                // REL-20: collected for batched flush
                waitingPriceTouch.add([token.current_price, existingToken.id])
              }
              }
            } catch (error) {
              console.error(`❌ Error converting waiting token ${token.token_symbol} to tracking:`, error)
              // Keep in waiting status for next attempt
              // REL-20: collected for batched flush
              waitingPriceTouch.add([token.current_price, existingToken.id])
            }
            continue
          } else {
            // Still waiting - just update price
            // REL-20: collected for batched flush
            waitingMetricsUpdate.add([
              token.current_price,
              token.organic_score,
              token.market_cap,
              token.volume_1h,
              existingToken.id,
            ])
            continue
          }
        }

        // Calculate current gain for tracking tokens
        // Add validation before calling calculateGainPercentage
        if (!existingToken.initial_price_usd || existingToken.initial_price_usd <= 0) {
          console.warn(`Invalid initial price for token ${token.token_symbol}: ${existingToken.initial_price_usd}`);
          continue; // Skip this token if initial price is invalid
        }

        if (!token.current_price || token.current_price <= 0) {
          console.warn(`Invalid current price for token ${token.token_symbol}: ${token.current_price}`);
          continue; // Skip this token if current price is invalid
        }

        const currentGain = calculateGainPercentage(token.current_price, existingToken.initial_price_usd)

        // Only update peak price and gain if current price is higher than existing peak
        const newPeakPrice = calculatePeakPrice(token.current_price, existingToken.peak_price_usd)
        const peakGain = newPeakPrice > existingToken.peak_price_usd ?
          calculateGainPercentage(newPeakPrice, existingToken.initial_price_usd) :
          existingToken.peak_gain_percentage

        // Store price tracking data for analysis
        const priceTracking: PriceTracking = {
          initialPrice: existingToken.initial_price_usd,
          currentPrice: token.current_price,
          peakPrice: newPeakPrice,
          currentGain,
          peakGain,
          lastUpdated: new Date().toISOString()
        }

        // Use priceTracking for logging/debugging (fixes unused variable warning)
        console.log(`📊 Price tracking for ${token.token_symbol}:`, {
          symbol: token.token_symbol,
          tracking: priceTracking
        });

        // Check if token has dropped more than 50% from initial price (original loss condition)
        const isLost = currentGain <= -50

        // Existing staleness check
        const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
        const lastPriceUpdate = new Date(existingToken.updated_at)
        const isStaleData = lastPriceUpdate < twoWeeksAgo

        // New tracking age check
        const maxTrackingDays = process.env.MAX_TRACKING_DAYS ? parseInt(process.env.MAX_TRACKING_DAYS) : 3;
        const trackingStart = new Date(existingToken.tracking_started_at);
        const trackingAgeDays = (Date.now() - trackingStart.getTime()) / (1000 * 60 * 60 * 24);
        const isTooOld = trackingAgeDays > maxTrackingDays && existingToken.status === 'tracking';

        if (isStaleData || isTooOld) {
          // Mark as stopped due to staleness or age
          // REL-20: collected for batched flush
          stoppedUpdate.add([
            'stopped',
            new Date().toISOString(),
            token.current_price,
            currentGain,
            peakGain,
            token.organic_score,
            token.market_cap,
            token.volume_1h,
            existingToken.id,
          ])

          const reason = isStaleData ? 'stale data' : 'tracking age exceeded';
          console.log(`🛑 Token stopped due to ${reason} (${Math.round(trackingAgeDays)} days): ${token.token_symbol} (${token.token_address})`)
          continue // Skip further processing for this token
        }

        // Check if trading simulation should sell
        let shouldSell = false
        let sellOperation = null

        if (existingToken.trading_simulation && existingToken.trading_simulation.current_status === 'holding') {
          console.log(`🔍 Checking sell conditions for ${token.token_symbol} (${existingToken.trading_simulation.current_status})`)

          const sellDecision = shouldSellToken(existingToken, existingToken.trading_simulation)

          if (sellDecision.shouldSell) {
            console.log(`🚨 SELL DECISION MADE: ${sellDecision.reason}`)

            // Perform sell simulation with the specified percentage
            const sellOperation = await performSellOperation(
              {
                ...token,
                current_price: token.current_price
              },
              existingToken.trading_simulation,
              sellDecision.sellPercentage,
              (existingToken.trading_simulation.buy_operation as { bot_strategy?: string })
                ?.bot_strategy,
            )

            if (sellOperation) {
              try {
                // Calculate gains using our helper function
                const finalGain = calculateGainPercentage(token.current_price, existingToken.initial_price_usd)

                // Calculate hold duration
                const simulationStart = new Date(existingToken.trading_simulation.simulation_started_at)
                const now = new Date()
                const holdDurationHours = (now.getTime() - simulationStart.getTime()) / (1000 * 60 * 60)

                // Set final gain and hold duration on sell operation
                sellOperation.final_gain_percentage = finalGain
                sellOperation.hold_duration_hours = holdDurationHours

                // Add sell operation to the simulation
                existingToken.trading_simulation.sell_operations.push(sellOperation)

                // Check if position is fully closed (100% sell or remaining tokens ~ 0)
                const remainingTokens = parseFloat(existingToken.trading_simulation.remaining_token_amount || '0')
                const isPositionClosed = sellDecision.sellPercentage === 100 || remainingTokens < 1000 // Less than 0.001 tokens remaining

                if (isPositionClosed) {
                  // Update simulation status to completed
                  existingToken.trading_simulation.current_status = 'completed'
                  existingToken.trading_simulation.remaining_token_amount = '0'

                  const finalStatus = finalGain > 0 ? 'won' : 'lost'
                  existingToken.status = finalStatus
                  existingToken.status_changed_at = new Date().toISOString()

                  // Calculate final result
                  const buyOperation = existingToken.trading_simulation.buy_operation
                  if (buyOperation) {
                    const totalSolReceived = existingToken.trading_simulation.sell_operations.reduce(
                      (total, op) => total + (parseFloat(op.sol_received) / 1e9), 0
                    )
                    const totalSolGain = totalSolReceived - buyOperation.buy_amount_sol

                    existingToken.trading_simulation.final_result = {
                      success: finalGain > 0,
                      total_gain_percentage: finalGain,
                      total_gain_sol: totalSolGain,
                      buy_price_usd: buyOperation.buy_price_usd,
                      sell_price_usd: token.current_price,
                      hold_duration_hours: holdDurationHours,
                      best_buy_config: buyOperation.best_buy_config,
                      best_sell_configs: existingToken.trading_simulation.sell_operations.map(op => op.best_sell_config)
                    }
                  }
                }

                // Log sell operation details
                logTradeOperation('Sell Operation', {
                  requestId,
                  tokenSymbol: token.token_symbol,
                  finalGain,
                  sellPercentage: sellDecision.sellPercentage,
                  isPositionClosed,
                  operationType: existingToken.trading_simulation.current_status
                })

                // Send Discord notification if enabled
                if (shouldEnableNotifications()) {
                  const bestCfg = sellOperation.best_sell_config
                  const notificationStatus = getNotificationStatus(existingToken.trading_simulation.current_status)

                  await sendTradeAlertDiscord({
                    tokenSymbol: token.token_symbol,
                    status: notificationStatus,
                    isSimulated: existingToken.trading_simulation.is_simulated,
                    currentGain: finalGain,
                    peakGain: existingToken.peak_gain_percentage,
                    priceUsd: token.current_price,
                    provider: bestCfg.provider,
                    rpcUsed: bestCfg.rpc_used,
                    responseTime: bestCfg.response_time
                  }).catch(error => {
                    // Log Discord error but don't fail the operation
                    logTradeOperation('Discord Notification Failed', {
                      requestId,
                      tokenSymbol: token.token_symbol,
                      finalGain
                    }, error)
                  })
                }

                // Log successful completion
                logTradeOperation('Tracking Request Completed', {
                  requestId,
                  duration: Date.now() - requestStartTime,
                  tokenSymbol: token.token_symbol,
                  status: 'success'
                })
              } catch (error) {
                // Log sell operation error
                logTradeOperation('Sell Operation Error', {
                  requestId,
                  tokenSymbol: token.token_symbol,
                  operationType: existingToken.trading_simulation.current_status
                }, error as Error)

                // Continue processing other tokens
                console.error('Error in sell operation:', error)
              }
            }
          }
        }

        // Create new price record for history
        const newPriceRecord: PriceRecord = {
          timestamp: new Date().toISOString(),
          price_usd: token.current_price,
          volume_5m: token.volume_5m ?? null,
          market_cap: token.market_cap ?? null,
        }

        // Update price history (keep last 24 hours, max 288 records for 5-minute intervals)
        const existingPriceHistory: PriceRecord[] = existingToken.price_history || []
        const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000) // 24 hours ago

        // Filter old records and add new one
        const updatedPriceHistory = [
          ...existingPriceHistory.filter(record => new Date(record.timestamp) > cutoffTime),
          newPriceRecord
        ].slice(-288) // Keep max 288 records (24h * 12 records per hour)

        if (isLost && existingToken.status === 'tracking') {
          // Mark as lost (original logic)
          // REL-20: collected for batched flush
          trackingStateUpdate.add([
            token.current_price,
            newPeakPrice,
            currentGain,
            peakGain,
            'lost',
            new Date().toISOString(),
            token.organic_score,
            token.market_cap,
            token.volume_1h,
            JSON.stringify(existingToken.trading_simulation),
            JSON.stringify(updatedPriceHistory),
            existingToken.id,
          ])

          tokensLost++
          console.log(`❌ Token lost (${currentGain.toFixed(2)}%): ${token.token_symbol} (${token.token_address})`)
        } else if (existingToken.status === 'tracking') {
          // Update tracking token with new price data and simulation results
          // REL-20: collected for batched flush
          trackingStateUpdate.add([
            token.current_price,
            newPeakPrice,
            currentGain,
            peakGain,
            existingToken.status,
            existingToken.status_changed_at,
            token.organic_score,
            token.market_cap,
            token.volume_1h,
            JSON.stringify(existingToken.trading_simulation),
            JSON.stringify(updatedPriceHistory),
            existingToken.id,
          ])

          tokensUpdated++
          if (currentGain > 10) {
            console.log(`📈 Token performing well (${currentGain.toFixed(2)}%): ${token.token_symbol}`)
          }

          if (shouldSell && sellOperation) {
            console.log(`🎯 Token sold via simulation (${currentGain.toFixed(2)}%): ${token.token_symbol}`)
          }
        }
      }
    }

    // ====================================================================================================
    // PROCESS ORPHANED TOKENS (Tracked but not in current Jupiter trending list)
    // ====================================================================================================

    // Identify tokens that are being tracked but weren't in the Jupiter response
    const processedTokenAddresses = new Set(filteredTokens.map(t => t.token_address))
    const orphanedTokens = trackedTokens?.filter(t =>
      t.status === 'tracking' && !processedTokenAddresses.has(t.token_address)
    ) || []

    if (orphanedTokens.length > 0) {
      console.log(`🔍 Processing ${orphanedTokens.length} orphaned tracked tokens (not in current trending list)...`)

      // Fetch current prices for these tokens
      const tokenAddresses = orphanedTokens.map(t => t.token_address)

      // Batch fetch prices to avoid URL length limits
      const prices: Record<string, number> = {}
      const BATCH_SIZE = 50

      for (let i = 0; i < tokenAddresses.length; i += BATCH_SIZE) {
        const batch = tokenAddresses.slice(i, i + BATCH_SIZE)
        try {
          const batchPrices = await fetchTokenPricesForTracking(batch)
          Object.assign(prices, batchPrices)
        } catch (err) {
          console.error(`Error fetching prices for batch ${i}-${i + BATCH_SIZE}:`, err)
        }
      }

      // Process each orphaned token
      for (const existingToken of orphanedTokens) {
        const currentPrice = prices[existingToken.token_address]

        if (!currentPrice) {
          // If price is missing, we can't update. Log warning and skip.
          // console.warn(`⚠️ Could not fetch price for orphaned token: ${existingToken.token_symbol}`)
          continue
        }

        // Reconstruct a token object similar to what we get from Jupiter, but using existing metadata
        const token = {
          token_address: existingToken.token_address,
          token_symbol: existingToken.token_symbol || 'UNKNOWN',
          token_name: existingToken.token_name || 'Unknown Token',
          current_price: currentPrice,
          volume_1h: existingToken.volume_1h || 0, // Fallback to existing volume or 0
          market_cap: existingToken.market_cap || 0,
          organic_score: existingToken.organic_score || 0,
          volume_5m: existingToken.volume_5m || 0,
          status_changed_at: existingToken.status_changed_at || existingToken.created_at,
          created_at: existingToken.created_at
        }

        // Calculate gains
        const currentGain = calculateGainPercentage(currentPrice, existingToken.initial_price_usd)
        const newPeakPrice = Math.max(existingToken.peak_price_usd, currentPrice)
        const peakGain = newPeakPrice > existingToken.peak_price_usd ?
          calculateGainPercentage(newPeakPrice, existingToken.initial_price_usd) :
          existingToken.peak_gain_percentage

        // Check loss condition (same as main loop)
        const isLost = currentGain <= -50

        // Check if trading simulation should sell
        let shouldSell = false
        let sellOperation = null

        if (existingToken.trading_simulation && existingToken.trading_simulation.current_status === 'holding') {
          const sellDecision = shouldSellToken(existingToken, existingToken.trading_simulation)

          if (sellDecision.shouldSell) {
            console.log(`🚨 ORPHAN SELL DECISION: ${sellDecision.reason} for ${token.token_symbol}`)

            // Perform sell simulation
            const sellOp = await performSellOperation(
              { ...token, current_price: currentPrice },
              existingToken.trading_simulation,
              sellDecision.sellPercentage
            )

            if (sellOp) {
              sellOperation = sellOp
              shouldSell = true

              // Calculate final gain
              const finalGain = calculateGainPercentage(currentPrice, existingToken.initial_price_usd)
              const simulationStart = new Date(existingToken.trading_simulation.simulation_started_at)
              const now = new Date()
              const holdDurationHours = (now.getTime() - simulationStart.getTime()) / (1000 * 60 * 60)

              sellOperation.final_gain_percentage = finalGain
              sellOperation.hold_duration_hours = holdDurationHours

              existingToken.trading_simulation.sell_operations.push(sellOperation)

              const remainingTokens = parseFloat(existingToken.trading_simulation.remaining_token_amount || '0')
              const isPositionClosed = sellDecision.sellPercentage === 100 || remainingTokens < 1000

              if (isPositionClosed) {
                existingToken.trading_simulation.current_status = 'completed'
                existingToken.trading_simulation.remaining_token_amount = '0'

                // Calculate final result
                const buyOperation = existingToken.trading_simulation.buy_operation
                if (buyOperation) {
                  const totalSolReceived = existingToken.trading_simulation.sell_operations.reduce(
                    (total: number, op: any) => total + (parseFloat(op.sol_received) / 1e9), 0
                  )
                  const totalSolGain = totalSolReceived - buyOperation.buy_amount_sol

                  existingToken.trading_simulation.final_result = {
                    success: finalGain > 0,
                    total_gain_percentage: finalGain,
                    total_gain_sol: totalSolGain,
                    buy_price_usd: buyOperation.buy_price_usd,
                    sell_price_usd: currentPrice,
                    hold_duration_hours: holdDurationHours,
                    best_buy_config: buyOperation.best_buy_config,
                    best_sell_configs: existingToken.trading_simulation.sell_operations.map((op: any) => op.best_sell_config)
                  }
                }
              }

              // Log trade operation
              logTradeOperation('Sell Operation (Orphaned)', {
                requestId,
                tokenSymbol: token.token_symbol,
                finalGain,
                sellPercentage: sellDecision.sellPercentage,
                isPositionClosed,
                operationType: existingToken.trading_simulation.current_status
              })

              // Send Discord notification if enabled
              if (shouldEnableNotifications()) {
                const bestCfg = sellOperation.best_sell_config
                const notificationStatus = getNotificationStatus(existingToken.trading_simulation.current_status)

                await sendTradeAlertDiscord({
                  tokenSymbol: token.token_symbol,
                  status: notificationStatus,
                  isSimulated: existingToken.trading_simulation.is_simulated,
                  currentGain: finalGain,
                  peakGain: existingToken.peak_gain_percentage,
                  priceUsd: token.current_price,
                  provider: bestCfg.provider,
                  rpcUsed: bestCfg.rpc_used,
                  responseTime: bestCfg.response_time
                }).catch(error => {
                  console.error('Failed to send Discord alert for orphaned sell:', error)
                })
              }
            }
          }
        }

        // Update price history
        const newPriceRecord: PriceRecord = {
          timestamp: new Date().toISOString(),
          price_usd: currentPrice,
          volume_5m: token.volume_5m ?? null,
          market_cap: token.market_cap ?? null,
        }

        const existingPriceHistory: PriceRecord[] = existingToken.price_history || []
        const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000)

        const updatedPriceHistory = [
          ...existingPriceHistory.filter((record: PriceRecord) => new Date(record.timestamp) > cutoffTime),
          newPriceRecord
        ].slice(-288)

        // Add update promise
        if (isLost && existingToken.status === 'tracking') {
          // REL-20: collected for batched flush
          orphanLostUpdate.add([
            currentPrice,
            newPeakPrice,
            currentGain,
            peakGain,
            'lost',
            new Date().toISOString(),
            JSON.stringify(existingToken.trading_simulation),
            JSON.stringify(updatedPriceHistory),
            existingToken.id,
          ])
          tokensLost++
          console.log(`❌ Orphaned Token lost (${currentGain.toFixed(2)}%): ${token.token_symbol}`)
        } else {
          // REL-20: collected for batched flush
          orphanUpdate.add([
            currentPrice,
            newPeakPrice,
            currentGain,
            peakGain,
            JSON.stringify(existingToken.trading_simulation),
            JSON.stringify(updatedPriceHistory),
            existingToken.id,
          ])
          tokensUpdated++
        }
      }
    }

    // REL-20: flush collected batched writes alongside any remaining promises.
    // Ordering matches the old semantics: waiting/dip writes and tracking-state
    // writes are independent rows (keyed by id / token_address), so flushes can
    // run concurrently just like the old per-row promises did.
    const rel20Batches: WriteBatch[] = [
      waitingUpsert,
      trackingUpsert,
      waitingTimeoutUpdate,
      dipConvertUpdate,
      waitingPriceTouch,
      waitingMetricsUpdate,
      stoppedUpdate,
      trackingStateUpdate,
      orphanLostUpdate,
      orphanUpdate,
    ]
    for (const batch of rel20Batches) {
      if (batch.size > 0) updatesPromises.push(flushBatch(batch))
    }

    // Execute all updates in parallel
    const results = await Promise.allSettled(updatesPromises)
    const rejectedPromises = results.filter(result => result.status === 'rejected')
    const fulfilledResults = results.filter(result => result.status === 'fulfilled').map(result => result.value)
    const failedOperations = fulfilledResults.filter(result => result && typeof result === 'object' && !result.success)

    const totalFailures = rejectedPromises.length + failedOperations.length

    if (totalFailures > 0) {
      console.error(`⚠️ ${totalFailures} updates failed:`, {
        rejectedPromises: rejectedPromises.length,
        failedOperations: failedOperations.length,
        rejectedReasons: rejectedPromises.map(r => r.reason),
        failedTokens: failedOperations.map(op => op.tokenSymbol)
      })
    }

    // REL-20 (rec 6.3): per-cycle statement timing for the batched writes
    if (rel20Stats.length > 0) {
      const totalRows = rel20Stats.reduce((sum, s) => sum + s.stats.rows, 0)
      const totalChunks = rel20Stats.reduce((sum, s) => sum + s.stats.chunks, 0)
      const totalMs = rel20Stats.reduce((sum, s) => sum + s.stats.ms, 0)
      log.info('api_request', 'REL-20 batched tracker writes', {
        batches: rel20Stats.map((s) => ({
          name: s.name,
          rows: s.stats.rows,
          chunks: s.stats.chunks,
          ms: s.stats.ms,
          ok: s.ok,
        })),
        totalRows,
        totalStatements: totalChunks,
        totalMs,
        replacedRoundTrips: totalRows,
      })
      console.log(
        `📦 REL-20 batched writes: ${totalRows} rows in ${totalChunks} statements (${totalMs}ms total) — replaced ${totalRows} per-row round-trips`,
      )
    }

    // Get updated statistics
    let currentStats: { status: string }[] = []
    try {
      const { rows } = await query<{ status: string }>(
        `SELECT status FROM ${TRACKER_TABLE}`,
      )
      currentStats = rows
    } catch (statsError) {
      console.error('Failed to fetch current stats:', statsError)
    }

    const stats = {
      waiting: currentStats?.filter(t => t.status === 'waiting').length || 0,
      tracking: currentStats?.filter(t => t.status === 'tracking').length || 0,
      won: currentStats?.filter(t => t.status === 'won').length || 0,
      lost: currentStats?.filter(t => t.status === 'lost').length || 0,
      skipped: currentStats?.filter(t => t.status === 'skipped').length || 0,
      stopped: currentStats?.filter(t => t.status === 'stopped').length || 0
    }

    const summary = {
      success: true,
      timestamp: new Date().toISOString(),
      processed: filteredTokens.length,
      new_tokens_added: newTokensAdded,
      tokens_updated: tokensUpdated,
      tokens_lost: tokensLost,
      failed_updates: totalFailures,
      current_stats: stats,
      message: `Tracked ${filteredTokens.length} tokens: ${newTokensAdded} new, ${tokensUpdated} updated, ${tokensLost} lost`
    }

    if (DEBUG_LOG) {
      console.debug('✅ 5-minute tracking completed:', summary)
    } else {
      console.log(`✅ 5-minute tracking completed: processed ${summary.processed} tokens; new ${summary.new_tokens_added}, updated ${summary.tokens_updated}`)

      // Log strategy distribution summary
      console.log('📊 Active strategy summary:')
      activeStrategies.forEach(strategyId => {
        const strategyActiveTrades = activeTradesByStrategy.get(strategyId)
        const activeCount = strategyActiveTrades ? strategyActiveTrades.size : 0
        console.log(`  ${strategyId}: ${activeCount} active trades`)
      })
    }

    // Set a timestamp for cache invalidation (could be used by other APIs)
    const headers: Record<string, string> = {
      'X-Data-Updated': new Date().toISOString(),
      'Cache-Control': 'no-cache' // Track route should never be cached
    }

    // Add strategy information to response
    const strategyInfo = activeStrategies.reduce((acc, strategyId) => {
      const strategyActiveTrades = activeTradesByStrategy.get(strategyId)
      acc[strategyId] = {
        active_trades: strategyActiveTrades ? strategyActiveTrades.size : 0,
        strategy_name: getTrackStrategyRegistry()[strategyId]?.name || strategyId
      }
      return acc
    }, {} as Record<string, any>)

    return NextResponse.json({
      ...summary,
      strategy_info: strategyInfo
    }, {
      status: 200,
      headers
    })

  } catch (error) {
    // Log complete request failure
    logTradeOperation('Tracking Request Failed', {
      requestId,
      duration: Date.now() - requestStartTime,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, error as Error)

    return NextResponse.json({
      error: 'Failed to track trending tokens',
      message: error instanceof Error ? error.message : 'Unknown error',
      requestId,
      timestamp: new Date().toISOString()
    }, { status: 500 })
  } finally {
    await releaseJobLock('trending_track')
  }
}

