import { NextRequest, NextResponse } from 'next/server'
import { getActiveSignalsForSim } from '@/strategies/load-signals'
import { openSignalsSimPosition, SIGNALS_SIM_WALLET } from '@/strategies/telegram-alpha-sim'
import { scoreSignalsForStrategy } from '@/strategies/signals-pipeline'
import { recordSignalsOutcome } from '@/strategies/outcomes'
import { mergeEntryFeaturesForOutcome } from '@/strategies/entry-feature-snapshot'
import {
  buildFullEntryFeatureSnapshot,
  ensureCompleteBuyFeaturesForOutcome,
} from '@/strategies/resolve-entry-snapshot'
import { annotateEntryFeatures, getSocialContext } from '@/strategies/social/context'
import { appendSimPositionMonitorSnapshot, resolveTokenMonitorSnapshot } from '@/strategies/sim-monitor-snapshots'
import { checkGmgnLiveBoostForOpenPosition } from '@/strategies/gmgn-live-boost'
import { fetchTradingRecordsForWallet } from '@/strategies/db'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecords } from '@/utils/trading-records-db'
import type { TrackingRecord } from '@/utils/trading-tracker'
import { getOpenPositionPrices } from '@/utils/open-position-prices'
import { getNativeUsd } from '@/utils/native-usd'
import { computeMcapSimPnlPct } from '@/utils/mcap-tracker'
import { log } from '@/utils/unified-logger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import { simWalletForChain } from '@/strategies/sim-wallets'
import {
  getOpenStrategySimPositions as getOpenPositionsForStrategy,
  type StrategySimOpenPosition as OpenPosition,
} from '@/strategies/open-strategy-sim-positions'
import { STRATEGY_CHAINS, type StrategyChain } from '@/strategies/types'

export const maxDuration = 120

const SIGNALS_SIM_WALLET_LOCAL = SIGNALS_SIM_WALLET

function getSimTrackSecret(): string {
  return (
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

async function closeSimPosition(params: {
  strategyId: string
  chain: StrategyChain
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryFeatures: Record<string, unknown>
  exitMcap?: number | null
  exitGrowthPercent?: number | null
  /** REL-20: records are collected and bulk-inserted by the route per phase. */
  collect: (record: TrackingRecord) => void
}): Promise<number> {
  const simWallet = simWalletForChain(SIGNALS_SIM_WALLET_LOCAL, params.chain)
  const records = await fetchTradingRecordsForWallet(simWallet)
  const cycle = computeOpenSimCycle(records, params.mintAddress)
  if (!cycle) return 0

  const prices = await getOpenPositionPrices([params.mintAddress], params.chain)
  const sellPriceUsd = prices[params.mintAddress] || cycle.weightedBuyPriceUsd
  const solPrice = await getNativeUsd(params.chain)
  const remaining = cycle.remainingTokenAmount
  const solReceived =
    sellPriceUsd && solPrice > 0
      ? (remaining * sellPriceUsd) / solPrice
      : cycle.totalSolBought

  const firstMcap =
    typeof params.entryFeatures.first_mcap === 'number'
      ? params.entryFeatures.first_mcap
      : typeof params.entryFeatures.entry_mcap === 'number'
        ? params.entryFeatures.entry_mcap
        : null
  const exitMcap = params.exitMcap ?? null

  // ponytail: signals strategies exit on mcap milestones — price PnL on rugged tokens lied (0% WR)
  let pnlPct: number
  if (firstMcap != null && firstMcap > 0 && exitMcap != null && exitMcap > 0) {
    pnlPct = computeMcapSimPnlPct(firstMcap, exitMcap)
  } else {
    pnlPct =
      cycle.totalSolBought > 0
        ? ((solReceived - cycle.totalSolBought) / cycle.totalSolBought) * 100
        : 0
  }

  const record = buildTradingRecord({
    walletAddress: simWallet,
    chain: params.chain,
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
    signatures: [`signals-sim-close-${Date.now()}`],
    status: pnlPct >= 0 ? 'won' : 'lost',
  })

  params.collect(record)

  const buyRecord = [...records]
    .reverse()
    .find(
      (rec) =>
        rec.operationType === 'buy' &&
        rec.bot_strategy === params.strategyId &&
        rec.tokens?.some((t) => t.mintAddress === params.mintAddress),
    )
  const buyFeaturesRaw =
    buyRecord?.trading_simulation &&
    typeof buyRecord.trading_simulation === 'object' &&
    buyRecord.trading_simulation.entry_features &&
    typeof buyRecord.trading_simulation.entry_features === 'object'
      ? (buyRecord.trading_simulation.entry_features as Record<string, unknown>)
      : params.entryFeatures

  const firstSeenAt =
    typeof buyFeaturesRaw.first_seen_at === 'string'
      ? buyFeaturesRaw.first_seen_at
      : null
  const entryMcapHint =
    typeof buyFeaturesRaw.entry_mcap === 'number'
      ? buyFeaturesRaw.entry_mcap
      : typeof buyFeaturesRaw.first_mcap === 'number'
        ? buyFeaturesRaw.first_mcap
        : firstMcap

  const buyFeatures =
    (await ensureCompleteBuyFeaturesForOutcome({
      mintAddress: params.mintAddress,
      buyFeatures: buyFeaturesRaw,
      domain: 'signals',
      overrides: {
        entryAt: params.entryAt,
        firstSeenAt,
        entryMcap: entryMcapHint,
        tokenSymbol: params.symbol,
      },
    })) ?? buyFeaturesRaw

  await recordSignalsOutcome({
    strategyId: params.strategyId,
    chain: params.chain,
    tokenAddress: params.mintAddress,
    entryAt: params.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: true,
    features: mergeEntryFeaturesForOutcome(buyFeatures, {
      ...params.entryFeatures,
      token_symbol: params.symbol,
      exit_price_usd: sellPriceUsd,
      exit_mcap: exitMcap,
      mcap_growth_at_exit: params.exitGrowthPercent ?? null,
      pnl_basis: firstMcap != null && exitMcap != null ? 'mcap' : 'price',
      initial_price_usd:
        typeof buyFeatures.initial_price_usd === 'number'
          ? buyFeatures.initial_price_usd
          : cycle.weightedBuyPriceUsd,
      sol_spent: cycle.totalSolBought,
      sol_received: solReceived,
    }),
  })

  return pnlPct
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const { withJobLock } = await import('@/utils/bot-job-lock')
  return withJobLock('signals_sim_track', 300, () => runSimTrack(request))
}

async function runSimTrack(request: NextRequest) {

  try {
    const results: Array<{
      strategyId: string
      chain: StrategyChain
      opened: number
      closed: number
      skipped: string[]
    }> = []

    for (const chain of STRATEGY_CHAINS) {
    const strategies = await getActiveSignalsForSim(chain)
    if (strategies.length === 0) continue
    const simWallet = simWalletForChain(SIGNALS_SIM_WALLET_LOCAL, chain)
    const records = await fetchTradingRecordsForWallet(simWallet)

    for (const strategy of strategies) {
      const openPositions = getOpenPositionsForStrategy(records, strategy.id)
      const openMintSet = new Set(openPositions.map((p) => p.mintAddress))
      let opened = 0
      let closed = 0
      const skipped: string[] = []

      // REL-20: collect this strategy's trading-record writes and flush once
      // per phase (UNNEST bulk insert) instead of one insert per position.
      // Close-phase writes MUST flush before records are re-fetched below.
      let pendingRecords: TrackingRecord[] = []
      const collect = (record: TrackingRecord) => {
        pendingRecords.push(record)
      }
      const flushPending = async (phase: 'close' | 'open'): Promise<void> => {
        if (pendingRecords.length === 0) return
        const batch = pendingRecords
        pendingRecords = []
        const startedAt = Date.now()
        const res = await insertTradingRecords(batch)
        log.info('mcap_tracker', 'REL-20 batched trading-record writes', {
          strategyId: strategy.id,
          chain,
          phase,
          inserted: res.inserted,
          skipped: res.skipped,
          statements: res.stats.chunks,
          ms: Date.now() - startedAt,
          replacedRoundTrips: res.inserted,
        })
      }

      const scored = await scoreSignalsForStrategy(strategy, { chain })
      const scoredByMint = new Map(scored.map((s) => [s.token_address, s]))

      for (const pos of openPositions) {
        await appendSimPositionMonitorSnapshot({
          records,
          strategyId: strategy.id,
          mintAddress: pos.mintAddress,
          marketCap:
            typeof pos.entryFeatures.entry_mcap === 'number'
              ? pos.entryFeatures.entry_mcap
              : null,
        })

        await checkGmgnLiveBoostForOpenPosition({
          walletAddress: simWallet,
          strategyId: strategy.id,
          mintAddress: pos.mintAddress,
          entryAt: pos.entryAt,
          symbol: pos.symbol,
        })

        const signal = scoredByMint.get(pos.mintAddress)
        const decision = signal?.decision ?? 'hold'
        if (decision === 'exit') {
          await closeSimPosition({
            strategyId: strategy.id,
            chain,
            mintAddress: pos.mintAddress,
            symbol: signal?.token_symbol || pos.symbol,
            entryAt: pos.entryAt,
            entryFeatures: pos.entryFeatures,
            exitMcap: signal?.current_mcap ?? null,
            exitGrowthPercent: signal?.mcap_growth_percent ?? null,
            collect,
          })
          closed++
          openMintSet.delete(pos.mintAddress)
        }
      }

      // REL-20: flush close-phase writes before re-fetching records
      await flushPending('close')

      const refreshedRecords = await fetchTradingRecordsForWallet(simWallet)
      const currentOpen = getOpenPositionsForStrategy(refreshedRecords, strategy.id).length
      const maxOpen = strategy.config.execution.maxOpenPositions

      // Batch prices (chain-aware) + social context once per cycle instead of per candidate.
      const enterCandidates = scored.filter(
        (s) => s.decision === 'enter' && !openMintSet.has(s.token_address),
      )
      const enterMints = enterCandidates.slice(0, Math.max(0, maxOpen - currentOpen)).map((s) => s.token_address)
      const [entryPrices, socialCtxList] = await Promise.all([
        enterMints.length > 0 ? getOpenPositionPrices(enterMints, chain) : ({} as Record<string, number>),
        Promise.all(enterMints.map((m) => getSocialContext(m))),
      ])
      const socialCtxByMint = new Map(enterMints.map((m, i) => [m, socialCtxList[i]]))

      for (const signal of enterCandidates) {
        if (currentOpen + opened >= maxOpen) {
          skipped.push(`${signal.token_symbol}: max positions`)
          break
        }

        const priceUsd = entryPrices[signal.token_address] || 0.000001
        const liveMetrics = await resolveTokenMonitorSnapshot(
          signal.token_address,
          signal.current_mcap,
        )
        if (liveMetrics.price_usd == null && priceUsd > 0) {
          liveMetrics.price_usd = priceUsd
        }

        const socialCtx =
          socialCtxByMint.get(signal.token_address) ?? (await getSocialContext(signal.token_address))

        const symbol =
          signal.token_symbol?.trim() ||
          signal.token_address.slice(0, 8)

        const entryAt = new Date().toISOString()
        const baseFeatures = await buildFullEntryFeatureSnapshot(
          signal.token_address,
          {
            entryAt,
            firstSeenAt: signal.first_seen_at,
            entryMcap: signal.current_mcap,
            tokenSymbol: symbol,
            volume5m: liveMetrics.volume_5m,
            monitorSnapshots:
              liveMetrics.volume_5m != null || liveMetrics.price_usd != null
                ? [liveMetrics]
                : [],
            social: socialCtx.snapshot,
          },
          {
            score: signal.score,
            decision: signal.decision,
            growth: signal.mcap_growth_percent,
            first_mcap: signal.first_mcap,
            recency_minutes: signal.trend_age_minutes,
            rationale: signal.rationale,
            social_boost: signal.socialBoost ?? 0,
            initial_price_usd: priceUsd,
          },
        )
        const annotated = annotateEntryFeatures(baseFeatures, socialCtx)
        const { attachOhlcRugShadow } = await import('@/strategies/ohlc-rug-shadow')
        const ohlc = await attachOhlcRugShadow(signal.token_address, annotated, {
          enforce: false,
        })
        const { attachMlEntryShadow } = await import('@/strategies/ml-entry-shadow')
        const ml = await attachMlEntryShadow(ohlc.features, { enforce: false })

        // Phase B: stamp exit-overlay audit only — signals exits stay scoring-driven
        const { signalsToCanonical } = await import('@/strategies/canonical-params')
        const { resolveExitOverlayForOpen } = await import(
          '@/strategies/potential-exit-overlay'
        )
        const overlayResult = await resolveExitOverlayForOpen({
          baseExit: signalsToCanonical(strategy).exit,
          features: ml.features,
          mintAddress: signal.token_address,
          strategyId: strategy.id,
          persistEffectiveExit: false,
        })
        const { softMlSize, stampMlSize } = await import('@/strategies/ml-soft-size')
        const baseSol =
          strategy.config.execution.simBuyNative ?? strategy.config.execution.simBuySol
        const sized = softMlSize(baseSol, { pBad: ml.pBad })

        await openSignalsSimPosition({
          strategyId: strategy.id,
          chain,
          mintAddress: signal.token_address,
          symbol,
          solAmount: sized.sol,
          priceUsd,
          entryFeatures: stampMlSize(overlayResult.features, sized, {
            pBad: ml.pBad,
            pWinner: ml.pWinner,
          }),
          collect,
        })
        opened++
        openMintSet.add(signal.token_address)
      }

      // REL-20: flush open-phase writes before the next strategy is processed
      await flushPending('open')

      results.push({ strategyId: strategy.id, chain, opened, closed, skipped })
    }
    }

    log.info('mcap_tracker', 'Sim track cycle complete', { results })

    return NextResponse.json({ success: true, wallet: SIGNALS_SIM_WALLET_LOCAL, results })
  } catch (error) {
    log.error('error_handling', 'Sim track failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
