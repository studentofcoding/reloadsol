import { NextRequest, NextResponse } from 'next/server'
import { getActiveSocialForSim } from '@/strategies/load-social'
import { mergeEntryFeaturesForOutcome } from '@/strategies/entry-feature-snapshot'
import {
  buildFullEntryFeatureSnapshot,
  ensureCompleteBuyFeaturesForOutcome,
} from '@/strategies/resolve-entry-snapshot'
import { recordSocialOutcome } from '@/strategies/outcomes'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecord, insertTradingRecords } from '@/utils/trading-records-db'
import type { TrackingRecord } from '@/utils/trading-tracker'
import { fetchTokenPricesForTracking } from '@/utils/trading-tracker'
import { getOpenPositionPrices } from '@/utils/open-position-prices'
import { getSolPriceUSD } from '@/utils/solana'
import { log } from '@/utils/unified-logger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import {
  fetchFomoRollupCandidates,
  filterSocialOnlyCandidates,
  loadMintsPresentElsewhere,
  loadMintsWithRequiredMentionSources,
  loadSocialClosedMints,
  requiredMentionSources,
} from '@/strategies/social/social-only-discovery'
import type { SocialStrategy } from '@/strategies/types'
import {
  getOpenStrategySimPositions as getOpenPositionsForStrategy,
  shouldClosePriceSimPosition as shouldClosePosition,
  type StrategySimOpenPosition as OpenPosition,
} from '@/strategies/open-strategy-sim-positions'

export const maxDuration = 120

export const SOCIAL_SIM_WALLET =
  process.env.SOCIAL_SIM_WALLET_ADDRESS || 'social-sim'

function getSimTrackSecret(): string {
  return (
    process.env.SOCIAL_SIM_TRACK_SECRET ||
    process.env.GMGN_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

/** Social strategies are Solana-only today (registry `chain: 'sol'`). */
const SOCIAL_CHAIN = 'sol' as const

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

async function closeSimPosition(params: {
  strategyId: string
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryFeatures: Record<string, unknown>
  closeReason: string
  /** Wallet records already loaded by the cycle (avoids one fetch per close). */
  records: TrackingRecord[]
  /** Current price already batched by the cycle. */
  currentPriceUsd: number | undefined
  /** Close records are collected and bulk-inserted by the route. */
  collect: (record: TrackingRecord) => void
}): Promise<number> {
  const cycle = computeOpenSimCycle(params.records, params.mintAddress)
  if (!cycle) return 0

  const sellPriceUsd = params.currentPriceUsd || cycle.weightedBuyPriceUsd
  const solPrice = await getSolPriceUSD()
  const remaining = cycle.remainingTokenAmount
  const solReceived =
    sellPriceUsd && solPrice > 0
      ? (remaining * sellPriceUsd) / solPrice
      : cycle.totalSolBought

  const pnlPct =
    cycle.totalSolBought > 0
      ? ((solReceived - cycle.totalSolBought) / cycle.totalSolBought) * 100
      : 0

  const record = buildTradingRecord({
    walletAddress: SOCIAL_SIM_WALLET,
    operationType: 'sell',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: params.strategyId,
    close_position: true,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount: remaining,
        solAmount: solReceived,
        priceUsd: sellPriceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: solReceived,
    feesPaid: 0,
    solPriceUsd: solPrice,
    signatures: [`social-sim-close-${Date.now()}`],
    status: pnlPct >= 0 ? 'won' : 'lost',
    trading_simulation: {
      close_reason: params.closeReason,
    },
  })

  params.collect(record)

  const closeExtras = {
    token_symbol: params.symbol,
    exit_price_usd: sellPriceUsd,
    close_reason: params.closeReason,
    sol_spent: cycle.totalSolBought,
    sol_received: solReceived,
    initial_price_usd:
      readFiniteNumber(params.entryFeatures.initial_price_usd) ??
      cycle.weightedBuyPriceUsd,
  }

  const completeFeatures = await ensureCompleteBuyFeaturesForOutcome({
    mintAddress: params.mintAddress,
    buyFeatures: params.entryFeatures,
    overrides: {
      entryAt: params.entryAt,
      tokenSymbol: params.symbol,
    },
    domain: 'social',
    extra: closeExtras,
  })

  await recordSocialOutcome({
    strategyId: params.strategyId,
    tokenAddress: params.mintAddress,
    entryAt: params.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: true,
    features: mergeEntryFeaturesForOutcome(
      completeFeatures ?? params.entryFeatures,
      closeExtras,
    ),
  })

  return pnlPct
}

async function openSimPosition(params: {
  strategy: SocialStrategy
  mintAddress: string
  symbol: string
  entryFeatures: Record<string, unknown>
  entryPriceUsd: number
}): Promise<void> {
  const solAmount = params.strategy.config.execution.simBuySol
  const solPrice = await getSolPriceUSD()
  const priceUsd = params.entryPriceUsd > 0 ? params.entryPriceUsd : 0.000001
  const tokenAmount =
    priceUsd > 0 && solPrice > 0 ? (solAmount * solPrice) / priceUsd : solAmount * 1_000_000

  const entryAt = new Date().toISOString()

  const fullFeatures = await buildFullEntryFeatureSnapshot(
    params.mintAddress,
    {
      entryAt,
      tokenSymbol: params.symbol,
    },
    params.entryFeatures,
  )

  const record = buildTradingRecord({
    walletAddress: SOCIAL_SIM_WALLET,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: params.strategy.id,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount,
        solAmount,
        priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    signatures: [`social-sim-open-${Date.now()}`],
    status: 'tracking',
    trading_simulation: {
      entry_at: entryAt,
      entry_price_usd: priceUsd,
      entry_features: {
        ...fullFeatures,
        entry_at: entryAt,
        initial_price_usd: priceUsd,
        token_symbol: params.symbol,
      },
    },
  })

  await insertTradingRecord(record)

  const { notifyStrategyOpen } = await import('@/strategies/strategy-telegram-notify')
  notifyStrategyOpen({
    domain: 'social',
    strategyId: params.strategy.id,
    tokenSymbol: params.symbol,
    tokenAddress: params.mintAddress,
    isSimulated: true,
    features: fullFeatures,
  })
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const { withJobLock } = await import('@/utils/bot-job-lock')
  return withJobLock('social_sim_track', 300, () => runSimTrack(request))
}

async function runSimTrack(request: NextRequest) {

  try {
    const strategies = await getActiveSocialForSim()
    const records = await fetchTradingRecordsForWallet(SOCIAL_SIM_WALLET)
    const results: Array<{
      strategyId: string
      discovered: number
      opened: number
      closed: number
      skipped: string[]
    }> = []

    for (const strategy of strategies) {
      let opened = 0
      let closed = 0
      const openPositions = getOpenPositionsForStrategy(records, strategy.id)
      const openMintSet = new Set(openPositions.map((p) => p.mintAddress))
      const closedMints = new Set<string>()

      const mintsToPrice = openPositions.map((p) => p.mintAddress)
      const prices =
        mintsToPrice.length > 0
          ? await getOpenPositionPrices(mintsToPrice, SOCIAL_CHAIN)
          : ({} as Record<string, number>)

      const pendingCloses: TrackingRecord[] = []
      for (const pos of openPositions) {
        const currentPrice = prices[pos.mintAddress] ?? pos.entryPriceUsd
        const { close, reason } = shouldClosePosition({
          entryPriceUsd: pos.entryPriceUsd,
          currentPriceUsd: currentPrice,
          entryAt: pos.entryAt,
          exit: strategy.config.exit,
        })
        if (close) {
          await closeSimPosition({
            strategyId: strategy.id,
            mintAddress: pos.mintAddress,
            symbol: pos.symbol,
            entryAt: pos.entryAt,
            entryFeatures: pos.entryFeatures,
            closeReason: reason,
            records,
            currentPriceUsd: prices[pos.mintAddress],
            collect: (r) => pendingCloses.push(r),
          })
          closed++
          openMintSet.delete(pos.mintAddress)
          closedMints.add(pos.mintAddress)
        }
      }
      if (pendingCloses.length > 0) await insertTradingRecords(pendingCloses)

      const rollups = await fetchFomoRollupCandidates(strategy.config.entry, 100)
      const candidateMints = rollups.map((r) => r.token_address)
      const requireSources = requiredMentionSources(strategy.config.entry)
      const [presentElsewhere, priorClosed, requiredMentionMints] = await Promise.all([
        loadMintsPresentElsewhere(candidateMints),
        loadSocialClosedMints(strategy.id, candidateMints),
        loadMintsWithRequiredMentionSources(requireSources, candidateMints),
      ])
      priorClosed.forEach((mint) => closedMints.add(mint))

      const { eligible, skipped } = filterSocialOnlyCandidates({
        rollups,
        entry: strategy.config.entry,
        presentElsewhere,
        openMints: openMintSet,
        closedMints,
        requiredMentionMints,
      })

      const refreshedRecords = await fetchTradingRecordsForWallet(SOCIAL_SIM_WALLET)
      const currentOpen = getOpenPositionsForStrategy(refreshedRecords, strategy.id).length
      const maxOpen = strategy.config.execution.maxOpenPositions

      const openPrices =
        eligible.length > 0
          ? await fetchTokenPricesForTracking(eligible.map((c) => c.tokenAddress))
          : ({} as Record<string, number>)

      for (const candidate of eligible) {
        if (openMintSet.has(candidate.tokenAddress)) continue
        if (currentOpen + opened >= maxOpen) {
          skipped.push('max positions reached')
          break
        }

        const entryPriceUsd = openPrices[candidate.tokenAddress] || 0.000001
        const symbol = candidate.tokenAddress.slice(0, 8)

        await openSimPosition({
          strategy,
          mintAddress: candidate.tokenAddress,
          symbol,
          entryFeatures: {
            mention_count_30m: candidate.mentionCount30m,
            telegram_mention_count_30m: candidate.mentionCount30m,
            telegram_top_source: candidate.topSource,
            top_source: candidate.topSource,
            social_entry: 'social_only_fomo',
          },
          entryPriceUsd,
        })

        opened++
        openMintSet.add(candidate.tokenAddress)
      }

      results.push({
        strategyId: strategy.id,
        discovered: rollups.length,
        opened,
        closed,
        skipped,
      })

      log.info('api_request', 'Social sim track cycle', {
        strategy: strategy.id,
        discovered: rollups.length,
        opened,
        closed,
        skipped: skipped.length,
      })
    }

    return NextResponse.json({ success: true, results })
  } catch (error) {
    log.error('error_handling', 'Social sim track failed', error as Error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
