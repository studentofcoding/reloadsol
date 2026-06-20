import { NextRequest, NextResponse } from 'next/server'
import {
  TRENDING_BOT_STRATEGIES,
  SIGNALS_STRATEGIES,
  DLMM_STRATEGY_DEFAULTS,
} from '@/strategies/registry'
import { mergeDlmmStrategy, dlmmConfigToAgentPatch } from '@/strategies/merge-dlmm'
import { invalidateStrategyCache } from '@/strategies/load-strategy'
import { invalidateSignalsCache } from '@/strategies/load-signals'
import { invalidateDlmmStrategyCache } from '@/strategies/load-dlmm'
import { upsertStrategyDefinition, loadStrategyDefinitionById } from '@/strategies/db'
import { updateAgentConfig } from '@/utils/dlmm/db'
import type { ExecutionMode } from '@/strategies/types'

export const dynamic = 'force-dynamic'

type PromoteBody = {
  target_id: string
  confirm_live?: boolean
}

function resolveStrategyBase(id: string) {
  if (TRENDING_BOT_STRATEGIES[id]) return { domain: 'trending_bot' as const, id }
  if (SIGNALS_STRATEGIES[id]) return { domain: 'signals' as const, id }
  if (id === 'dlmm_default') return { domain: 'dlmm' as const, id }
  return null
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: sourceId } = await context.params
    const body = (await request.json()) as PromoteBody
    const targetId = body.target_id

    if (!targetId) {
      return NextResponse.json(
        { success: false, error: 'target_id is required' },
        { status: 400 },
      )
    }

    const sourceResolved = resolveStrategyBase(sourceId)
    const targetResolved = resolveStrategyBase(targetId)

    if (!sourceResolved || !targetResolved) {
      return NextResponse.json(
        { success: false, error: 'Unknown source or target strategy' },
        { status: 404 },
      )
    }

    if (sourceResolved.domain !== targetResolved.domain) {
      return NextResponse.json(
        { success: false, error: 'Source and target must be same domain' },
        { status: 400 },
      )
    }

    const sourceRow = await loadStrategyDefinitionById(sourceId)
    const sourceConfig = sourceRow?.config ?? {}

    const targetBase =
      targetResolved.domain === 'trending_bot'
        ? TRENDING_BOT_STRATEGIES[targetId]
        : targetResolved.domain === 'signals'
          ? SIGNALS_STRATEGIES[targetId]
          : DLMM_STRATEGY_DEFAULTS

    const targetRow = await loadStrategyDefinitionById(targetId)
    const targetName =
      targetRow?.name ??
      (targetBase as { name: string }).name

    const result = await upsertStrategyDefinition({
      id: targetId,
      domain: targetResolved.domain,
      name: targetName,
      description: `Promoted from ${sourceId} at ${new Date().toISOString()}`,
      config: sourceConfig as Record<string, unknown>,
      is_active: true,
      execution_mode: 'live_only' as ExecutionMode,
    })

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 })
    }

    await upsertStrategyDefinition({
      id: sourceId,
      domain: sourceResolved.domain,
      name: sourceRow?.name ?? sourceId,
      description: sourceRow?.description,
      config: sourceConfig as Record<string, unknown>,
      is_active: sourceRow?.is_active ?? true,
      execution_mode: 'sim_only',
    })

    if (targetResolved.domain === 'dlmm') {
      const merged = mergeDlmmStrategy(
        DLMM_STRATEGY_DEFAULTS,
        sourceConfig as import('@/strategies/types').DlmmStrategyOverride,
        true,
      )
      try {
        await updateAgentConfig(
          dlmmConfigToAgentPatch(merged.config) as Parameters<typeof updateAgentConfig>[0],
        )
        if (body.confirm_live) {
          await updateAgentConfig({ dry_run: false } as Parameters<typeof updateAgentConfig>[0])
        }
      } catch (err) {
        console.warn('[promote] dlmm sync failed:', err)
      }
      invalidateDlmmStrategyCache()
    } else if (targetResolved.domain === 'trending_bot') {
      invalidateStrategyCache()
    } else {
      invalidateSignalsCache()
    }

    const liveFlipNote = body.confirm_live
      ? 'Global live flags updated where applicable (DLMM dry_run=false when domain=dlmm). Trending bot isSimulated and signals manual buys still require separate toggles.'
      : 'Config copied to live slot. Set confirm_live=true to also flip DLMM dry_run off. Trending/signals global sim flags unchanged.'

    return NextResponse.json({
      success: true,
      source_id: sourceId,
      target_id: targetId,
      message: liveFlipNote,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
