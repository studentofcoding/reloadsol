import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import { aggregateStrategyReports } from '@/strategies/db'
import { getMergedMcapTrackerRegistry } from '@/strategies/load-mcap-tracker'
import { getMergedSignalsRegistry } from '@/strategies/load-signals'
import { fetchAndScoreSignals, type ScoredSignal } from '@/strategies/signals-pipeline'
import {
  attachPatternShadowToAlert,
  emitSignalsEarlyAlertsFromScoredAsync,
  shouldEmitSignalsEarlyAlert,
} from '@/strategies/signals-early-alerts'
import { attachClosedLoopScoresToSignals } from '@/strategies/signals-early-closed-loop'
import { isEarlyEnterMlSoftGateEnabled } from '@/strategies/signals-early-ml-gate'
import { isEarlyEnterNoulShadowEnabled } from '@/strategies/early-enter-noul-shadow'
import {
  getCachedStage1PatternScore,
  scoreStage1PatternBatch,
} from '@/strategies/signals-early-pattern-cache'
import {
  buildSignalsListStrategyConfig,
  projectSignalsStrategyList,
  resolveSignalsListQueryStrategy,
  signalsListTemplate,
} from '@/strategies/signals-strategy-list'
import { parseDbChain } from '@/utils/app-network-db'

async function enrichSignalsWithPatternShadow(
  signals: ScoredSignal[],
): Promise<ScoredSignal[]> {
  const enterAddrs = signals
    .filter((s) => shouldEmitSignalsEarlyAlert(s))
    .map((s) => s.token_address)
  if (enterAddrs.length === 0) return signals

  const scores = await scoreStage1PatternBatch(enterAddrs, 5)
  return signals.map((s) => {
    const shadow = scores.get(s.token_address)
    if (!shadow) return s
    return {
      ...s,
      ml_pattern_p_winner: shadow.pWinner,
      ml_pattern_predicted: shadow.predicted,
    }
  })
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '30', 10), 100)
    const recencyMinutes = Math.max(parseInt(searchParams.get('recencyMinutes') || '90', 10), 1)
    const minGrowth = parseFloat(searchParams.get('minGrowth') || '0')
    const includeStuck = searchParams.get('includeStuck') === 'true'
    const maxAgeMinutes = Math.max(parseInt(searchParams.get('maxAgeMinutes') || '60', 10), 1)
    const chain = parseDbChain(searchParams.get('chain'))
    const resolved = resolveSignalsListQueryStrategy(searchParams.get('strategy'), chain)
    if (!resolved.ok) {
      return NextResponse.json({ success: false, error: resolved.error }, { status: 400 })
    }
    const selectedId = resolved.strategyId
    const selectedTemplate = signalsListTemplate(selectedId)

    const strategyConfig = buildSignalsListStrategyConfig(selectedTemplate ?? 'default', {
      limit,
      recencyMinutes,
      minGrowth,
      holdGrowthFloor: 10,
      includeStuck,
      maxAgeMinutes,
    })

    const [rawSignals, mcapRegistry, signalsRegistry, reports] = await Promise.all([
      fetchAndScoreSignals(strategyConfig, { chain, keepCandidatePool: true }),
      getMergedMcapTrackerRegistry(chain),
      getMergedSignalsRegistry(chain),
      aggregateStrategyReports({ chain }),
    ])
    const nameOverrides: Record<string, string> = {}
    for (const strategy of [
      ...Object.values(signalsRegistry),
      ...Object.values(mcapRegistry),
    ]) {
      if (strategy?.id && strategy.name) nameOverrides[strategy.id] = strategy.name
    }

    // Pattern ML shadow on Stage-1 candidates (display only; never gates enter)
    const withPattern = await enrichSignalsWithPatternShadow(rawSignals)
    // Closed-loop scores for soft gate and/or Noul shadow state.
    const needClosedLoop =
      isEarlyEnterMlSoftGateEnabled() || isEarlyEnterNoulShadowEnabled()
    const signals = needClosedLoop
      ? await attachClosedLoopScoresToSignals(withPattern, { chain })
      : withPattern

    // Membership filters the JSON list only. Early Enter stays on the pre-filter
    // scored slice, and only when the selected id is a signals strategy.
    // Mcap selections do not attribute a new alert. Soft gate / Noul are not
    // inputs to membership (emit still owns its own gate).
    let earlyAlerts: Awaited<ReturnType<typeof emitSignalsEarlyAlertsFromScoredAsync>> = []
    if (selectedTemplate) {
      let activeNoulStrategyKeys: string[] = []
      if (isEarlyEnterNoulShadowEnabled()) {
        const mcapIds =
          chain === 'robinhood'
            ? (['mcap_enter_first_seen_rh', 'mcap_enter_at_80_rh'] as const)
            : (['mcap_enter_first_seen', 'mcap_enter_at_80'] as const)
        activeNoulStrategyKeys = mcapIds.filter((id) => mcapRegistry[id]?.is_active)
      }
      const emitList = signals.slice(0, limit)
      earlyAlerts = await emitSignalsEarlyAlertsFromScoredAsync(emitList, chain, {
        activeNoulStrategyKeys,
      })
    }
    if (earlyAlerts.length > 0) {
      const { sendSignalsEarlyEnterAlert } = await import('@/utils/telegram')
      const { insertSocialEvents } = await import('@/strategies/social/db')
      const earlyEvents = earlyAlerts.map((alert) => ({
        token_address: alert.tokenAddress,
        event_type: 'mention' as const,
        source: 'signals_early',
        external_message_id: `early:${alert.tokenAddress}:${alert.entryAt}`,
        occurred_at: alert.entryAt,
        raw_metadata: {
          early_signals_score: alert.score,
          early_growth_pct: alert.growthPercent,
          symbol: alert.tokenSymbol,
          entry_mcap: alert.entryMcap,
          rationale: alert.rationale,
          chain,
        },
      }))
      void insertSocialEvents(earlyEvents).catch((err) => {
        console.error('[signals] early stamp ingest failed:', err)
      })

      for (const alert of earlyAlerts) {
        // Ensure shadow is attached (cache hit if enrich already scored)
        if (alert.pWinner == null) {
          const shadow = await getCachedStage1PatternScore(alert.tokenAddress)
          attachPatternShadowToAlert(alert, {
            pWinner: shadow.pWinner,
            predicted: shadow.predicted,
            reason: shadow.reason,
          })
        }
        void (async () => {
          const { lookupSmKolPeaksForMint } = await import(
            '@/strategies/gmgn-radar-accumulate'
          )
          const { fetchMcapTrackingRow } = await import('@/utils/mcap-tracker')
          const { getSignalsStrategy } = await import('@/strategies/load-signals')
          const { readNotifyFlags } = await import('@/strategies/strategy-notify')
          const { resolveStrategyDisplayName } = await import(
            '@/strategies/strategy-telegram-notify'
          )
          const signalsId = selectedId
          const mcapIds =
            chain === 'robinhood'
              ? (['mcap_enter_first_seen_rh', 'mcap_enter_at_80_rh'] as const)
              : (['mcap_enter_first_seen', 'mcap_enter_at_80'] as const)
          const signalsStrategy = await getSignalsStrategy(signalsId, chain)
          const notify = readNotifyFlags(signalsStrategy?.config.notify)
          if (!notify.telegram && !notify.ui) {
            return
          }
          const strategyIds = [signalsId]
          const [peaks, tracked] = await Promise.all([
            lookupSmKolPeaksForMint(alert.tokenAddress),
            fetchMcapTrackingRow(alert.tokenAddress),
          ])
          if (tracked) {
            for (const id of mcapIds) {
              if (mcapRegistry[id]?.is_active) strategyIds.push(id)
            }
          }
          if (notify.telegram) {
            await sendSignalsEarlyEnterAlert({
              tokenSymbol: alert.tokenSymbol,
              tokenAddress: alert.tokenAddress,
              entryMcap: alert.entryMcap,
              growthPercent: alert.growthPercent,
              score: alert.score,
              rationale: alert.rationale,
              entryAt: alert.entryAt,
              pWinner: alert.pWinner,
              predicted: alert.predicted,
              sm: peaks?.sm ?? null,
              kol: peaks?.kol ?? null,
              strategyIds,
              strategyId: signalsId,
              strategyName: resolveStrategyDisplayName('signals', signalsId),
            })
          }
          if (!notify.ui) {
            const { discardPendingSignalsEarlyToasts } = await import(
              '@/strategies/signals-early-alerts'
            )
            discardPendingSignalsEarlyToasts([alert.tokenAddress])
          }
        })()
      }
    }

    const projected = projectSignalsStrategyList({
      chain,
      selectedId,
      pool: signals,
      limit,
      scoreConfig: strategyConfig,
      mcapById: mcapRegistry,
      nameOverrides,
      breakdown: reports.breakdown,
    })

    log.info('mcap_tracker', 'Generated trading signals', {
      count: projected.signals.length,
      earlyAlerts: earlyAlerts.length,
      params: {
        limit,
        recencyMinutes,
        minGrowth,
        includeStuck,
        maxAgeMinutes,
        strategy: selectedId,
        chain,
      },
    })

    return NextResponse.json({
      success: true,
      params: {
        limit,
        recencyMinutes,
        minGrowth,
        includeStuck,
        maxAgeMinutes,
        strategy: selectedId,
        chain,
      },
      stats: {
        returnedSignals: projected.signals.length,
        earlyAlerts: earlyAlerts.length,
      },
      strategies: projected.strategies,
      signals: projected.signals,
    })
  } catch (error) {
    log.error('error_handling', 'Failed to generate trading signals', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  } finally {
    log.info('api_request', 'Signals request completed', { durationMs: Date.now() - startedAt })
  }
}
