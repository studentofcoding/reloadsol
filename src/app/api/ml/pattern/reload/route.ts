import { NextRequest, NextResponse } from 'next/server'
import { getPatternRuntimeLoadStatus } from '@/strategies/entry-pattern-scorer.server'
import { resetPatternScorerCache } from '@/strategies/entry-pattern-scorer-cache'
import { isAuthorizedRequest } from '@/utils/dlmm/config'

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

  resetPatternScorerCache()
  const reloadedAt = new Date().toISOString()
  const runtime = await getPatternRuntimeLoadStatus()

  return NextResponse.json({
    success: true,
    reloaded_at: reloadedAt,
    runtime_loaded: runtime.runtime_loaded,
    model_version: runtime.model_version,
    ...(runtime.error ? { error: runtime.error } : {}),
  })
}
