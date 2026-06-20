import { NextRequest, NextResponse } from 'next/server'
import { defaultAgentConfig } from '@/utils/dlmm/config'
import { getAgentConfig } from '@/utils/dlmm/db'
import {
  getMergedTrendingBotRegistry,
  getActiveStrategiesWithState,
  getStrategyStatusSummary,
} from '@/strategies/load-strategy'
import { getMergedSignalsRegistry } from '@/strategies/load-signals'
import { getMergedDlmmStrategy } from '@/strategies/load-dlmm'
import { TRENDING_BOT_STRATEGIES } from '@/strategies/registry'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [registry, active, status, signalsRegistry, dlmmStrategy] = await Promise.all([
      getMergedTrendingBotRegistry(),
      getActiveStrategiesWithState(),
      getStrategyStatusSummary(),
      getMergedSignalsRegistry(),
      getMergedDlmmStrategy(),
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
        effective: signalsRegistry,
        active: Object.values(signalsRegistry)
          .filter((s) => s.is_active)
          .map((s) => s.id),
      },
      dlmm: {
        effective: dlmmStrategy,
        config: dlmmConfig,
        note: 'Enable/dry-run on /dev/dlmm; thresholds editable below.',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
