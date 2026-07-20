import { NextRequest, NextResponse } from 'next/server'
import { getActiveMcapTrackerStrategies } from '@/strategies/load-mcap-tracker'
import { recordMcapTrackerOutcome } from '@/strategies/outcomes'
import {
  appendMonitorSnapshot,
  mergeEntryFeaturesForOutcome,
  readMonitorSnapshotsFromFeatures,
} from '@/strategies/entry-feature-snapshot'
import {
  buildFullEntryFeatureSnapshot,
  ensureCompleteBuyFeaturesForOutcome as rebuildIncompleteBuyFeatures,
} from '@/strategies/resolve-entry-snapshot'
import { getMlGatePBadMax } from '@/strategies/entry-ml-scorer'
import { getPatternPWinnerMin } from '@/strategies/entry-pattern-scorer'
import { logMlGateCounterfactual } from '@/strategies/ml-shadow-log'
import { logPatternGateCounterfactual } from '@/strategies/pattern-shadow-log'
import { attachMlEntryShadow } from '@/strategies/ml-entry-shadow'
import { mcapTrackerToCanonical } from '@/strategies/canonical-params'
import { resolveExitOverlayForOpen } from '@/strategies/potential-exit-overlay'
import type { McapTrackerStrategy } from '@/strategies/types'
import {
  annotateEntryFeatures,
  evaluateSocialGateFromContext,
  getSocialContext,
  type SocialContext,
} from '@/strategies/social/context'
import {
  appendSimPositionMonitorSnapshot,
  resolveTokenMonitorSnapshot,
} from '@/strategies/sim-monitor-snapshots'
import { checkGmgnLiveBoostForOpenPosition } from '@/strategies/gmgn-live-boost'
import { fetchTradingRecordsForWallet, loadMcapSimClosedOutcomeKeys } from '@/strategies/db'
import {
  acquireTradeLock,
  isRealTradingHalted,
  releaseTradeLock,
} from '@/utils/bot-trading-state'
import { resolveMcapExecutionMode } from '@/utils/mcap-execution-mode'
import {
  executeMcapRaptorBuy,
  executeMcapRaptorSell,
  getMcapLiveWallet,
  isMcapLiveStrategyAllowed,
  isMcapLiveTradingAvailable,
  RAPTOR_OUTPUT_AMOUNT_RAW_KEY,
  resolveMcapSlippageBps,
} from '@/utils/mcap-raptor-trade'
import { computeOpenTradeCycle } from '@/utils/simulation-trades'
import { buildTradingRecord, insertTradingRecord } from '@/utils/trading-records-db'
import { getSolPriceUSD } from '@/utils/solana'
import { log } from '@/utils/unified-logger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import {
  buildMcapOutcomeFeatures,
  computeMcapSimPnlPct,
  fetchMcapTrackingRow,
  fetchMcapSimCandidateRows,
  getMcapSimCloseReason,
  type McapSnapshot,
} from '@/utils/mcap-tracker'
import {
  getMcapSimOpenSkipReason,
  getOpenMcapPositions,
  resolveMcapSimEntry,
  shouldOpenMcapSim,
  type McapSimOpenPosition,
} from '@/utils/mcap-sim-track'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const MCAP_TRACKER_SIM_WALLET =
  process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim'

function getSimTrackSecret(): string {
  return (
    process.env.MCAP_TRACKER_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

type OpenPosition = McapSimOpenPosition

function getOpenPositionsForStrategy(
  records: Awaited<ReturnType<typeof fetchTradingRecordsForWallet>>,
  strategyId: string,
  isSimulated: boolean,
): OpenPosition[] {
  return getOpenMcapPositions(records, strategyId, isSimulated ? 'sim' : 'live')
}

/**
 * If buy entry_features lack the five ML numerics, rebuild from entry-time snapshot
 * inputs so outcomes remain exportable.
 */
async function ensureCompleteBuyFeaturesForOutcome(params: {
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryMcap: number
  entryTemplate: 'first_seen' | 'milestone_80'
  snapshot: McapSnapshot
  buyFeatures: Record<string, unknown> | null
}): Promise<Record<string, unknown> | null> {
  return rebuildIncompleteBuyFeatures({
    mintAddress: params.mintAddress,
    buyFeatures: params.buyFeatures,
    domain: 'mcap_tracker',
    overrides: {
      entryAt: params.entryAt ?? undefined,
      firstSeenAt: params.snapshot.first_seen_at,
      entryMcap: params.entryMcap,
      organicScore: params.snapshot.organic_score,
      topHoldersPct: params.snapshot.top_holders_pct,
      volume5m: params.snapshot.volume_5m ?? null,
      tokenSymbol: params.symbol,
      skipJupiter:
        params.snapshot.organic_score != null &&
        params.snapshot.top_holders_pct != null,
    },
    extra: {
      entry_template: params.entryTemplate,
      ...buildMcapOutcomeFeatures({
        snapshot: params.snapshot,
        entryTemplate: params.entryTemplate,
        entryMcap: params.entryMcap,
        exitMcap: params.snapshot.current_mcap,
      }),
    },
  })
}

async function openSimPosition(params: {
  strategyId: string
  mintAddress: string
  symbol: string
  solAmount: number
  entryMcap: number
  entryTemplate: 'first_seen' | 'milestone_80'
  entryAt: string
  snapshot: McapSnapshot
  socialCtx?: SocialContext | null
  scoredEntryFeatures?: Record<string, unknown> | null
  strategy: McapTrackerStrategy
}): Promise<void> {
  const solPrice = await getSolPriceUSD()
  const priceUsd = 0.000001
  const tokenAmount =
    priceUsd > 0 && solPrice > 0
      ? (params.solAmount * solPrice) / priceUsd
      : params.solAmount * 1000

  const liveMetrics = await resolveTokenMonitorSnapshot(
    params.mintAddress,
    params.entryMcap,
  )
  const volume5m = params.snapshot.volume_5m ?? liveMetrics.volume_5m
  const socialSnapshot = params.socialCtx?.snapshot ?? null

  let scoredEntryFeatures = params.scoredEntryFeatures
  if (!scoredEntryFeatures) {
    const baseFeatures = await buildFullEntryFeatureSnapshot(
      params.mintAddress,
      {
        entryAt: params.entryAt,
        firstSeenAt: params.snapshot.first_seen_at,
        entryMcap: params.entryMcap,
        organicScore: params.snapshot.organic_score,
        topHoldersPct: params.snapshot.top_holders_pct,
        volume5m,
        tokenSymbol: params.symbol,
        monitorSnapshots:
          volume5m != null || liveMetrics.price_usd != null ? [liveMetrics] : [],
        social: socialSnapshot,
        skipJupiter:
          params.snapshot.organic_score != null &&
          params.snapshot.top_holders_pct != null,
      },
      {
        entry_template: params.entryTemplate,
        ...buildMcapOutcomeFeatures({
          snapshot: params.snapshot,
          entryTemplate: params.entryTemplate,
          entryMcap: params.entryMcap,
          exitMcap: params.snapshot.current_mcap,
        }),
      },
    )
    const annotated = params.socialCtx
      ? annotateEntryFeatures(baseFeatures, params.socialCtx)
      : baseFeatures
    const { attachOhlcRugShadow } = await import('@/strategies/ohlc-rug-shadow')
    const ohlc = await attachOhlcRugShadow(params.mintAddress, annotated, {
      enforce: false,
    })
    const ml = await attachMlEntryShadow(ohlc.features, { enforce: false })
    scoredEntryFeatures = ml.features
  }

  const baseExit = mcapTrackerToCanonical(params.strategy).exit
  const overlayResult = await resolveExitOverlayForOpen({
    baseExit,
    features: scoredEntryFeatures,
    mintAddress: params.mintAddress,
    strategyId: params.strategyId,
    persistEffectiveExit: true,
  })
  scoredEntryFeatures = overlayResult.features

  const record = buildTradingRecord({
    walletAddress: MCAP_TRACKER_SIM_WALLET,
    operationType: 'buy',
    is_simulation: true,
    simulation_type: 'strategy',
    bot_strategy: params.strategyId,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount,
        solAmount: params.solAmount,
        priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: params.solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    totalUsdValue: solPrice ? params.solAmount * solPrice : undefined,
    signatures: [`mcap-tracker-sim-${Date.now()}`],
    status: 'tracking',
    trading_simulation: {
      strategy_id: params.strategyId,
      entry_at: params.entryAt,
      entry_features: scoredEntryFeatures,
      ...(overlayResult.effectiveExit
        ? { effective_exit: overlayResult.effectiveExit }
        : {}),
    },
  })

  await insertTradingRecord(record)

  const {
    isMcapManualTradeStrategy,
    recordSimOpenAlert,
  } = await import('@/strategies/mcap-sim-open-alerts')

  if (isMcapManualTradeStrategy(params.strategyId)) {
    const manualStrategyId = params.strategyId
    const { getStrategyNotifyFlags, resolveStrategyDisplayName } = await import(
      '@/strategies/strategy-telegram-notify'
    )
    const notify = await getStrategyNotifyFlags('mcap_tracker', manualStrategyId)
    if (notify.ui) {
      recordSimOpenAlert({
        strategyId: manualStrategyId,
        tokenAddress: params.mintAddress,
        tokenSymbol: params.symbol,
        entryMcap: params.entryMcap,
        entryAt: params.entryAt,
        entryTemplate: params.entryTemplate,
      })
    }
    if (notify.telegram) {
      const { sendStrategyTrackOpenAlert } = await import('@/utils/telegram')
      const feats = scoredEntryFeatures ?? {}
      const readNum = (...keys: string[]): number | null => {
        for (const key of keys) {
          const v = feats[key]
          if (typeof v === 'number' && Number.isFinite(v)) return v
        }
        return null
      }
      try {
        await sendStrategyTrackOpenAlert({
          strategyId: manualStrategyId,
          strategyName: resolveStrategyDisplayName('mcap_tracker', manualStrategyId),
          domain: 'mcap_tracker',
          tokenSymbol: params.symbol,
          tokenAddress: params.mintAddress,
          marketCap: params.entryMcap,
          isSimulated: true,
          organicScore: params.snapshot.organic_score,
          topHoldersPct: params.snapshot.top_holders_pct,
          sm: readNum('sm', 'sm_count', 'smart_money_count'),
          kol: readNum('kol', 'kol_count'),
        })
      } catch (err) {
        console.error('[mcap-sim-open] telegram alert failed:', err)
      }
    }
  } else {
    const { notifyStrategyOpen } = await import('@/strategies/strategy-telegram-notify')
    notifyStrategyOpen({
      domain: 'mcap_tracker',
      strategyId: params.strategyId,
      tokenSymbol: params.symbol,
      tokenAddress: params.mintAddress,
      marketCap: params.entryMcap,
      isSimulated: true,
      organicScore: params.snapshot.organic_score,
      topHoldersPct: params.snapshot.top_holders_pct,
      features: scoredEntryFeatures,
    })
  }
}

async function closeSimPosition(params: {
  strategyId: string
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryMcap: number
  entryTemplate: 'first_seen' | 'milestone_80'
  snapshot: McapSnapshot
  closeReason: NonNullable<ReturnType<typeof getMcapSimCloseReason>>
}): Promise<number> {
  const records = await fetchTradingRecordsForWallet(MCAP_TRACKER_SIM_WALLET)
  const cycle = computeOpenTradeCycle(records, params.mintAddress, 'sim')
  if (!cycle) return 0

  const exitMcap = params.snapshot.current_mcap
  const pnlPct = computeMcapSimPnlPct(params.entryMcap, exitMcap)
  const solPrice = await getSolPriceUSD()
  const sellPriceUsd = 0.000001
  const remaining = cycle.remainingTokenAmount
  const solReceived =
    sellPriceUsd && solPrice > 0
      ? (remaining * sellPriceUsd) / solPrice
      : cycle.totalSolBought * (1 + pnlPct / 100)

  const record = buildTradingRecord({
    walletAddress: MCAP_TRACKER_SIM_WALLET,
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
    signatures: [`mcap-tracker-sim-close-${Date.now()}`],
    status: pnlPct >= 0 ? 'won' : 'lost',
  })

  await insertTradingRecord(record)

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
      : null
  const buyFeatures = await ensureCompleteBuyFeaturesForOutcome({
    mintAddress: params.mintAddress,
    symbol: params.symbol,
    entryAt: params.entryAt,
    entryMcap: params.entryMcap,
    entryTemplate: params.entryTemplate,
    snapshot: params.snapshot,
    buyFeatures: buyFeaturesRaw,
  })

  const closeFeatures = buildMcapOutcomeFeatures({
    snapshot: params.snapshot,
    entryTemplate: params.entryTemplate,
    entryMcap: params.entryMcap,
    exitMcap,
    closeReason: params.closeReason,
  })
  const monitorSnapshots = appendMonitorSnapshot(
    readMonitorSnapshotsFromFeatures(buyFeatures),
    {
      timestamp: new Date().toISOString(),
      volume_5m: params.snapshot.volume_5m ?? null,
      market_cap: exitMcap,
    },
  )

  await recordMcapTrackerOutcome({
    strategyId: params.strategyId,
    tokenAddress: params.mintAddress,
    entryAt: params.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: true,
    features: mergeEntryFeaturesForOutcome(buyFeatures, {
      ...closeFeatures,
      monitor_snapshots: monitorSnapshots,
    }),
  })

  return pnlPct
}

async function openLivePosition(params: {
  walletAddress: string
  strategyId: string
  mintAddress: string
  symbol: string
  solAmount: number
  slippageBps: number
  entryMcap: number
  entryTemplate: 'first_seen' | 'milestone_80'
  entryAt: string
  snapshot: McapSnapshot
  scoredEntryFeatures?: Record<string, unknown> | null
  strategy: McapTrackerStrategy
}): Promise<void> {
  const buy = await executeMcapRaptorBuy(
    params.mintAddress,
    params.solAmount,
    params.slippageBps,
    params.symbol,
  )

  const solPrice = await getSolPriceUSD()
  const priceUsd =
    buy.tokenAmountUi > 0 && params.solAmount > 0 && solPrice > 0
      ? (params.solAmount * solPrice) / buy.tokenAmountUi
      : 0.000001

  // Live: stamp overlay audit only — never persist effective_exit
  const baseExit = mcapTrackerToCanonical(params.strategy).exit
  const overlayResult = await resolveExitOverlayForOpen({
    baseExit,
    features: params.scoredEntryFeatures ?? {},
    mintAddress: params.mintAddress,
    strategyId: params.strategyId,
    persistEffectiveExit: false,
  })

  const scoredEntryFeatures = {
    ...overlayResult.features,
    [RAPTOR_OUTPUT_AMOUNT_RAW_KEY]: buy.outputAmountRaw,
    raptor_buy_signature: buy.signature,
  }

  const record = buildTradingRecord({
    walletAddress: params.walletAddress,
    operationType: 'buy',
    is_simulation: false,
    simulation_type: 'strategy',
    bot_strategy: params.strategyId,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount: buy.tokenAmountUi,
        solAmount: params.solAmount,
        priceUsd,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: params.solAmount,
    feesPaid: 0,
    solPriceUsd: solPrice,
    totalUsdValue: solPrice ? params.solAmount * solPrice : undefined,
    signatures: [buy.signature],
    status: 'tracking',
    trading_simulation: {
      strategy_id: params.strategyId,
      entry_at: params.entryAt,
      entry_features: scoredEntryFeatures,
    },
  })

  await insertTradingRecord(record)

  const { notifyStrategyOpen } = await import('@/strategies/strategy-telegram-notify')
  notifyStrategyOpen({
    domain: 'mcap_tracker',
    strategyId: params.strategyId,
    tokenSymbol: params.symbol,
    tokenAddress: params.mintAddress,
    marketCap: params.entryMcap,
    isSimulated: false,
    organicScore: params.snapshot.organic_score,
    topHoldersPct: params.snapshot.top_holders_pct,
    features: scoredEntryFeatures,
  })
}

async function closeLivePosition(params: {
  walletAddress: string
  strategyId: string
  mintAddress: string
  symbol: string
  entryAt: string | null
  entryMcap: number
  entryTemplate: 'first_seen' | 'milestone_80'
  snapshot: McapSnapshot
  closeReason: NonNullable<ReturnType<typeof getMcapSimCloseReason>>
  slippageBps: number
}): Promise<number> {
  const records = await fetchTradingRecordsForWallet(params.walletAddress)
  const cycle = computeOpenTradeCycle(records, params.mintAddress, 'live')
  if (!cycle) return 0

  const buyRecord = [...records]
    .reverse()
    .find(
      (rec) =>
        rec.operationType === 'buy' &&
        rec.bot_strategy === params.strategyId &&
        rec.is_simulation === false &&
        rec.tokens?.some((t) => t.mintAddress === params.mintAddress),
    )
  const buyFeatures =
    buyRecord?.trading_simulation &&
    typeof buyRecord.trading_simulation === 'object' &&
    buyRecord.trading_simulation.entry_features &&
    typeof buyRecord.trading_simulation.entry_features === 'object'
      ? (buyRecord.trading_simulation.entry_features as Record<string, unknown>)
      : null

  const amountRaw =
    typeof buyFeatures?.[RAPTOR_OUTPUT_AMOUNT_RAW_KEY] === 'string'
      ? (buyFeatures[RAPTOR_OUTPUT_AMOUNT_RAW_KEY] as string)
      : null
  if (!amountRaw || amountRaw === '0') {
    throw new Error(`Missing ${RAPTOR_OUTPUT_AMOUNT_RAW_KEY} for live close`)
  }

  const sell = await executeMcapRaptorSell(
    params.mintAddress,
    amountRaw,
    params.slippageBps,
    params.symbol,
  )

  const solSpent = cycle.totalSolBought
  const pnlPct =
    solSpent > 0 ? ((sell.solReceived - solSpent) / solSpent) * 100 : 0
  const solPrice = await getSolPriceUSD()
  const remaining = cycle.remainingTokenAmount

  const record = buildTradingRecord({
    walletAddress: params.walletAddress,
    operationType: 'sell',
    is_simulation: false,
    simulation_type: 'strategy',
    bot_strategy: params.strategyId,
    close_position: true,
    tokens: [
      {
        mintAddress: params.mintAddress,
        symbol: params.symbol,
        tokenAmount: remaining,
        solAmount: sell.solReceived,
        priceUsd: 0.000001,
        solPrice,
      },
    ],
    successCount: 1,
    failureCount: 0,
    totalTokens: 1,
    solAmount: sell.solReceived,
    feesPaid: 0,
    solPriceUsd: solPrice,
    signatures: [sell.signature],
    status: pnlPct >= 0 ? 'won' : 'lost',
  })

  await insertTradingRecord(record)

  const exitMcap = params.snapshot.current_mcap
  const completeBuyFeatures = await ensureCompleteBuyFeaturesForOutcome({
    mintAddress: params.mintAddress,
    symbol: params.symbol,
    entryAt: params.entryAt,
    entryMcap: params.entryMcap,
    entryTemplate: params.entryTemplate,
    snapshot: params.snapshot,
    buyFeatures,
  })
  const closeFeatures = buildMcapOutcomeFeatures({
    snapshot: params.snapshot,
    entryTemplate: params.entryTemplate,
    entryMcap: params.entryMcap,
    exitMcap,
    closeReason: params.closeReason,
  })
  const monitorSnapshots = appendMonitorSnapshot(
    readMonitorSnapshotsFromFeatures(completeBuyFeatures),
    {
      timestamp: new Date().toISOString(),
      volume_5m: params.snapshot.volume_5m ?? null,
      market_cap: exitMcap,
    },
  )

  await recordMcapTrackerOutcome({
    strategyId: params.strategyId,
    tokenAddress: params.mintAddress,
    entryAt: params.entryAt,
    exitAt: new Date().toISOString(),
    pnlPct,
    status: pnlPct >= 0 ? 'won' : 'lost',
    isSimulated: false,
    features: mergeEntryFeaturesForOutcome(completeBuyFeatures, {
      ...closeFeatures,
      monitor_snapshots: monitorSnapshots,
      raptor_sell_signature: sell.signature,
    }),
  })

  return pnlPct
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const phaseParam = request.nextUrl.searchParams.get('phase')
  const phase: 'open' | 'manage' | 'all' =
    phaseParam === 'open' || phaseParam === 'manage' || phaseParam === 'all'
      ? phaseParam
      : 'all'
  const runManage = phase === 'manage' || phase === 'all'
  const runOpen = phase === 'open' || phase === 'all'

  try {
    const strategies = await getActiveMcapTrackerStrategies()
    const liveAvailable = isMcapLiveTradingAvailable()
    const results: Array<{
      strategyId: string
      opened: number
      closed: number
      skipped: string[]
      mode: 'sim' | 'live'
    }> = []

    const maxRecency = Math.max(
      240,
      ...strategies.map((s) => s.config.query.recencyMinutes),
    )
    const trackingRows = await fetchMcapSimCandidateRows({
      recencyMinutes: maxRecency,
      recentLimit: 300,
      growthLimit: 100,
    })
    const trackingByMint = new Map(trackingRows.map((r) => [r.token_address, r]))

    for (const strategy of strategies) {
      const execMode = resolveMcapExecutionMode(strategy.execution_mode, liveAvailable)
      if (!execMode.isSimulated && !isMcapLiveStrategyAllowed(strategy.id)) {
        results.push({
          strategyId: strategy.id,
          opened: 0,
          closed: 0,
          skipped: ['live not allowed for this strategy'],
          mode: 'live',
        })
        continue
      }

      const walletAddress = execMode.isSimulated
        ? MCAP_TRACKER_SIM_WALLET
        : getMcapLiveWallet()
      const slippageBps = resolveMcapSlippageBps(strategy.config.execution.slippageBps)
      let records = await fetchTradingRecordsForWallet(walletAddress)
      const openPositions = getOpenPositionsForStrategy(
        records,
        strategy.id,
        execMode.isSimulated,
      )
      const openMintSet = new Set(openPositions.map((p) => p.mintAddress))
      let opened = 0
      let closed = 0
      const skipped: string[] = []

      const closedOutcomeKeys = await loadMcapSimClosedOutcomeKeys(
        strategy.id,
        trackingRows.map((row) => row.token_address),
      )

      if (runManage) {
      for (const pos of openPositions) {
        const snapshot =
          trackingByMint.get(pos.mintAddress) ??
          (await fetchMcapTrackingRow(pos.mintAddress))
        if (!snapshot) continue

        await appendSimPositionMonitorSnapshot({
          records,
          strategyId: strategy.id,
          mintAddress: pos.mintAddress,
          marketCap: snapshot.current_mcap,
        })

        await checkGmgnLiveBoostForOpenPosition({
          walletAddress,
          strategyId: strategy.id,
          mintAddress: pos.mintAddress,
          entryAt: pos.entryAt,
          symbol: pos.symbol,
        })

        // Sim: prefer frozen effective_exit from open when apply mode persisted it.
        // Live: always registry exit (ignore effective_exit).
        const exitForClose =
          execMode.isSimulated && pos.effectiveExit
            ? pos.effectiveExit
            : {
                stopLossPct: strategy.config.exit.stopLossPct,
                takeProfitPct: strategy.config.exit.takeProfitPct,
                maxHoldHours: strategy.config.exit.maxHoldHours,
              }
        const closeReason = getMcapSimCloseReason(snapshot, exitForClose)
        if (!closeReason) continue

        const enrichedSnapshot = {
          ...snapshot,
          volume_5m:
            snapshot.volume_5m ??
            (
              await resolveTokenMonitorSnapshot(
                pos.mintAddress,
                snapshot.current_mcap,
              )
            ).volume_5m,
        }

        try {
          if (execMode.isSimulated) {
            await closeSimPosition({
              strategyId: strategy.id,
              mintAddress: pos.mintAddress,
              symbol: pos.symbol,
              entryAt: pos.entryAt,
              entryMcap: pos.entryMcap || snapshot.first_mcap,
              entryTemplate: pos.entryTemplate,
              snapshot: enrichedSnapshot,
              closeReason,
            })
          } else {
            await closeLivePosition({
              walletAddress,
              strategyId: strategy.id,
              mintAddress: pos.mintAddress,
              symbol: pos.symbol,
              entryAt: pos.entryAt,
              entryMcap: pos.entryMcap || snapshot.first_mcap,
              entryTemplate: pos.entryTemplate,
              snapshot: enrichedSnapshot,
              closeReason,
              slippageBps,
            })
          }
          closed++
        } catch (closeError) {
          skipped.push(
            `${pos.symbol}: live_close_failed (${closeError instanceof Error ? closeError.message : String(closeError)})`,
          )
          continue
        }

        openMintSet.delete(pos.mintAddress)
        closedOutcomeKeys.add(pos.mintAddress)
      }
      }

      if (runOpen) {
      records = await fetchTradingRecordsForWallet(walletAddress)
      const currentOpen = getOpenPositionsForStrategy(
        records,
        strategy.id,
        execMode.isSimulated,
      ).length
      const maxOpen = strategy.config.execution.maxOpenPositions

      for (const snapshot of trackingRows) {
        const skipReason = getMcapSimOpenSkipReason(
          strategy,
          snapshot,
          openMintSet,
          closedOutcomeKeys,
        )
        if (skipReason) {
          if (
            skipReason !== 'already_open' &&
            skipReason !== 'first_seen_too_old' &&
            skipReason !== 'milestone_too_old' &&
            skipReason !== 'already_closed'
          ) {
            skipped.push(`${snapshot.token_symbol}: ${skipReason}`)
          }
          continue
        }
        if (!shouldOpenMcapSim(strategy, snapshot, openMintSet, closedOutcomeKeys)) {
          continue
        }
        if (currentOpen + opened >= maxOpen) {
          skipped.push(`${snapshot.token_symbol}: max positions`)
          break
        }

        const entry = resolveMcapSimEntry(strategy, snapshot)
        if (!entry) {
          skipped.push(`${snapshot.token_symbol}: no_entry_mcap`)
          continue
        }

        if (execMode.skipOpen) {
          skipped.push(`${snapshot.token_symbol}: ${execMode.reason ?? 'live_unavailable'}`)
          continue
        }

        const socialCtx = await getSocialContext(snapshot.token_address)
        const socialGate = evaluateSocialGateFromContext(socialCtx, strategy.config.social, {
          domain: 'mcap_tracker',
          tokenAddress: snapshot.token_address,
        })
        if (!socialGate.passed) {
          skipped.push(`${snapshot.token_symbol}: social_gate`)
          continue
        }

        const liveMetrics = await resolveTokenMonitorSnapshot(
          snapshot.token_address,
          entry.entryMcap,
        )
        const volume5m = snapshot.volume_5m ?? liveMetrics.volume_5m
        const baseFeatures = await buildFullEntryFeatureSnapshot(
          snapshot.token_address,
          {
            entryAt: entry.entryAt,
            firstSeenAt: snapshot.first_seen_at,
            entryMcap: entry.entryMcap,
            organicScore: snapshot.organic_score,
            topHoldersPct: snapshot.top_holders_pct,
            volume5m,
            tokenSymbol: snapshot.token_symbol,
            monitorSnapshots:
              volume5m != null || liveMetrics.price_usd != null ? [liveMetrics] : [],
            social: socialCtx.snapshot,
            skipJupiter:
              snapshot.organic_score != null && snapshot.top_holders_pct != null,
          },
          {
            entry_template: strategy.config.entryTemplate,
            ...buildMcapOutcomeFeatures({
              snapshot,
              entryTemplate: strategy.config.entryTemplate,
              entryMcap: entry.entryMcap,
              exitMcap: snapshot.current_mcap,
            }),
          },
        )
        const annotated = annotateEntryFeatures(baseFeatures, socialCtx)
        const { attachOhlcRugShadow } = await import('@/strategies/ohlc-rug-shadow')
        const ohlc = await attachOhlcRugShadow(snapshot.token_address, annotated, {
          enforce: false,
        })
        const ml = await attachMlEntryShadow(ohlc.features, { enforce: true })
        if (ml.gateReject) {
          if (ml.pBad != null) {
            logMlGateCounterfactual({
              mintAddress: snapshot.token_address,
              strategyId: strategy.id,
              pBad: ml.pBad,
              threshold: getMlGatePBadMax(),
              reason: ml.gateReason ?? 'ml_gate_reject',
            })
          }
          skipped.push(`${snapshot.token_symbol}: ml_gate_reject`)
          continue
        }
        if (ml.patternReject) {
          if (ml.pWinner != null) {
            logPatternGateCounterfactual({
              mintAddress: snapshot.token_address,
              strategyId: strategy.id,
              pWinner: ml.pWinner,
              threshold: getPatternPWinnerMin(),
              reason: ml.patternReason ?? 'ml_pattern_reject',
            })
          }
          skipped.push(`${snapshot.token_symbol}: ml_pattern_reject`)
          continue
        }
        const scoredEntryFeatures = ml.features

        if (!execMode.isSimulated) {
          const halted = await isRealTradingHalted()
          if (halted.halted) {
            skipped.push(`${snapshot.token_symbol}: trading_halted`)
            break
          }
          const lock = await acquireTradeLock(snapshot.token_address, strategy.id)
          if (!lock.acquired) {
            skipped.push(`${snapshot.token_symbol}: trade_lock`)
            continue
          }
          try {
            await openLivePosition({
              walletAddress,
              strategyId: strategy.id,
              mintAddress: snapshot.token_address,
              symbol: snapshot.token_symbol,
              solAmount: strategy.config.execution.simBuySol,
              slippageBps,
              entryMcap: entry.entryMcap,
              entryTemplate: strategy.config.entryTemplate,
              entryAt: entry.entryAt,
              snapshot,
              scoredEntryFeatures,
              strategy,
            })
          } catch (openError) {
            skipped.push(
              `${snapshot.token_symbol}: live_buy_failed (${openError instanceof Error ? openError.message : String(openError)})`,
            )
            continue
          } finally {
            await releaseTradeLock(snapshot.token_address, strategy.id)
          }
        } else {
          await openSimPosition({
            strategyId: strategy.id,
            mintAddress: snapshot.token_address,
            symbol: snapshot.token_symbol,
            solAmount: strategy.config.execution.simBuySol,
            entryMcap: entry.entryMcap,
            entryTemplate: strategy.config.entryTemplate,
            entryAt: entry.entryAt,
            snapshot,
            socialCtx,
            scoredEntryFeatures,
            strategy,
          })
        }

        opened++
        openMintSet.add(snapshot.token_address)
      }
      }

      results.push({
        strategyId: strategy.id,
        opened,
        closed,
        skipped,
        mode: execMode.isSimulated ? 'sim' : 'live',
      })
    }

    log.info('mcap_tracker', 'MCap tracker sim track cycle complete', {
      phase,
      results,
    })

    return NextResponse.json({
      success: true,
      phase,
      live_available: liveAvailable,
      results,
    })
  } catch (error) {
    log.error('error_handling', 'MCap tracker sim track failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
