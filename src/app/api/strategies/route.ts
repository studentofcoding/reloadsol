import { NextRequest, NextResponse, connection } from 'next/server'
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
import {
  TRENDING_BOT_STRATEGIES,
  SIGNALS_STRATEGIES,
  MCAP_TRACKER_STRATEGIES,
  GMGN_STRATEGIES,
  SOCIAL_STRATEGIES,
  DLMM_STRATEGY_DEFAULTS,
} from '@/strategies/registry'
import { mapRegistryToCanonical } from '@/strategies/canonical-params'
import { diffSource } from '@/strategies/config-source'
import { parseStrategyChain } from '@/strategies/types'


export async function GET(request: NextRequest) {
  await connection()
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
      getMergedSocialRegistry(chain),
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
      // T7: which values came from stored config and which are the code's fallback. Computed here
      // because this is the only place both sides exist — `registry` is the stored config merged over
      // its defaults, `TRENDING_BOT_STRATEGIES` is those defaults. `stored` and `defaults` render
      // identically on the page and mean opposite things, so the display must not have to infer it.
      sources: {
        trending_bot: diffSource(registry, TRENDING_BOT_STRATEGIES),
        signals: diffSource(signalsRegistry, SIGNALS_STRATEGIES),
        mcap_tracker: diffSource(mcapTrackerRegistry, MCAP_TRACKER_STRATEGIES),
        gmgn: diffSource(gmgnRegistry, GMGN_STRATEGIES),
        social: diffSource(socialRegistry, SOCIAL_STRATEGIES),
        dlmm: diffSource(dlmmStrategy, DLMM_STRATEGY_DEFAULTS),
      },
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
