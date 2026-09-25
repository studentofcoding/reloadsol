import { NextResponse, connection } from 'next/server'
import { SOCIAL_STRATEGIES } from '@/strategies/registry'
import { mergeSocialStrategy } from '@/strategies/merge-social'
import { loadStrategyDefinitionById } from '@/strategies/db'
import { readSpineDecisions, type SpineDecision } from '@/strategies/spine-tick-log'
import type { SocialStrategyOverride } from '@/strategies/types'

export const SPINE_WORKER_IDS = [
  'social_sim_track',
  'signals_sim_track',
  'mcap_tracker_sim_track',
  'gmgn_sim_track',
] as const

const FOMO_ID = 'social_only_fomo_gt7'

export async function GET() {
  await connection()
  const ticks: Record<string, SpineDecision[]> = {}
  await Promise.all(
    SPINE_WORKER_IDS.map(async (id) => {
      ticks[id] = await readSpineDecisions(id)
    }),
  )
  const base = SOCIAL_STRATEGIES[FOMO_ID]
  const row = await loadStrategyDefinitionById(FOMO_ID)
  const fomo = base
    ? mergeSocialStrategy(
        base,
        (row?.config as SocialStrategyOverride | null) ?? null,
        row?.is_active ?? null,
      )
    : null

  return NextResponse.json({
    success: true,
    workers: SPINE_WORKER_IDS,
    ticks,
    fomo: fomo
      ? {
          id: FOMO_ID,
          minMentions30m: fomo.config.entry.minMentions30m,
          simBuySol: fomo.config.execution.simBuySol,
          maxOpenPositions: fomo.config.execution.maxOpenPositions,
          takeProfitPct: fomo.config.exit.takeProfitPct,
          stopLossPct: fomo.config.exit.stopLossPct,
          maxHoldHours: fomo.config.exit.maxHoldHours,
        }
      : null,
  })
}
