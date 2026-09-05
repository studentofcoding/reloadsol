import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import { fetchAndScoreSignals, type ScoredSignal } from '@/strategies/signals-pipeline'
import {
  attachPatternShadowToAlert,
  emitSignalsEarlyAlertsFromScored,
  shouldEmitSignalsEarlyAlert,
} from '@/strategies/signals-early-alerts'
import {
  getCachedStage1PatternScore,
  scoreStage1PatternBatch,
} from '@/strategies/signals-early-pattern-cache'
import type { SignalsStrategyConfig } from '@/strategies/types'
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
    const strategyTemplate = (searchParams.get('strategy') || 'default') as
      | 'default'
      | 'sell_over_100'
    const chain = parseDbChain(searchParams.get('chain'))

    const strategyConfig: SignalsStrategyConfig = {
      template: strategyTemplate,
      enterScoreFloor: 50,
      query: {
        limit,
        recencyMinutes,
        minGrowth,
        holdGrowthFloor: 10,
        includeStuck,
        maxAgeMinutes,
      },
      scoring: {
        recencyBoostMax: 20,
        milestone80: 15,
        milestone120: 20,
        milestone200: 25,
        speedTo80Fast: 15,
        speedTo80Medium: 10,
        speedTo80Slow: 5,
        inTrackingRange: 10,
        stuckPenalty: 50,
        stopLossPenalty: 100,
        sellOver100LatePenalty: 40,
      },
      execution: { simBuySol: 0.01, maxOpenPositions: 10 },
    }

    const rawSignals = await fetchAndScoreSignals(strategyConfig, { chain })

    // Pattern ML shadow on Stage-1 candidates (display only; never gates enter)
    const signals = await enrichSignalsWithPatternShadow(rawSignals)

    // Stage-1 copy-trade alerts: enter + growth < 100% (24h dedup; safe on UI + worker polls)
    const earlyAlerts = emitSignalsEarlyAlertsFromScored(signals, chain)
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
          const { getMergedMcapTrackerRegistry } = await import(
            '@/strategies/load-mcap-tracker'
          )
          const { getSignalsStrategy } = await import('@/strategies/load-signals')
          const { readNotifyFlags } = await import('@/strategies/strategy-notify')
          const { resolveStrategyDisplayName } = await import(
            '@/strategies/strategy-telegram-notify'
          )
          // RH has signals_default_rh only (no sell_over_100 twin).
          const signalsId =
            chain === 'robinhood'
              ? 'signals_default_rh'
              : strategyTemplate === 'sell_over_100'
                ? 'signals_sell_over_100'
                : 'signals_default'
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
            const registry = await getMergedMcapTrackerRegistry(chain)
            for (const id of mcapIds) {
              if (registry[id]?.is_active) strategyIds.push(id)
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

    log.info('mcap_tracker', 'Generated trading signals', {
      count: signals.length,
      earlyAlerts: earlyAlerts.length,
      params: {
        limit,
        recencyMinutes,
        minGrowth,
        includeStuck,
        maxAgeMinutes,
        strategy: strategyTemplate,
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
        strategy: strategyTemplate,
        chain,
      },
      stats: { returnedSignals: signals.length, earlyAlerts: earlyAlerts.length },
      signals,
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
