import { NextRequest, NextResponse } from 'next/server'
import { discoverAndGateGmgnCandidates } from '@/strategies/gmgn-pipeline'
import { getActiveGmgnForSim } from '@/strategies/load-gmgn'
import { mergeEntryFeaturesForOutcome } from '@/strategies/entry-feature-snapshot'
import {
  buildFullEntryFeatureSnapshot,
  ensureCompleteBuyFeaturesForOutcome,
} from '@/strategies/resolve-entry-snapshot'
import { recordGmgnOutcome } from '@/strategies/outcomes'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import { fetchTokenPricesForTracking } from '@/utils/trading-tracker'
import { getSolPriceUSD } from '@/utils/solana'
import { log } from '@/utils/unified-logger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import { checkGmgnLiveBoostForOpenPosition } from '@/strategies/gmgn-live-boost'
import type { GmgnStrategy } from '@/strategies/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GMGN_SIM_WALLET =
  process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim'

function getSimTrackSecret(): string {
  return (
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

/** GMGN top_10_holder_rate is often 0..1; canonical features use percent. */
function gmgnTopHoldersToPct(rate: number | null): number | null {
  if (rate == null) return null
  if (rate >= 0 && rate <= 1) return rate * 100
  return rate
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
      const sim = (buyRecord?.trading_simulation ?? {}) as Record<string, unknown>
      const entryPriceUsd =
        typeof sim.entry_price_usd === 'number'
          ? sim.entry_price_usd
          : cycle.weightedBuyPriceUsd

      open.push({
        mintAddress: t.mintAddress,
        symbol: t.symbol ?? t.mintAddress.slice(0, 8),
        entryAt: typeof sim.entry_at === 'string' ? sim.entry_at : null,
        entryPriceUsd,
        entryFeatures:
          sim.entry_features && typeof sim.entry_features === 'object'
            ? (sim.entry_features as Record<string, unknown>)
            : {},
      })
    }
  }

  return open
}

function collectRecentMints(
  records: Awaited<ReturnType<typeof fetchTradingRecordsForWallet>>,
  strategyId: string,
  cooldownHours: number,
): Set<string> {
  const cutoff = Date.now() - cooldownHours * 60 * 60 * 1000
  const recent = new Set<string>()

  for (const r of records) {
    if (!r.is_simulation || r.bot_strategy !== strategyId) continue
    const ts = r.timestamp ? new Date(r.timestamp).getTime() : 0
    if (ts < cutoff) continue
    for (const t of r.tokens ?? []) {
      if (t.mintAddress) recent.add(t.mintAddress)
    }
  }

  return recent
}

function shouldClosePosition(params: {
  entryPriceUsd: number
  currentPriceUsd: number
  entryAt: string | null
  exit: GmgnStrategy['config']['exit']
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
  const records = await fetchTradingRecordsForWallet(GMGN_SIM_WALLET)
  const cycle = computeOpenSimCycle(records, params.mintAddress)
  if (!cycle) return 0

  const prices = await fetchTokenPricesForTracking([params.mintAddress])
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
    walletAddress: GMGN_SIM_WALLET,
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
    signatures: [`gmgn-sim-close-${Date.now()}`],
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
      typeof params.entryFeatures.gmgn_price_usd === 'number'
        ? params.entryFeatures.gmgn_price_usd
        : cycle.weightedBuyPriceUsd,
  }

  const completeFeatures = await ensureCompleteBuyFeaturesForOutcome({
    mintAddress: params.mintAddress,
    buyFeatures: params.entryFeatures,
    overrides: {
      entryAt: params.entryAt,
      tokenSymbol: params.symbol,
      entryMcap: readFiniteNumber(params.entryFeatures.gmgn_market_cap_usd),
      topHoldersPct: gmgnTopHoldersToPct(
        readFiniteNumber(params.entryFeatures.gmgn_top_10_holder_rate),
      ),
    },
    domain: 'gmgn',
    extra: closeExtras,
  })

  await recordGmgnOutcome({
    strategyId: params.strategyId,
    tokenAddress: params.mintAddress,
    entryAt: params.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: true,
    features: mergeEntryFeaturesForOutcome(completeFeatures ?? params.entryFeatures, closeExtras),
  })

  return pnlPct
}

async function openSimPosition(params: {
  strategy: GmgnStrategy
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
  const entryMcap = readFiniteNumber(params.entryFeatures.gmgn_market_cap_usd)
  const topHoldersPct = gmgnTopHoldersToPct(
    readFiniteNumber(params.entryFeatures.gmgn_top_10_holder_rate),
  )

  const fullFeatures = await buildFullEntryFeatureSnapshot(
    params.mintAddress,
    {
      entryAt,
      entryMcap,
      topHoldersPct,
      tokenSymbol: params.symbol,
    },
    params.entryFeatures,
  )

  const record = buildTradingRecord({
    walletAddress: GMGN_SIM_WALLET,
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
    signatures: [`gmgn-sim-open-${Date.now()}`],
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
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const strategies = await getActiveGmgnForSim()
    const records = await fetchTradingRecordsForWallet(GMGN_SIM_WALLET)
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
      const cooldownHours = strategy.config.discovery.cooldownHours ?? 24
      const recentMints = collectRecentMints(records, strategy.id, cooldownHours)

      const mintsToPrice = openPositions.map((p) => p.mintAddress)
      const prices =
        mintsToPrice.length > 0
          ? await fetchTokenPricesForTracking(mintsToPrice)
          : ({} as Record<string, number>)

      for (const pos of openPositions) {
        await checkGmgnLiveBoostForOpenPosition({
          walletAddress: GMGN_SIM_WALLET,
          strategyId: strategy.id,
          mintAddress: pos.mintAddress,
          entryAt: pos.entryAt,
          symbol: pos.symbol,
        })

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
        }
      }

      const { discovered, eligible, skipped } = await discoverAndGateGmgnCandidates({
        strategy,
        openMints: openMintSet,
        recentMints,
      })

      const refreshedRecords = await fetchTradingRecordsForWallet(GMGN_SIM_WALLET)
      const currentOpen = getOpenPositionsForStrategy(refreshedRecords, strategy.id).length
      const maxOpen = strategy.config.execution.maxOpenPositions

      for (const candidate of eligible) {
        if (openMintSet.has(candidate.tokenAddress)) continue
        if (currentOpen + opened >= maxOpen) {
          skipped.push('max positions reached')
          break
        }

        const entryPriceUsd =
          typeof candidate.entryFeatures.gmgn_price_usd === 'number'
            ? candidate.entryFeatures.gmgn_price_usd
            : candidate.tradeUsd > 0
              ? candidate.tradeUsd / 1000
              : 0.000001

        await openSimPosition({
          strategy,
          mintAddress: candidate.tokenAddress,
          symbol: candidate.symbol,
          entryFeatures: candidate.entryFeatures,
          entryPriceUsd,
        })

        opened++
        openMintSet.add(candidate.tokenAddress)
      }

      results.push({
        strategyId: strategy.id,
        discovered,
        opened,
        closed,
        skipped,
      })

      log.info('api_request', 'GMGN sim track cycle', {
        strategy: strategy.id,
        discovered,
        opened,
        closed,
        skipped: skipped.length,
      })
    }

    return NextResponse.json({ success: true, results })
  } catch (error) {
    log.error('error_handling', 'GMGN sim track failed', error as Error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
