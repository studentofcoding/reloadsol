import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import { isServiceAuthorizedRequest, requireDevSession } from '@/utils/api-auth'
import { loadCalibrationRuns } from '@/strategies/rug-signal-calibration'

/**
 * The stored calibration runs, newest first — what the dev page compares settings against.
 * Read-only. Auth: the service secret or a dev-wallet session (see the calibrate route).
 */

function isAuthorized(request: NextRequest): boolean {
  if (isServiceAuthorizedRequest(request)) return true
  return !(requireDevSession(request) instanceof NextResponse)
}

export async function GET(request: NextRequest) {
  await connection()
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const limitRaw = Number(searchParams.get('limit'))
    const runs = await loadCalibrationRuns(
      Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10,
    )
    return NextResponse.json({ success: true, runs })
  } catch (error) {
    log.error('error_handling', 'rug-signal calibration read failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
