import { NextRequest, NextResponse } from 'next/server'
import { getActiveSocialForSim } from '@/strategies/load-social'
import { mergeEntryFeaturesForOutcome } from '@/strategies/entry-feature-snapshot'
import {
  createBrainRiskSession,
  resolveSimOpenSize,
  stampBrainRisk,
} from '@/utils/brain-regime-risk'
import {
  buildFullEntryFeatureSnapshot,
  ensureCompleteBuyFeaturesForOutcome,
} from '@/strategies/resolve-entry-snapshot'
import { recordSocialOutcome } from '@/strategies/outcomes'
import { closeOutcomeStatusFromPnl } from '@/strategies/close-outcome-status'
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
  filterSocialOnlyCandidates,
  loadFomoBurstCandidates,
  loadMintsPresentElsewhere,
  loadMintsWithRequiredMentionSources,
  loadSocialClosedMints,
  requiredMentionSources,
} from '@/strategies/social/social-only-discovery'
import type { SocialStrategy } from '@/strategies/types'
import {
  decideMoonbagTrailingExit,
  getOpenStrategySimPositions as getOpenPositionsForStrategy,
  moonbagExitConfig,
  peakGainPctFromFeatures,
  priceGainPct,
  type StrategySimOpenPosition as OpenPosition,
} from '@/strategies/open-strategy-sim-positions'
import { appendSimPositionMonitorSnapshot } from '@/strategies/sim-monitor-snapshots'
import { captureTokenInfoDetectBatch } from '@/strategies/token-info-detect'
import { attachOhlcRugShadow } from '@/strategies/ohlc-rug-shadow'
import { insertDetectSnapshot } from '@/strategies/detect-snapshots'
import {
  evaluateSocialFomoNoul,
  recordSocialFomoNoulShadowRow,
  socialFomoNoulSuppresses,
} from '@/strategies/social/social-fomo-noul-shadow'

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
    status: closeOutcomeStatusFromPnl(pnlPct),
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
    status: closeOutcomeStatusFromPnl(pnlPct),
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
  solAmount: number
  effectiveExit: {
    takeProfitPct: number
    stopLossPct: number
    maxHoldHours: number
  }
}): Promise<void> {
  const solPrice = await getSolPriceUSD()
  const priceUsd = params.entryPriceUsd
  const solAmount = params.solAmount
  const tokenAmount =
    priceUsd > 0 && solPrice > 0 ? (solAmount * solPrice) / priceUsd : 0

  const entryAt = new Date().toISOString()

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
      effective_exit: params.effectiveExit,
      entry_features: {
        ...params.entryFeatures,
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
    features: params.entryFeatures,
  })
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const { withJobLock } = await import('@/utils/bot-job-lock')
  return withJobLock('social_sim_track', 900, () => runSimTrack(request))
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

    // Level 1 market scalar for every strategy — one session per cycle so the recipe/params fetch
    // is shared across candidates, and one code path with mcap/signals/gmgn/trending.
    const brainRiskSession = createBrainRiskSession()

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
        await appendSimPositionMonitorSnapshot({
          records,
          strategyId: strategy.id,
          mintAddress: pos.mintAddress,
        })
        const currentPrice = prices[pos.mintAddress] ?? null
        const exit = pos.effectiveExit ?? strategy.config.exit
        const moonbag = moonbagExitConfig()
        const gainPct = priceGainPct(pos.entryPriceUsd, currentPrice)
        const heldHours = pos.entryAt
          ? (Date.now() - new Date(pos.entryAt).getTime()) / 3_600_000
          : 0
        const { close, reason } =
          gainPct == null
            ? { close: false, reason: 'hold' as const }
            : decideMoonbagTrailingExit({
                exit: { ...exit, maxHoldHours: moonbag.maxHoldHours },
                gainPct,
                peakGainPct: peakGainPctFromFeatures(
                  pos.entryPriceUsd,
                  pos.entryFeatures,
                ),
                heldHours,
                armPct: moonbag.armPct,
                trailPct: moonbag.trailPct,
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

      const rollups = await loadFomoBurstCandidates(strategy.config.entry, {
        chain: SOCIAL_CHAIN,
        limit: 100,
      })
      const burstByMint = new Map(rollups.map((r) => [r.token_address, r]))
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

      await captureTokenInfoDetectBatch(
        eligible.map((candidate) => ({
          chain: SOCIAL_CHAIN,
          tokenAddress: candidate.tokenAddress,
          detectingStrategy: strategy.id,
          source: 'social' as const,
        })),
      )

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

        const rawPrice = openPrices[candidate.tokenAddress]
        const entryPriceUsd =
          typeof rawPrice === 'number' && rawPrice > 0 ? rawPrice : null
        const symbol = candidate.tokenAddress.slice(0, 8)
        const entryAt = new Date().toISOString()

        const fullFeatures = await buildFullEntryFeatureSnapshot(
          candidate.tokenAddress,
          { entryAt, tokenSymbol: symbol },
          {
            mention_count_30m: candidate.mentionCount30m,
            telegram_mention_count_30m: candidate.mentionCount30m,
            telegram_top_source: candidate.topSource,
            top_source: candidate.topSource,
            social_entry: 'social_only_fomo',
          },
        )

        // Resolve the OHLC rug shadow once: it feeds the Noul candle arm, the
        // spine, and its bars are persisted for the close chart.
        const ohlc = await attachOhlcRugShadow(
          candidate.tokenAddress,
          fullFeatures,
          { enforce: true, fallbackOwn1m: true },
        )
        const ohlcFeatures = ohlc.evalResult?.features ?? null

        const burst = burstByMint.get(candidate.tokenAddress)
        const noul = await evaluateSocialFomoNoul({
          chain: SOCIAL_CHAIN,
          mentions30m: candidate.mentionCount30m,
          mentions24h: burst?.mention_count_24h ?? candidate.mentionCount30m,
          uniqueChannels30m: burst?.unique_channel_count_30m ?? 0,
          minutesSinceFirstMention: null,
          fomoBuyCount1h: burst?.fomo_buy_count_1h ?? 0,
          fomoEdge1h: burst?.fomo_edge_1h ?? null,
          mcap: burst?.mcap ?? null,
          firstMcap: burst?.first_mcap ?? null,
          mcapGrowthPct: burst?.mcap_growth_percent ?? null,
          holdersPct: burst?.top_holders_pct ?? null,
          organicScore: burst?.organic_score ?? null,
          ohlcN: ohlcFeatures?.n ?? 0,
          ohlcSource: ohlc.source,
          ohlcDumpPct: ohlcFeatures?.dumpPct ?? null,
          ohlcAvgUpperWick: ohlcFeatures?.avgUpperWick ?? null,
          ohlcUpOnlyCount: ohlcFeatures?.upOnlyCount ?? null,
          ohlcVolDeathRatio: ohlcFeatures?.volDeathRatio ?? null,
          ohlcRugTrip: ohlc.evalResult ? ohlc.evalResult.trip : null,
        })
        await recordSocialFomoNoulShadowRow({
          tokenAddress: candidate.tokenAddress,
          symbol,
          chain: SOCIAL_CHAIN,
          strategyKey: strategy.id,
          mentions30m: candidate.mentionCount30m,
          mentions24h: burst?.mention_count_24h ?? candidate.mentionCount30m,
          uniqueChannels30m: burst?.unique_channel_count_30m ?? 0,
          fomoBuyCount1h: burst?.fomo_buy_count_1h ?? 0,
          fomoEdge1h: burst?.fomo_edge_1h ?? null,
          mcap: burst?.mcap ?? null,
          mcapGrowthPct: burst?.mcap_growth_percent ?? null,
          holdersPct: burst?.top_holders_pct ?? null,
          organicScore: burst?.organic_score ?? null,
          specWouldPass: true,
          noulCalled: noul.called,
          noul: noul.noul,
          band: noul.band,
          decisionShadow: noul.decision,
          mode: noul.mode,
          organicNoul: noul.organic,
          candlesNoul: noul.candles,
          organicBand: noul.organicBand,
          candlesBand: noul.candlesBand,
          ohlcN: ohlcFeatures?.n ?? 0,
          ohlcSource: ohlc.source,
        })
        if (socialFomoNoulSuppresses(noul)) {
          skipped.push(`${symbol}: noul_suppress`)
          continue
        }

        const { prepareTargetMachinePaperOpen } = await import(
          '@/strategies/prepare-target-machine-paper-open'
        )
        const {
          appendSpineDecision,
          spinePassDecision,
          spineSkipDecision,
        } = await import('@/strategies/spine-tick-log')
        const sized = await resolveSimOpenSize({
          session: brainRiskSession,
          strategyId: strategy.id,
          baseSol: strategy.config.execution.simBuySol,
        })
        if (sized.skip) {
          skipped.push(
            `${symbol}: ${sized.risk.standDown ? 'brain_risk_stand_down' : 'brain_risk_zero_size'}`,
          )
          continue
        }

        const spine = await prepareTargetMachinePaperOpen({
          mint: candidate.tokenAddress,
          chain: SOCIAL_CHAIN,
          features: fullFeatures,
          priceUsd: entryPriceUsd,
          baseSol: sized.sol,
          baseExit: strategy.config.exit,
          precomputedOhlc: ohlc,
        })
        if (!spine.ok) {
          skipped.push(`${symbol}: ${spine.reason}`)
          await appendSpineDecision(
            spineSkipDecision(
              'social_sim_track',
              candidate.tokenAddress,
              spine.stage,
              spine.reason,
              symbol,
            ),
          )
          continue
        }

        if (ohlc.bars.length > 0 && ohlc.evalResult) {
          await insertDetectSnapshot({
            tokenAddress: candidate.tokenAddress,
            source: 'social',
            bars: ohlc.bars,
            evalResult: ohlc.evalResult,
          })
        }

        await openSimPosition({
          strategy,
          mintAddress: candidate.tokenAddress,
          symbol,
          // Stamp the applied scalar so the row is auditable on its own, and so a later re-tune can
          // tell whether the risk layer was in the path at all.
          entryFeatures: stampBrainRisk(spine.features, sized.risk, { sizedSol: spine.solAmount }),
          entryPriceUsd: spine.priceUsd,
          solAmount: spine.solAmount,
          effectiveExit: spine.effectiveExit,
        })
        await appendSpineDecision(
          spinePassDecision('social_sim_track', candidate.tokenAddress, symbol, {
            p: spine.p,
            solAmount: spine.solAmount,
            takeProfitPct: spine.effectiveExit.takeProfitPct,
            stopLossPct: spine.effectiveExit.stopLossPct,
          }),
        )

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
