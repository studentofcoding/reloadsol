import { NextRequest, NextResponse } from 'next/server'
import { defaultAgentConfig } from '@/utils/dlmm/config'
import { getAgentConfig } from '@/utils/dlmm/db'
import {
  getMergedTrendingBotRegistry,
  getActiveStrategiesWithState,
  getStrategyStatusSummary,
} from '@/strategies/load-strategy'
import { getMergedSignalsRegistry } from '@/strategies/load-signals'
import { getMergedMcapTrackerRegistry } from '@/strategies/load-mcap-tracker'
import { getMergedDlmmStrategy } from '@/strategies/load-dlmm'
import { TRENDING_BOT_STRATEGIES } from '@/strategies/registry'
import { mapRegistryToCanonical } from '@/strategies/canonical-params'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const [registry, active, status, signalsRegistry, mcapTrackerRegistry, dlmmStrategy] = await Promise.all([
      getMergedTrendingBotRegistry(),
      getActiveStrategiesWithState(),
      getStrategyStatusSummary(),
      getMergedSignalsRegistry(),
      getMergedMcapTrackerRegistry(),
      getMergedDlmmStrategy(),
    ])

    let dlmmConfig = defaultAgentConfig()
    try {
      dlmmConfig = await getAgentConfig()
    } catch {
      /* env fallback */
    }

    const canonical = mapRegistryToCanonical({
      trending: registry,
      signals: signalsRegistry,
      mcap: mcapTrackerRegistry,
      dlmm: dlmmStrategy,
    })

    return NextResponse.json({
      success: true,
      canonical,
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
      mcap_tracker: {
        effective: mcapTrackerRegistry,
        active: Object.values(mcapTrackerRegistry)
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
