import { NextRequest, NextResponse, connection } from 'next/server'
import { trainAndPersistClosedLoopModel } from '@/strategies/closed-loop-ml.server'
import { isMlRouteAuthorized } from '@/strategies/ml-api-auth'

export const maxDuration = 120

export async function POST(request: NextRequest) {
  await connection()
  const authError = isMlRouteAuthorized(request)
  if (authError) return authError

  try {
    const dryRun = request.nextUrl.searchParams.get('dry_run') === 'true'
    const result = await trainAndPersistClosedLoopModel({ dryRun })
    return NextResponse.json({
      success: true,
      dry_run: dryRun,
      modelVersion: result.model.version,
      model_type: result.model.model_type,
      used: result.used,
      skipped_unlabeled: result.skipped_unlabeled,
      skipped_not_principal: result.skipped_not_principal,
      path: result.path,
      metrics: result.model.metrics,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
