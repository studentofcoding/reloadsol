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
import { getMergedGmgnRegistry } from '@/strategies/load-gmgn'
import { getMergedSocialRegistry } from '@/strategies/load-social'
import { getMergedDlmmStrategy } from '@/strategies/load-dlmm'
import { TRENDING_BOT_STRATEGIES } from '@/strategies/registry'
import { mapRegistryToCanonical } from '@/strategies/canonical-params'
import { parseStrategyChain } from '@/strategies/types'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const chain = parseStrategyChain(request.nextUrl.searchParams.get('chain'))
    const [
      registry,
      active,
      status,
      signalsRegistry,
      mcapTrackerRegistry,
      gmgnRegistry,
      socialRegistry,
      dlmmStrategy,
    ] = await Promise.all([
      getMergedTrendingBotRegistry(chain),
      getActiveStrategiesWithState(chain),
      getStrategyStatusSummary(),
      getMergedSignalsRegistry(chain),
      getMergedMcapTrackerRegistry(chain),
      getMergedGmgnRegistry(chain),
      // social and dlmm stay sol-only; RH gets an explicit not-available panel.
      chain === 'sol'
        ? getMergedSocialRegistry()
        : Promise.resolve({} as Awaited<ReturnType<typeof getMergedSocialRegistry>>),
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
      gmgn: gmgnRegistry,
      social: socialRegistry,
      dlmm: dlmmStrategy,
    })

    return NextResponse.json({
      success: true,
      chain,
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
      gmgn: {
        effective: gmgnRegistry,
        active: Object.values(gmgnRegistry)
          .filter((s) => s.is_active)
          .map((s) => s.id),
      },
      social: {
        effective: socialRegistry,
        active: Object.values(socialRegistry)
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
