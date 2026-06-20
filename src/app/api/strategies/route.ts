import { NextRequest, NextResponse } from 'next/server'
import { defaultAgentConfig } from '@/utils/dlmm/config'
import { getAgentConfig } from '@/utils/dlmm/db'
import {
  getMergedTrendingBotRegistry,
  getActiveStrategiesWithState,
  getStrategyStatusSummary,
} from '@/strategies/load-strategy'
import { SIGNALS_STRATEGY_META, TRENDING_BOT_STRATEGIES } from '@/strategies/registry'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [registry, active, status] = await Promise.all([
      getMergedTrendingBotRegistry(),
      getActiveStrategiesWithState(),
      getStrategyStatusSummary(),
    ])

    let dlmmConfig = defaultAgentConfig()
    try {
      dlmmConfig = await getAgentConfig()
    } catch {
      /* env fallback */
    }

    return NextResponse.json({
      success: true,
      trending_bot: {
        defaults: TRENDING_BOT_STRATEGIES,
        effective: registry,
        active: active.strategies,
        allocation: active.allocation,
        status,
      },
      signals: {
        templates: SIGNALS_STRATEGY_META,
        note: 'Signals scoring is read-only in v1; edit via /dev/signals tab params.',
      },
      dlmm: {
        config: dlmmConfig,
        note: 'Enable/dry-run on /dev/dlmm; threshold editing in Phase 2.',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
