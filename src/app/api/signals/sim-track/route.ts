import { NextRequest, NextResponse } from 'next/server'
import {
  applyBrainSignalsUniverse,
  evaluateSignalsBrainOpen,
} from '@/strategies/signals/brain-universe'
import {
  applyBrainRiskToExit,
  createBrainRiskSession,
  scaleOpenSize,
  stampBrainRisk,
} from '@/utils/brain-regime-risk'
import { toClimateChipPayload } from '@/utils/climateDisplay'
import { fetchClimate } from '@/utils/climateGate'
import { getActiveSignalsForSim } from '@/strategies/load-signals'
import { openSignalsSimPosition, SIGNALS_SIM_WALLET } from '@/strategies/telegram-alpha-sim'
import { scoreSignalsForStrategy } from '@/strategies/signals-pipeline'
import { recordSignalsOutcome } from '@/strategies/outcomes'
import { closeOutcomeStatusFromPnl } from '@/strategies/close-outcome-status'
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
    ''
  )
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSimTrackSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const { withJobLock } = await import('@/utils/bot-job-lock')
  return withJobLock('signals_sim_track', 900, () => runSimTrack(request))
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
    const brainRiskSession = createBrainRiskSession()

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

        // The 60s SL/TP worker owns this position's exit (SPEC-strategy-exit-standard S9). This
        // pass monitors and opens only. Both closers that used to run here — the score's `exit`
        // decision and the stamped cl TP/SL — are gone, so the worker is the single evaluator and
        // the route cannot take a second opinion on a position it also opened.
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
      const brainUniverse = await applyBrainSignalsUniverse(enterCandidates, {
        recipeId: strategy.id,
      })
      if (brainUniverse.error && !brainUniverse.applied) {
        console.warn(`🧠 market-brain signals universe skipped: ${brainUniverse.error}`)
      } else if (brainUniverse.applied) {
        console.log(
          `🧠 market-brain /union membership: kept ${brainUniverse.kept}/${brainUniverse.total} signals candidates (${brainUniverse.unionSize} union mints)`,
        )
      }
      let brainEnterCandidates = brainUniverse.items
      let brainClimate: ReturnType<typeof toClimateChipPayload> | null = null
      if (brainUniverse.applied) {
        brainClimate = toClimateChipPayload(await fetchClimate())
        const gated: typeof brainEnterCandidates = []
        for (const signal of brainEnterCandidates) {
          const gate = evaluateSignalsBrainOpen(signal, brainUniverse, {
            climate: brainClimate,
            recipeId: strategy.id,
          })
          if (!gate.pass) {
            skipped.push(
              `${signal.token_symbol}: brain_gate (${gate.rejectedBy.join(',')})`,
            )
            continue
          }
          gated.push(signal)
        }
        brainEnterCandidates = gated
      }
      const brainRisk = await brainRiskSession.resolve({
        strategyId: strategy.id,
        domain: 'signals',
        climateState: brainClimate?.state ?? undefined,
      })
      if (brainRisk.standDown) {
        skipped.push('brain_risk_stand_down')
        brainEnterCandidates = []
      }
      const enterMints = brainEnterCandidates.slice(0, Math.max(0, maxOpen - currentOpen)).map((s) => s.token_address)
      const [entryPrices, socialCtxList] = await Promise.all([
        enterMints.length > 0 ? getOpenPositionPrices(enterMints, chain) : ({} as Record<string, number>),
        Promise.all(enterMints.map((m) => getSocialContext(m))),
      ])
      const socialCtxByMint = new Map(enterMints.map((m, i) => [m, socialCtxList[i]]))

      for (const signal of brainEnterCandidates) {
        if (currentOpen + opened >= maxOpen) {
          skipped.push(`${signal.token_symbol}: max positions`)
          break
        }

        const priceUsd = entryPrices[signal.token_address]
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
        const { signalsToCanonical } = await import('@/strategies/canonical-params')
        const { prepareTargetMachinePaperOpen } = await import(
          '@/strategies/prepare-target-machine-paper-open'
        )
        const {
          appendSpineDecision,
          spinePassDecision,
          spineSkipDecision,
        } = await import('@/strategies/spine-tick-log')
        const canonicalExit = applyBrainRiskToExit(
          signalsToCanonical(strategy).exit,
          brainRisk,
        )
        const baseSol =
          strategy.config.execution.simBuyNative ?? strategy.config.execution.simBuySol
        const spine = await prepareTargetMachinePaperOpen({
          mint: signal.token_address,
          chain,
          features: annotated,
          priceUsd,
          baseSol,
          baseExit: canonicalExit,
          entryMcap:
            typeof signal.current_mcap === 'number' ? signal.current_mcap : null,
        })
        if (!spine.ok) {
          skipped.push(`${symbol}: ${spine.reason}`)
          await appendSpineDecision(
            spineSkipDecision(
              'signals_sim_track',
              signal.token_address,
              spine.stage,
              spine.reason,
              symbol,
            ),
          )
          continue
        }
        const { resolveExitOverlayForOpen } = await import(
          '@/strategies/potential-exit-overlay'
        )
        const overlayResult = await resolveExitOverlayForOpen({
          baseExit: canonicalExit,
          features: spine.features,
          mintAddress: signal.token_address,
          strategyId: strategy.id,
          persistEffectiveExit: false,
        })
        const simSol = scaleOpenSize(spine.solAmount, brainRisk)
        if (simSol <= 0) {
          skipped.push(`${symbol}: brain_risk_stand_down`)
          await appendSpineDecision(
            spineSkipDecision(
              'signals_sim_track',
              signal.token_address,
              'size',
              'brain_risk_stand_down',
              symbol,
            ),
          )
          continue
        }

        await appendSpineDecision(
          spinePassDecision('signals_sim_track', signal.token_address, symbol, {
            p: spine.p,
            solAmount: simSol,
            takeProfitPct: spine.effectiveExit.takeProfitPct,
            stopLossPct: spine.effectiveExit.stopLossPct,
          }),
        )
        await openSignalsSimPosition({
          strategyId: strategy.id,
          chain,
          mintAddress: signal.token_address,
          symbol,
          solAmount: simSol,
          priceUsd: spine.priceUsd,
          entryPriceImpactedUsd: spine.priceUsd,
          entryFeatures: stampBrainRisk(overlayResult.features, brainRisk, {
            sizedSol: simSol,
          }),
          effectiveExit: spine.effectiveExit,
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
