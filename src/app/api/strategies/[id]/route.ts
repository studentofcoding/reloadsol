import { NextRequest, NextResponse } from 'next/server'
import { TRENDING_BOT_STRATEGIES } from '@/strategies/registry'
import { mergeStrategyOverride } from '@/strategies/merge'
import { invalidateStrategyCache } from '@/strategies/load-strategy'
import { upsertStrategyDefinition } from '@/strategies/db'

export const dynamic = 'force-dynamic'

type PatchBody = {
  is_active?: boolean
  name?: string
  description?: string
  config?: Record<string, unknown>
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const base = TRENDING_BOT_STRATEGIES[id]

    if (!base) {
      return NextResponse.json(
        { success: false, error: `Unknown strategy: ${id}` },
        { status: 404 },
      )
    }

    const body = (await request.json()) as PatchBody
    const configOverride = (body.config ?? {}) as import('@/strategies/types').TrendingBotStrategyOverride

    const merged = mergeStrategyOverride(
      base,
      configOverride,
      body.is_active ?? null,
    )

    const result = await upsertStrategyDefinition({
      id,
      domain: 'trending_bot',
      name: body.name ?? merged.name,
      description: body.description ?? merged.description,
      config: configOverride,
      is_active: body.is_active ?? merged.is_active,
    })

    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 },
      )
    }

    invalidateStrategyCache()

    return NextResponse.json({
      success: true,
      strategy: merged,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
