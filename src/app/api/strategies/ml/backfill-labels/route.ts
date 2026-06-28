import { NextRequest, NextResponse } from 'next/server'
import { backfillOutcomeLabels } from '@/strategies/db'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import type { StrategyDomain } from '@/strategies/types'

export const dynamic = 'force-dynamic'

function getMlSecret(): string {
  return (
    process.env.MCAP_TRACKER_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  const devBypass = process.env.NODE_ENV === 'development' && !key
  if (!devBypass && !isAuthorizedRequest(key, getMlSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const domain = searchParams.get('domain') as StrategyDomain | null
    const strategyId = searchParams.get('strategyId') ?? undefined
    const dryRun = searchParams.get('dry_run') === 'true'

    const result = await backfillOutcomeLabels({
      domain: domain ?? undefined,
      strategyId,
      dryRun,
    })

    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      ...result,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
