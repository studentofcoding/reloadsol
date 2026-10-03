import { NextRequest, NextResponse } from 'next/server'
import { resetPatternScorerCache } from '@/strategies/entry-pattern-scorer-cache'
import { isAuthorizedRequest } from '@/utils/dlmm/config'


type PatternScorerModule = typeof import('@/strategies/entry-pattern-scorer.server')

function getPatternScorer(): Promise<PatternScorerModule> {
  return import('@/strategies/entry-pattern-scorer.server')
}

function getMlSecret(): string {
  return (
    process.env.MCAP_TRACKER_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    ''
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
  const runtime = await (await getPatternScorer()).getPatternRuntimeLoadStatus()

  return NextResponse.json({
    success: true,
    reloaded_at: reloadedAt,
    runtime_loaded: runtime.runtime_loaded,
    pattern_ready: runtime.pattern_ready,
    model_version: runtime.model_version,
    schema_ok: runtime.schema_ok,
    ...(runtime.schema_error ? { schema_error: runtime.schema_error } : {}),
    ...(runtime.error ? { error: runtime.error } : {}),
  })
}
