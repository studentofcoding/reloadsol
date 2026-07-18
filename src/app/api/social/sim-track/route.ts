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
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
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

export const dynamic = 'force-dynamic'
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

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

type OpenPosition = {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryPriceUsd: number
  entryFeatures: Record<string, unknown>
}

function getOpenPositionsForStrategy(
  records: Awaited<ReturnType<typeof fetchTradingRecordsForWallet>>,
  strategyId: string,
): OpenPosition[] {
  const seen = new Set<string>()
  const open: OpenPosition[] = []

  for (const r of records) {
    if (!r.is_simulation || r.bot_strategy !== strategyId) continue
    for (const t of r.tokens ?? []) {
      if (seen.has(t.mintAddress)) continue
      const cycle = computeOpenSimCycle(records, t.mintAddress)
      if (!cycle || cycle.simulationType !== 'strategy') continue
      seen.add(t.mintAddress)

      const buyRecord = records.find(
        (rec) =>
          rec.operationType === 'buy' &&
          rec.bot_strategy === strategyId &&
          rec.is_simulation &&
          rec.tokens?.some((tk) => tk.mintAddress === t.mintAddress),
      )
      const sim =
        buyRecord?.trading_simulation &&
        typeof buyRecord.trading_simulation === 'object'
          ? (buyRecord.trading_simulation as Record<string, unknown>)
          : {}
      const entryFeatures =
        sim.entry_features && typeof sim.entry_features === 'object'
          ? (sim.entry_features as Record<string, unknown>)
          : {}
      const entryPriceUsd =
        readFiniteNumber(sim.entry_price_usd) ??
        readFiniteNumber(entryFeatures.initial_price_usd) ??
        cycle.weightedBuyPriceUsd ??
        0

      open.push({
        mintAddress: t.mintAddress,
        symbol: t.symbol || t.mintAddress.slice(0, 8),
        entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
        entryPriceUsd,
        entryFeatures,
      })
    }
  }

  return open
}

function shouldClosePosition(params: {
  entryPriceUsd: number
  currentPriceUsd: number
  entryAt: string | null
  exit: SocialStrategy['config']['exit']
}): { close: boolean; reason: string } {
  const { entryPriceUsd, currentPriceUsd, entryAt, exit } = params
  if (entryPriceUsd <= 0 || currentPriceUsd <= 0) {
    return { close: false, reason: 'missing_price' }
  }

  const pnlPct = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100

  if (pnlPct <= exit.stopLossPct) {
    return { close: true, reason: 'stop_loss' }
  }
  if (pnlPct >= exit.takeProfitPct) {
    return { close: true, reason: 'take_profit' }
  }

  if (entryAt && exit.maxHoldHours > 0) {
    const heldMs = Date.now() - new Date(entryAt).getTime()
    if (heldMs >= exit.maxHoldHours * 60 * 60 * 1000) {
      return { close: true, reason: 'max_hold' }
    }
  }

  return { close: false, reason: 'hold' }
}

async function closeSimPosition(params: {
  strategyId: string
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryFeatures: Record<string, unknown>
  closeReason: string
}): Promise<number> {
  const records = await fetchTradingRecordsForWallet(SOCIAL_SIM_WALLET)
  const cycle = computeOpenSimCycle(records, params.mintAddress)
  if (!cycle) return 0

  const prices = await getOpenPositionPrices([params.mintAddress])
  const sellPriceUsd = prices[params.mintAddress] || cycle.weightedBuyPriceUsd
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

  await insertTradingRecord(record)

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
          ? await getOpenPositionPrices(mintsToPrice)
          : ({} as Record<string, number>)

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
          })
          closed++
          openMintSet.delete(pos.mintAddress)
          closedMints.add(pos.mintAddress)
        }
      }

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
