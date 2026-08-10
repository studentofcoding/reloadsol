import { NextRequest, NextResponse } from 'next/server'
import { TRENDING_BOT_STRATEGIES, SIGNALS_STRATEGIES, DLMM_STRATEGY_DEFAULTS, MCAP_TRACKER_STRATEGIES, GMGN_STRATEGIES, SOCIAL_STRATEGIES } from '@/strategies/registry'
import { mergeStrategyOverride } from '@/strategies/merge'
import { mergeSignalsStrategy } from '@/strategies/merge-signals'
import { mergeMcapTrackerStrategy } from '@/strategies/merge-mcap-tracker'
import { mergeGmgnStrategy } from '@/strategies/merge-gmgn'
import { mergeSocialStrategy } from '@/strategies/merge-social'
import { mergeDlmmStrategy, dlmmConfigToAgentPatch } from '@/strategies/merge-dlmm'
import {
  invalidateStrategyCache,
} from '@/strategies/load-strategy'
import { invalidateSignalsCache } from '@/strategies/load-signals'
import { invalidateMcapTrackerCache } from '@/strategies/load-mcap-tracker'
import { invalidateGmgnCache } from '@/strategies/load-gmgn'
import { invalidateSocialCache } from '@/strategies/load-social'
import { invalidateDlmmStrategyCache } from '@/strategies/load-dlmm'
import { upsertStrategyDefinition, loadStrategyDefinitionById } from '@/strategies/db'
import {
  closeOpenPositionsForStrategy,
  type CloseOnDeactivateResult,
} from '@/strategies/close-on-deactivate'
import { updateAgentConfig } from '@/utils/dlmm/db'
import { mergeStrategyConfigPatch } from '@/strategies/merge-strategy-config-patch'
import type {
  ExecutionMode,
  StrategyDomain,
  TrendingBotStrategyOverride,
  SignalsStrategyOverride,
  McapTrackerStrategyOverride,
  GmgnStrategyOverride,
  SocialStrategyOverride,
  DlmmStrategyOverride,
} from '@/strategies/types'


type PatchBody = {
  is_active?: boolean
  name?: string
  description?: string
  execution_mode?: ExecutionMode
  config?: Record<string, unknown>
  confirm_live?: boolean
}

function resolveStrategyBase(id: string) {
  if (TRENDING_BOT_STRATEGIES[id]) {
    return { domain: 'trending_bot' as const, base: TRENDING_BOT_STRATEGIES[id] }
  }
  if (SIGNALS_STRATEGIES[id]) {
    return { domain: 'signals' as const, base: SIGNALS_STRATEGIES[id] }
  }
  if (MCAP_TRACKER_STRATEGIES[id]) {
    return { domain: 'mcap_tracker' as const, base: MCAP_TRACKER_STRATEGIES[id] }
  }
  if (GMGN_STRATEGIES[id]) {
    return { domain: 'gmgn' as const, base: GMGN_STRATEGIES[id] }
  }
  if (SOCIAL_STRATEGIES[id]) {
    return { domain: 'social' as const, base: SOCIAL_STRATEGIES[id] }
  }
  if (id === 'dlmm_default') {
    return { domain: 'dlmm' as const, base: DLMM_STRATEGY_DEFAULTS }
  }
  return null
}

async function closeIfDeactivating(params: {
  strategyId: string
  domain: StrategyDomain
  wasActive: boolean
  nextActive: boolean | undefined
}): Promise<CloseOnDeactivateResult | undefined> {
  if (params.nextActive !== false || !params.wasActive) return undefined
  try {
    return await closeOpenPositionsForStrategy({
      strategyId: params.strategyId,
      domain: params.domain,
    })
  } catch (err) {
    console.error('[strategies/patch] close-on-deactivate failed:', err)
    return {
      closed: 0,
      failed: [
        {
          token: '*',
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    }
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const resolved = resolveStrategyBase(id)

    if (!resolved) {
      return NextResponse.json(
        { success: false, error: `Unknown strategy: ${id}` },
        { status: 404 },
      )
    }

    const body = (await request.json()) as PatchBody
    const existingRow = await loadStrategyDefinitionById(id)
    // Omit config → keep DB override; partial config → deep-merge onto existing
    const configOverride = mergeStrategyConfigPatch(
      existingRow?.config,
      body.config,
    )
    const nextActive =
      body.is_active ?? existingRow?.is_active ?? null
    const wasActive = existingRow?.is_active ?? true

    if (resolved.domain === 'trending_bot') {
      const merged = mergeStrategyOverride(
        resolved.base as import('@/strategies/types').TrendingBotStrategy,
        configOverride as TrendingBotStrategyOverride,
        nextActive,
      )

      const result = await upsertStrategyDefinition({
        id,
        domain: 'trending_bot',
        name: body.name ?? merged.name,
        description: body.description ?? merged.description,
        config: configOverride,
        is_active: body.is_active ?? existingRow?.is_active ?? merged.is_active,
        execution_mode: body.execution_mode ?? existingRow?.execution_mode ?? 'sim_only',
      })

      if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 })
      }

      invalidateStrategyCache()
      const closedPositions = await closeIfDeactivating({
        strategyId: id,
        domain: 'trending_bot',
        wasActive,
        nextActive: body.is_active,
      })
      return NextResponse.json({
        success: true,
        strategy: merged,
        ...(closedPositions ? { closedPositions } : {}),
      })
    }

    if (resolved.domain === 'signals') {
      const merged = mergeSignalsStrategy(
        resolved.base as import('@/strategies/types').SignalsStrategy,
        configOverride as SignalsStrategyOverride,
        nextActive,
      )
      if (body.execution_mode) merged.execution_mode = body.execution_mode

      const result = await upsertStrategyDefinition({
        id,
        domain: 'signals',
        name: body.name ?? merged.name,
        description: body.description ?? merged.description,
        config: configOverride,
        is_active: body.is_active ?? existingRow?.is_active ?? merged.is_active,
        execution_mode: body.execution_mode ?? existingRow?.execution_mode ?? merged.execution_mode,
      })

      if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 })
      }

      invalidateSignalsCache()
      const closedPositions = await closeIfDeactivating({
        strategyId: id,
        domain: 'signals',
        wasActive,
        nextActive: body.is_active,
      })
      return NextResponse.json({
        success: true,
        strategy: merged,
        ...(closedPositions ? { closedPositions } : {}),
      })
    }

    if (resolved.domain === 'mcap_tracker') {
      const merged = mergeMcapTrackerStrategy(
        resolved.base as import('@/strategies/types').McapTrackerStrategy,
        configOverride as McapTrackerStrategyOverride,
        nextActive,
      )
      if (body.execution_mode) merged.execution_mode = body.execution_mode

      const result = await upsertStrategyDefinition({
        id,
        domain: 'mcap_tracker',
        name: body.name ?? merged.name,
        description: body.description ?? merged.description,
        config: configOverride,
        is_active: body.is_active ?? existingRow?.is_active ?? merged.is_active,
        execution_mode: body.execution_mode ?? existingRow?.execution_mode ?? merged.execution_mode,
      })

      if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 })
      }

      invalidateMcapTrackerCache()
      const closedPositions = await closeIfDeactivating({
        strategyId: id,
        domain: 'mcap_tracker',
        wasActive,
        nextActive: body.is_active,
      })
      return NextResponse.json({
        success: true,
        strategy: merged,
        ...(closedPositions ? { closedPositions } : {}),
      })
    }

    if (resolved.domain === 'gmgn') {
      const merged = mergeGmgnStrategy(
        resolved.base as import('@/strategies/types').GmgnStrategy,
        configOverride as GmgnStrategyOverride,
        nextActive,
      )
      if (body.execution_mode) merged.execution_mode = body.execution_mode

      const result = await upsertStrategyDefinition({
        id,
        domain: 'gmgn',
        name: body.name ?? merged.name,
        description: body.description ?? merged.description,
        config: configOverride,
        is_active: body.is_active ?? existingRow?.is_active ?? merged.is_active,
        execution_mode: body.execution_mode ?? existingRow?.execution_mode ?? merged.execution_mode,
      })

      if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 })
      }

      invalidateGmgnCache()
      const closedPositions = await closeIfDeactivating({
        strategyId: id,
        domain: 'gmgn',
        wasActive,
        nextActive: body.is_active,
      })
      return NextResponse.json({
        success: true,
        strategy: merged,
        ...(closedPositions ? { closedPositions } : {}),
      })
    }

    if (resolved.domain === 'social') {
      const merged = mergeSocialStrategy(
        resolved.base as import('@/strategies/types').SocialStrategy,
        configOverride as SocialStrategyOverride,
        nextActive,
      )
      if (body.execution_mode) merged.execution_mode = body.execution_mode

      const result = await upsertStrategyDefinition({
        id,
        domain: 'social',
        name: body.name ?? merged.name,
        description: body.description ?? merged.description,
        config: configOverride,
        is_active: body.is_active ?? existingRow?.is_active ?? merged.is_active,
        execution_mode: body.execution_mode ?? existingRow?.execution_mode ?? merged.execution_mode,
      })

      if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error }, { status: 500 })
      }

      invalidateSocialCache()
      const closedPositions = await closeIfDeactivating({
        strategyId: id,
        domain: 'social',
        wasActive,
        nextActive: body.is_active,
      })
      return NextResponse.json({
        success: true,
        strategy: merged,
        ...(closedPositions ? { closedPositions } : {}),
      })
    }

    const merged = mergeDlmmStrategy(
      resolved.base as import('@/strategies/types').DlmmStrategy,
      configOverride as DlmmStrategyOverride,
      nextActive,
    )
    if (body.execution_mode) merged.execution_mode = body.execution_mode

    const result = await upsertStrategyDefinition({
      id,
      domain: 'dlmm',
      name: body.name ?? merged.name,
      description: body.description ?? merged.description,
      config: configOverride,
      is_active: body.is_active ?? existingRow?.is_active ?? merged.is_active,
      execution_mode: body.execution_mode ?? existingRow?.execution_mode ?? merged.execution_mode,
    })

    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 500 })
    }

    try {
      const agentPatch: Parameters<typeof updateAgentConfig>[0] = {
        ...dlmmConfigToAgentPatch(merged.config),
      }
      const mode =
        body.execution_mode ?? existingRow?.execution_mode ?? merged.execution_mode
      if (mode === 'sim_only' || mode === 'ab_parallel') {
        agentPatch.dry_run = true
      } else if (mode === 'live_only' && body.confirm_live) {
        agentPatch.dry_run = false
      }
      if (body.is_active === true || (body.is_active == null && merged.is_active)) {
        agentPatch.enabled = true
      } else if (body.is_active === false) {
        agentPatch.enabled = false
      }
      await updateAgentConfig(agentPatch)
    } catch (err) {
      console.warn('[strategies/patch] dlmm_agent_config sync failed:', err)
    }

    invalidateDlmmStrategyCache()
    const closedPositions = await closeIfDeactivating({
      strategyId: id,
      domain: 'dlmm',
      wasActive,
      nextActive: body.is_active,
    })
    return NextResponse.json({
      success: true,
      strategy: merged,
      ...(closedPositions ? { closedPositions } : {}),
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
