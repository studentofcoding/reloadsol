import { NextRequest, NextResponse } from 'next/server'
import { getActiveMcapTrackerStrategies } from '@/strategies/load-mcap-tracker'
import { recordMcapTrackerOutcome } from '@/strategies/outcomes'
import { registerSimExitContract, type SimExitThresholds } from '@/strategies/sim-exit-contract'
import { closeOutcomeStatusFromPnl } from '@/strategies/close-outcome-status'
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
import {
  applyBrainMcapUniverse,
  evaluateMcapBrainOpen,
} from '@/strategies/mcap-track/brain-universe'
import {
  applyBrainRiskToExit,
  createBrainRiskSession,
  frozenExitForSimOpen,
  localBrainRisk,
  scaleOpenSize,
  stampBrainRisk,
  type ResolvedBrainRisk,
} from '@/utils/brain-regime-risk'
import {
  resolveScoreRiskForSimOpen,
  stampScoreRisk,
} from '@/utils/brain-score-risk'
import { mcapTrackerToCanonical } from '@/strategies/canonical-params'
import { resolveExitOverlayForOpen } from '@/strategies/potential-exit-overlay'
import type { McapTrackerStrategy, StrategyChain } from '@/strategies/types'
import { STRATEGY_CHAINS } from '@/strategies/types'
import { captureTokenInfoDetectBatch } from '@/strategies/token-info-detect'
import { simWalletForChain } from '@/strategies/sim-wallets'
import { getNativeUsd } from '@/utils/native-usd'
import {
  annotateEntryFeatures,
  evaluateSocialGateFromContext,
  getSocialContext,
  type SocialContext,
} from '@/strategies/social/context'
import {
  resolveTokenMonitorSnapshot,
} from '@/strategies/sim-monitor-snapshots'
import {
  fetchTradingRecordsForWallet,
  loadMcapSimClosedOutcomeKeys,
  upsertMarketRegimeTag,
} from '@/strategies/db'
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
import type { OhlcRugShadowMemo } from '@/strategies/ohlc-rug-shadow'
import { buildTradingRecord, insertTradingRecords } from '@/utils/trading-records-db'
import { evaluateConsensusGateForOpen } from '@/strategies/db'
import { recordConsensusShadow } from '@/strategies/consensus-gate'
import type { TrackingRecord } from '@/utils/trading-tracker'
import { getSolPriceUSD } from '@/utils/solana'
import { toClimateChipPayload } from '@/utils/climateDisplay'
import { fetchClimate } from '@/utils/climateGate'
import { log } from '@/utils/unified-logger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import {
  buildMcapOutcomeFeatures,
  computeMcapSimPnlPct,
  fetchMcapTrackingRow,
  fetchMcapSimCandidateRows,
  type McapSnapshot,
} from '@/utils/mcap-tracker'
import {
  getMcapSimOpenSkipReason,
  getOpenMcapPositions,
  resolveMcapSimEntry,
  shouldOpenMcapSim,
  type McapSimOpenPosition,
} from '@/utils/mcap-sim-track'

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
  chain: StrategyChain
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
  brainRisk?: ResolvedBrainRisk
  /** Live USD at the spine pass. Missing stays unset — do not invent a price. */
  priceUsd?: number | null
  /** The effective thresholds the spine resolved for THIS trade (S8), not the strategy's base. */
  exitThresholds?: SimExitThresholds
  /** The price actually paid (S10) — the impact-included fill. Falls back to `priceUsd`. */
  entryPriceUsd?: number | null
  /** REL-20: records are collected and bulk-inserted by the route per phase. */
  collect: (record: TrackingRecord) => void
}): Promise<void> {
  const simWallet = simWalletForChain(MCAP_TRACKER_SIM_WALLET, params.chain)
  // "sol" amounts are native-token amounts; on robinhood that's ETH.
  const solPrice = await getNativeUsd(params.chain)
  const priceUsd =
    params.priceUsd != null && params.priceUsd > 0 ? params.priceUsd : 0.000001
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

  const brainRisk = params.brainRisk ?? localBrainRisk()
  const baseExit = applyBrainRiskToExit(
    mcapTrackerToCanonical(params.strategy).exit,
    brainRisk,
  )
  const overlayResult = await resolveExitOverlayForOpen({
    baseExit,
    features: scoredEntryFeatures,
    mintAddress: params.mintAddress,
    strategyId: params.strategyId,
    persistEffectiveExit: true,
  })
  const preScoreExit = overlayResult.effectiveExit ?? baseExit
  const scoreRisk = await resolveScoreRiskForSimOpen({
    strategyId: params.strategyId,
    mint: params.mintAddress,
    chain: params.chain,
    fallbackExit: preScoreExit,
    profileId: brainRisk.profileId,
  })
  const exitAfterScore = scoreRisk.applied ? scoreRisk.exit : preScoreExit
  scoredEntryFeatures = stampBrainRisk(overlayResult.features, brainRisk, {
    sizedSol: params.solAmount,
  })
  scoredEntryFeatures = stampScoreRisk(scoredEntryFeatures, scoreRisk)
  let effectiveExit = scoreRisk.called
    ? exitAfterScore
    : frozenExitForSimOpen(
        overlayResult.effectiveExit,
        baseExit,
        brainRisk,
      )

  // Target machine: cl_take_profit_pct / cl_stop_loss_pct stamped on paper opens
  const clTp = scoredEntryFeatures.cl_take_profit_pct
  const clSl = scoredEntryFeatures.cl_stop_loss_pct
  if (
    effectiveExit &&
    typeof clTp === 'number' &&
    Number.isFinite(clTp) &&
    typeof clSl === 'number' &&
    Number.isFinite(clSl)
  ) {
    effectiveExit = {
      ...effectiveExit,
      takeProfitPct: clTp,
      stopLossPct: clSl,
    }
  }

  const record = buildTradingRecord({
    walletAddress: simWallet,
    chain: params.chain,
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
      ...(effectiveExit ? { effective_exit: effectiveExit } : {}),
    },
  })

  params.collect(record)

  const {
    isMcapManualTradeStrategy,
    isMcapFollowAlertStrategy,
    claimSimOpenDedup,
    pushSimOpenAlertAfterClaim,
  } = await import('@/strategies/mcap-sim-open-alerts')

  if (isMcapManualTradeStrategy(params.strategyId)) {
    const manualStrategyId = params.strategyId
    const { getStrategyNotifyFlags } = await import(
      '@/strategies/strategy-telegram-notify'
    )
    const { isQualifiedBestStrategy } = await import(
      '@/strategies/best-strategies-qualify'
    )
    const notify = await getStrategyNotifyFlags('mcap_tracker', manualStrategyId)
    const isBest = await isQualifiedBestStrategy(manualStrategyId)

    // UI toast (Stage-2 sim open) — separate from follow-alert Telegram.
    if (notify.ui) {
      const freshUi = claimSimOpenDedup(manualStrategyId, params.mintAddress)
      if (freshUi) {
        pushSimOpenAlertAfterClaim({
          strategyId: manualStrategyId,
          tokenAddress: params.mintAddress,
          tokenSymbol: params.symbol,
          entryMcap: params.entryMcap,
          entryAt: params.entryAt,
          entryTemplate: params.entryTemplate,
        })
      }
    }

    // Follow alert only — Sol arms (first_seen / at_80). RH stays in-app toast.
    // Scheduled after the response so sharp PNG encode is off this request.
    if (notify.telegram && isBest && isMcapFollowAlertStrategy(manualStrategyId)) {
      try {
        const { notifyBestStrategyFollowAlert } = await import(
          '@/strategies/best-strategies-share-notify'
        )
        notifyBestStrategyFollowAlert({
          strategyId: manualStrategyId,
          tokenSymbol: params.symbol,
          tokenAddress: params.mintAddress,
          mcap: params.entryMcap,
        })
      } catch (err) {
        console.error('[mcap-sim-open] follow alert failed:', err)
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
  // Paper position → the exit contract (S8/S10), evaluated and recorded but never executed.
  //
  // The thresholds are the spine's EFFECTIVE exit — the cl/brain-adjusted ones this trade was
  // actually opened under. The previous form re-parsed them out of the strategy id (`sl_30_tp200`),
  // which is the strategy's *base* and re-introduces a value the trade was never sized against.
  if (params.exitThresholds) {
    await registerSimExitContract({
      chain: params.chain,
      walletAddress: simWallet,
      strategyId: params.strategyId,
      mintAddress: params.mintAddress,
      symbol: params.symbol,
      positionSize: params.solAmount,
      entryPriceUsd: params.entryPriceUsd ?? priceUsd,
      basis: 'price',
      thresholds: params.exitThresholds,
    })
  }
}

/** Writes today's regime tag at most once per process per (day, state); failures may retry. */
let lastRegimeTagWrite = ''
let regimeFetchAttemptedFor = ''
async function persistDailyRegimeTag(climate: { state?: string | null } | null): Promise<void> {
  let state = typeof climate?.state === 'string' ? climate.state.trim() : ''
  const tagDate = new Date().toISOString().slice(0, 10)
  // The sim only resolves the climate when the brain universe applies, which made this depend on an
  // unrelated opt-in and silently write nothing. Ask the climate service directly instead — it
  // answers in ~100ms — and remember the attempt for the day either way so a failing service is not
  // hammered once per cycle.
  if (!state && regimeFetchAttemptedFor !== tagDate) {
    regimeFetchAttemptedFor = tagDate
    try {
      const fetched = toClimateChipPayload(await fetchClimate())
      state = typeof fetched?.state === 'string' ? fetched.state.trim() : ''
    } catch (error) {
      console.warn(
        '[mcap-sim] regime fetch failed:',
        error instanceof Error ? error.message : error,
      )
      return
    }
  }
  if (!state) return
  const key = `${tagDate}:${state}`
  if (lastRegimeTagWrite === key) return
  try {
    const res = await upsertMarketRegimeTag({
      tagDate,
      regimeTag: state,
      notes: 'brain climate (auto, mcap sim)',
    })
    if (!res.ok) {
      console.warn('[mcap-sim] regime tag write failed:', res.error)
      return
    }
    lastRegimeTagWrite = key
    console.warn(`[mcap-sim] regime tag persisted: ${tagDate} → ${state}`)
  } catch (error) {
    console.warn(
      '[mcap-sim] regime tag write threw:',
      error instanceof Error ? error.message : error,
    )
  }
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
  /** REL-20: records are collected and bulk-inserted by the route per phase. */
  collect: (record: TrackingRecord) => void
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

  params.collect(record)

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

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const { withJobLock } = await import('@/utils/bot-job-lock')
  // One lock for the whole sim, not one per phase: `phase=all` includes both the
  // open and manage passes, so per-phase names let two runs open the same mint
  // concurrently and each compute "not open yet" from records lacking the other's
  // in-flight buys.
  return withJobLock('mcap_tracker_sim', 900, () => runSimTrack(request))
}

async function runSimTrack(request: NextRequest) {

  const phaseParam = request.nextUrl.searchParams.get('phase')
  const phase: 'open' | 'manage' | 'all' =
    phaseParam === 'open' || phaseParam === 'manage' || phaseParam === 'all'
      ? phaseParam
      : 'all'
  // The 60s SL/TP worker owns EVERY exit (SPEC-strategy-exit-standard S9), so this route is
  // discovery + entry only.
  //
  // The manage phase is GONE, not disabled. It closed positions on this 900s clock through its own
  // mcap-growth evaluator (`getMcapSimCloseReason`) — a second opinion on the same position,
  // reading the same thresholds as a different unit. That branch is what the standard removes, and
  // carrying it as unreachable code would have left it one flag away from returning.
  //
  // `?phase=manage` is still accepted and simply runs nothing: the cron sends `phase=all`, and
  // rejecting the old value would break a request shape for no benefit.
  const runOpen = phase === 'open' || phase === 'all'
  // One OHLC load per mint per run. The seven strategies evaluate the same candidates, and that
  // load is rate-gated (~1.07 s measured), so without this the run pays it once per strategy.
  const ohlcRugMemo: OhlcRugShadowMemo = new Map()

  try {
    const liveAvailable = isMcapLiveTradingAvailable()
    const brainRiskSession = createBrainRiskSession()
    const results: Array<{
      strategyId: string
      chain: StrategyChain
      opened: number
      closed: number
      skipped: string[]
      mode: 'sim' | 'live'
    }> = []

    for (const chain of STRATEGY_CHAINS) {
    const strategies = await getActiveMcapTrackerStrategies(chain)
    if (strategies.length === 0) continue

    const maxRecency = Math.max(
      240,
      ...strategies.map((s) => s.config.query.recencyMinutes),
    )
    const trackingRows = await fetchMcapSimCandidateRows({
      recencyMinutes: maxRecency,
      recentLimit: 300,
      growthLimit: 100,
      chain,
    })
    const trackingByMint = new Map(trackingRows.map((r) => [r.token_address, r]))

    // Opt-in: intersect sim opens with market-brain /union (membership + default gates).
    // Off by default; skipped when MARKET_BRAIN_TOKEN is missing. Does not change live execute.
    const brainUniverse = await applyBrainMcapUniverse(trackingRows)
    if (brainUniverse.error && !brainUniverse.applied) {
      console.warn(`🧠 market-brain mcap universe skipped: ${brainUniverse.error}`)
    } else if (brainUniverse.applied) {
      console.log(
        `🧠 market-brain /union membership: kept ${brainUniverse.kept}/${brainUniverse.total} mcap candidates (${brainUniverse.unionSize} union mints)`,
      )
    }
    const brainClimate = brainUniverse.applied
      ? toClimateChipPayload(await fetchClimate())
      : null

    // Persist the day's regime. `insertStrategyOutcome` already stamps `regime_tag_at_exit` from
    // market_regime_tags, so writing the brain's climate there is all it takes for every outcome to
    // carry the day's regime as context — that table has had no rows since 2026-07-10, which is why
    // the column is empty on recent closes. Keyed on the UTC day, the same expression the stamping
    // uses, so the lookup lines up.
    await persistDailyRegimeTag(brainClimate)

    for (const strategy of strategies) {
      // Robinhood has no live execution path yet — every RH definition stays paper.
      const execMode =
        chain === 'robinhood'
          ? resolveMcapExecutionMode('sim_only', false)
          : resolveMcapExecutionMode(strategy.execution_mode, liveAvailable)
      if (!execMode.isSimulated && !isMcapLiveStrategyAllowed(strategy.id)) {
        results.push({
          strategyId: strategy.id,
          chain,
          opened: 0,
          closed: 0,
          skipped: ['live not allowed for this strategy'],
          mode: 'live',
        })
        continue
      }

      const walletAddress = execMode.isSimulated
        ? simWalletForChain(MCAP_TRACKER_SIM_WALLET, chain)
        : getMcapLiveWallet()
      const nativeBuyAmount =
        strategy.config.execution.simBuyNative ?? strategy.config.execution.simBuySol
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

      // REL-20: collect this strategy's trading-record writes per phase and
      // flush once (UNNEST bulk insert) instead of one insert per position.
      // The manage phase MUST flush before the open phase re-fetches records.
      let pendingRecords: TrackingRecord[] = []
      const collect = (record: TrackingRecord) => {
        pendingRecords.push(record)
      }
      const flushPending = async (phase: 'manage' | 'open'): Promise<void> => {
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

      if (runOpen) {
      records = await fetchTradingRecordsForWallet(walletAddress)
      const currentOpen = getOpenPositionsForStrategy(
        records,
        strategy.id,
        execMode.isSimulated,
      ).length
      const maxOpen = strategy.config.execution.maxOpenPositions

      const openRows =
        execMode.isSimulated && brainUniverse.applied
          ? brainUniverse.items
          : trackingRows

      if (chain === 'sol') {
        const selected = openRows.filter(
          (snapshot) =>
            getMcapSimOpenSkipReason(
              strategy,
              snapshot,
              openMintSet,
              closedOutcomeKeys,
            ) == null,
        )
        await captureTokenInfoDetectBatch(
          selected.map((snapshot) => ({
            chain: 'sol' as const,
            tokenAddress: snapshot.token_address,
            detectingStrategy: strategy.id,
            source:
              strategy.config.entryTemplate === 'first_seen'
                ? 'mcap_first_seen'
                : 'mcap_at_80',
          })),
        )
      }

      const brainRisk = execMode.isSimulated
        ? await brainRiskSession.resolve({
            strategyId: strategy.id,
            domain: 'mcap',
            climateState: brainClimate?.state ?? undefined,
          })
        : localBrainRisk()
      if (execMode.isSimulated && brainRisk.standDown) {
        skipped.push('brain_risk_stand_down')
      } else for (const snapshot of openRows) {
        if (execMode.isSimulated && brainUniverse.applied) {
          const gate = evaluateMcapBrainOpen(snapshot, brainUniverse, {
            climate: brainClimate,
            recipeId: strategy.id,
          })
          if (!gate.pass) {
            skipped.push(
              `${snapshot.token_symbol}: brain_gate (${gate.rejectedBy.join(',')})`,
            )
            continue
          }
        }
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
          enforce: execMode.isSimulated,
          memo: ohlcRugMemo,
        })
        if (ohlc.reject) {
          skipped.push(
            `${snapshot.token_symbol}: ohlc_rug (${ohlc.reason ?? 'trip'})`,
          )
          continue
        }
        const ml = await attachMlEntryShadow(ohlc.features, {
          enforce: !execMode.isSimulated,
        })
        if (!execMode.isSimulated) {
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
        }
        const scoredEntryFeatures = ml.features

        let sized: { sol: number; mult: number }
        let sizedFeatures: Record<string, unknown>
        // The spine's contract, carried out of the branch so the sim open can stamp it (S8/S10).
        let spineExit: SimExitThresholds | null = null
        let spineEntryPrice: number | null = null
        if (execMode.isSimulated) {
          const { prepareTargetMachinePaperOpen } = await import(
            '@/strategies/prepare-target-machine-paper-open'
          )
          const {
            appendSpineDecision,
            spinePassDecision,
            spineSkipDecision,
          } = await import('@/strategies/spine-tick-log')
          const spine = await prepareTargetMachinePaperOpen({
            mint: snapshot.token_address,
            chain,
            features: scoredEntryFeatures,
            priceUsd: liveMetrics.price_usd,
            baseSol: nativeBuyAmount,
            // Brain TP/SL/hold FIRST, then the spine's closed-loop adjustment on top — the same
            // order signals and trending use. openSimPosition already did this for its own record,
            // but the spine computes the exit CONTRACT, so leaving it out stamped thresholds the
            // brain never agreed to.
            baseExit: applyBrainRiskToExit(mcapTrackerToCanonical(strategy).exit, brainRisk),
            entryMcap: entry.entryMcap,
          })
          if (!spine.ok) {
            skipped.push(`${snapshot.token_symbol}: ${spine.reason}`)
            await appendSpineDecision(
              spineSkipDecision(
                'mcap_tracker_sim_track',
                snapshot.token_address,
                spine.stage,
                spine.reason,
                snapshot.token_symbol,
              ),
            )
            continue
          }
          sized = spine.sized
          sizedFeatures = spine.features
          spineExit = spine.effectiveExit
          spineEntryPrice = spine.priceUsd
          await appendSpineDecision(
            spinePassDecision(
              'mcap_tracker_sim_track',
              snapshot.token_address,
              snapshot.token_symbol,
              {
                p: spine.p,
                solAmount: spine.solAmount,
                takeProfitPct: spine.effectiveExit.takeProfitPct,
                stopLossPct: spine.effectiveExit.stopLossPct,
              },
            ),
          )
        } else {
          const { softMlSize, stampMlSize } = await import('@/strategies/ml-soft-size')
          sized = softMlSize(nativeBuyAmount, { pBad: ml.pBad })
          sizedFeatures = stampMlSize(scoredEntryFeatures, sized, {
            pBad: ml.pBad,
            pWinner: ml.pWinner,
          })
        }

        // Strategy-consensus gate — SHADOW by default (consensus-gate.ts). Records what
        // it would decide for this would-be open and only skips when the gate is set to
        // enforce AND the consensus lift is significant. Fail-soft: an error here must
        // never block an open.
        const consensus = await evaluateConsensusGateForOpen({
          chain,
          strategyId: strategy.id,
          tokenAddress: snapshot.token_address,
          symbol: snapshot.token_symbol,
        }).catch(() => null)
        if (consensus) {
          void recordConsensusShadow(consensus.row)
          if (consensus.decision.enforced) {
            skipped.push(`${snapshot.token_symbol}: consensus_gate`)
            continue
          }
        }

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
              solAmount: sized.sol,
              slippageBps,
              entryMcap: entry.entryMcap,
              entryTemplate: strategy.config.entryTemplate,
              entryAt: entry.entryAt,
              snapshot,
              scoredEntryFeatures: sizedFeatures,
              strategy,
              collect,
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
          const simSol = scaleOpenSize(sized.sol, brainRisk)
          if (simSol <= 0) {
            skipped.push(`${snapshot.token_symbol}: brain_risk_stand_down`)
            continue
          }
          await openSimPosition({
            strategyId: strategy.id,
            chain,
            mintAddress: snapshot.token_address,
            symbol: snapshot.token_symbol,
            solAmount: simSol,
            priceUsd: liveMetrics.price_usd,
            entryPriceUsd: spineEntryPrice,
            exitThresholds: spineExit ?? undefined,
            entryMcap: entry.entryMcap,
            entryTemplate: strategy.config.entryTemplate,
            entryAt: entry.entryAt,
            snapshot,
            socialCtx,
            scoredEntryFeatures: sizedFeatures,
            strategy,
            brainRisk,
            collect,
          })
        }

        opened++
        openMintSet.add(snapshot.token_address)
      }
      // REL-20: flush open-phase writes before the next strategy re-fetches
      // records. Open insert errors previously propagated (500), so throw.
      await flushPending('open')
      }

      results.push({
        strategyId: strategy.id,
        chain,
        opened,
        closed,
        skipped,
        mode: execMode.isSimulated ? 'sim' : 'live',
      })
    }
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
