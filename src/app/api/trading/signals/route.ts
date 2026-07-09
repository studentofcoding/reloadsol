import { NextRequest, NextResponse } from 'next/server'
import { log } from '@/utils/unified-logger'
import { fetchAndScoreSignals } from '@/strategies/signals-pipeline'
import { emitSignalsEarlyAlertsFromScored } from '@/strategies/signals-early-alerts'
import type { SignalsStrategyConfig } from '@/strategies/types'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
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

    const signals = await fetchAndScoreSignals(strategyConfig)

    // Stage-1 copy-trade alerts: enter + growth < 100% (24h dedup; safe on UI + worker polls)
    const earlyAlerts = emitSignalsEarlyAlertsFromScored(signals)
    if (earlyAlerts.length > 0) {
      const { sendSignalsEarlyEnterAlert } = await import('@/utils/telegram')
      for (const alert of earlyAlerts) {
        void sendSignalsEarlyEnterAlert({
          tokenSymbol: alert.tokenSymbol,
          tokenAddress: alert.tokenAddress,
          entryMcap: alert.entryMcap,
          growthPercent: alert.growthPercent,
          score: alert.score,
          rationale: alert.rationale,
          entryAt: alert.entryAt,
        })
      }
    }

    log.info('mcap_tracker', 'Generated trading signals', {
      count: signals.length,
      earlyAlerts: earlyAlerts.length,
      params: { limit, recencyMinutes, minGrowth, includeStuck, maxAgeMinutes, strategy: strategyTemplate },
    })

    return NextResponse.json({
      success: true,
      params: { limit, recencyMinutes, minGrowth, includeStuck, maxAgeMinutes, strategy: strategyTemplate },
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
