import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import { isServiceAuthorizedRequest, requireDevSession } from '@/utils/api-auth'
import {
  recordCalibrationRun,
  replayRugSignal,
  sanitizeOverrides,
} from '@/strategies/rug-signal-calibration'

/**
 * Run a rug-signal calibration replay: re-score the stored observations under candidate anchors.
 *
 * Read-only with respect to the product — it writes no verdict, no series row and no shadow row. Its
 * only write is its own run record (`rug_signal_calibration`) so settings stay comparable over time.
 *
 * Body: `{ days?: number, overrides?: {...anchors}, persist?: boolean }`. Overrides are whitelisted
 * and range-checked; unknown or non-finite keys are dropped rather than spread into the scorer.
 *
 * Auth: the service secret (cron/curl) **or** a dev-wallet session (the `/dev/rug-signal` page).
 * The page never sees the service secret — it rides the same signed wallet session the rest of the
 * dev tools use, so the gate is respected rather than bypassed.
 */

function isAuthorized(request: NextRequest): boolean {
  if (isServiceAuthorizedRequest(request)) return true
  return !(requireDevSession(request) instanceof NextResponse)
}

export async function POST(request: NextRequest) {
  await connection()
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      days?: number
      overrides?: unknown
      persist?: boolean
    }
    const run = await replayRugSignal({
      days: body.days,
      overrides: sanitizeOverrides(body.overrides),
    })
    if (body.persist !== false) await recordCalibrationRun(run)
    return NextResponse.json({ success: true, run })
  } catch (error) {
    log.error('error_handling', 'rug-signal calibration failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
