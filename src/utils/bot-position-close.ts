import { supabase } from '@/utils/supabase'
import { getSolPriceUSD } from '@/utils/solana'
import {
  buildTradingRecord,
  insertTradingRecord,
} from '@/utils/trading-records-db'
import { calculateGainPercentage } from '@/utils/trading-math'
import { recordTrendingBotOutcome } from '@/strategies/outcomes'
import {
  mergeEntryFeaturesForOutcome,
  mergeMonitorSnapshots,
  priceHistoryToMonitorSnapshots,
} from '@/strategies/entry-feature-snapshot'
import { buildFullEntryFeatureSnapshot } from '@/strategies/resolve-entry-snapshot'
import { filterPointsToWindow, parsePriceHistory } from '@/strategies/trade-window-chart-data'

const TRACKER_TABLE =
  process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'

export type BotCloseReason =
  | 'tp1'
  | 'tp2'
  | 'tp3'
  | 'sl'
  | 'max_hold'
  | 'sltp_monitor'
  | 'track_route'

export interface BotSellResult {
  success: boolean
  signature?: string
  inputAmount: string
  outputAmount: string
  fees?: { totalFees: number }
  provider?: string
  rpcUsed?: string
  responseTime?: number
}

export interface FinalizeBotCloseParams {
  tokenAddress: string
  tokenSymbol: string
  tokenName?: string
  logoUrl?: string
  walletAddress: string
  strategyId: string
  isSimulated: boolean
  sellResult: BotSellResult
  sellPercentage: number
  currentPriceUsd: number
  initialPriceUsd?: number
  tokenDecimals?: number
  closeReason: BotCloseReason
  isFullClose: boolean
  priorityFee?: number
  strictRecord?: boolean
}

function resolveDecimals(explicit?: number): number {
  return explicit != null && explicit >= 0 ? explicit : 6
}

export async function hasActiveSlTpPosition(
  walletAddress: string,
  tokenAddress: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('sl_tp_positions')
    .select('id')
    .eq('wallet_address', walletAddress)
    .eq('token_address', tokenAddress)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.warn('[bot-position-close] SL/TP lookup failed:', error.message)
    return false
  }

  return !!data
}

/** Single path for bot sell history + tracker status after a close (sim or real). */
export async function finalizeBotPositionClose(
  params: FinalizeBotCloseParams,
): Promise<void> {
  if (!params.sellResult.success) {
    return
  }

  const decimals = resolveDecimals(params.tokenDecimals)
  const currentSolPrice = await getSolPriceUSD()
  const solAmount = parseFloat(params.sellResult.outputAmount) / 1e9
  const tokenAmount =
    parseFloat(params.sellResult.inputAmount) / Math.pow(10, decimals)

  const gainPct = params.initialPriceUsd
    ? calculateGainPercentage(params.currentPriceUsd, params.initialPriceUsd)
    : 0

  const record = buildTradingRecord({
    walletAddress: params.walletAddress,
    operationType: 'sell',
    tokens: [
      {
        mintAddress: params.tokenAddress,
        symbol: params.tokenSymbol,
        name: params.tokenName,
        logoURI: params.logoUrl,
        priceUsd: params.currentPriceUsd,
        tokenAmount: Number.isFinite(tokenAmount) ? tokenAmount : 0,
        solAmount,
        solPrice: currentSolPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount,
    feesPaid: params.sellResult.fees?.totalFees || 0,
    solPriceUsd: currentSolPrice,
    totalUsdValue: currentSolPrice ? solAmount * currentSolPrice : undefined,
    signatures: params.sellResult.signature ? [params.sellResult.signature] : [],
    slippage: 3,
    priorityFee: params.priorityFee ?? 100_000,
    is_bot_operation: true,
    bot_strategy: params.strategyId,
    is_simulation: params.isSimulated,
    simulation_type: params.isSimulated ? 'strategy' : undefined,
    close_position: params.isFullClose && params.isSimulated ? true : undefined,
  })

  try {
    await insertTradingRecord(record)
    console.log(
      `🤖 Bot close recorded: ${params.tokenSymbol} (${params.strategyId}, ${params.closeReason}, sim=${params.isSimulated})`,
    )
  } catch (err) {
    console.error('[bot-position-close] Failed to insert trading record:', err)
    if (params.strictRecord && !params.isSimulated) {
      throw err
    }
  }

  if (!params.isFullClose) {
    return
  }

  const finalStatus = gainPct >= 0 ? 'won' : 'lost'

  const { data: tracker } = await supabase
    .from(TRACKER_TABLE)
    .select(
      'id, trading_simulation, market_cap, organic_score, volume_5m, created_at, price_history',
    )
    .eq('token_address', params.tokenAddress)
    .in('status', ['tracking', 'waiting'])
    .maybeSingle()

  if (!tracker) {
    return
  }

  const sim =
    (tracker.trading_simulation as Record<string, unknown> | null) ?? {}

  await supabase
    .from(TRACKER_TABLE)
    .update({
      status: finalStatus,
      status_changed_at: new Date().toISOString(),
      last_price_usd: params.currentPriceUsd,
      current_gain_percentage: gainPct,
      trading_simulation: {
        ...sim,
        current_status: 'completed',
        remaining_token_amount: '0',
      },
      updated_at: new Date().toISOString(),
    })
    .eq('id', tracker.id)

  const entryAt =
    typeof sim.simulation_started_at === 'string' ? sim.simulation_started_at : null
  const exitAt = new Date().toISOString()
  const entryMcap =
    (typeof sim.entry_market_cap === 'number' ? sim.entry_market_cap : null) ??
    (typeof tracker.market_cap === 'number' ? tracker.market_cap : null)

  const existingMonitors = Array.isArray(sim.monitor_snapshots)
    ? (sim.monitor_snapshots as import('@/strategies/entry-feature-snapshot').MonitorSnapshot[])
    : []
  const clippedHistory =
    entryAt != null
      ? priceHistoryToMonitorSnapshots(
          filterPointsToWindow(parsePriceHistory(tracker.price_history), entryAt, exitAt),
          entryAt,
          exitAt,
        )
      : []
  const monitorSnapshots = mergeMonitorSnapshots(existingMonitors, clippedHistory)

  const buyFeatures =
    sim.entry_features && typeof sim.entry_features === 'object'
      ? (sim.entry_features as Record<string, unknown>)
      : {}

  const closeEntryFeatures = await buildFullEntryFeatureSnapshot(
    params.tokenAddress,
    {
      entryAt,
      firstSeenAt:
        typeof tracker.created_at === 'string' ? tracker.created_at : entryAt,
      entryMcap,
      organicScore:
        typeof tracker.organic_score === 'number' ? tracker.organic_score : null,
      volume5m: typeof tracker.volume_5m === 'number' ? tracker.volume_5m : null,
      tokenSymbol: params.tokenSymbol,
      monitorSnapshots,
    },
  )

  await recordTrendingBotOutcome({
    strategyId: params.strategyId,
    tokenAddress: params.tokenAddress,
    entryAt,
    exitAt,
    pnlPct: gainPct,
    status: finalStatus,
    isSimulated: params.isSimulated,
    features: {
      close_reason: params.closeReason,
      is_simulated: params.isSimulated,
      sell_percentage: params.sellPercentage,
      initial_price_usd: params.initialPriceUsd,
      exit_price_usd: params.currentPriceUsd,
      ...mergeEntryFeaturesForOutcome(buyFeatures, closeEntryFeatures),
    },
  })
}
