import { NextRequest, NextResponse } from 'next/server'
import { backfillOutcomeLabels } from '@/strategies/db'
import { CLOSED_LOOP_PRINCIPAL_IDS } from '@/strategies/closed-loop-ml'
import { isMlRouteAuthorized } from '@/strategies/ml-api-auth'
import type { StrategyDomain } from '@/strategies/types'

export async function POST(request: NextRequest) {
  const authError = isMlRouteAuthorized(request)
  if (authError) {
    return authError
  }

  try {
    const { searchParams } = new URL(request.url)
    const domain = searchParams.get('domain') as StrategyDomain | null
    const strategyId = searchParams.get('strategyId') ?? undefined
    const dryRun = searchParams.get('dry_run') === 'true'
    const principals = searchParams.get('principals') === 'true'

    const result = await backfillOutcomeLabels({
      domain: domain ?? undefined,
      strategyId: principals ? undefined : strategyId,
      strategyIds: principals ? [...CLOSED_LOOP_PRINCIPAL_IDS] : undefined,
      dryRun,
    })

    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      principals,
      ...result,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
