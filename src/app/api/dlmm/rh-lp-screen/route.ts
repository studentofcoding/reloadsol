import { NextRequest, NextResponse } from 'next/server'
import { DLMM_CONFIG, isAuthorizedRequest } from '@/utils/dlmm/config'
import { runRhLpScreen } from '@/utils/dlmm/rh-lp-screen.server'

/** Worker `rh_lp_screen` (Go cron) → score RH pools + manage paper LP rows. */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const key = searchParams.get('key')
  if (!isAuthorizedRequest(key, DLMM_CONFIG.screenSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { acquireJobLock, releaseJobLock } = await import('@/utils/bot-job-lock')
  const lock = await acquireJobLock('rh_lp_screen', 120)
  if (!lock.acquired) {
    return NextResponse.json(
      { success: false, skipped: true, reason: lock.reason },
      { status: 409 },
    )
  }
  try {
    return NextResponse.json(await runRhLpScreen())
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'RH LP screen failed' },
      { status: 500 },
    )
  } finally {
    await releaseJobLock('rh_lp_screen')
  }
}

export async function GET(req: NextRequest) {
  return POST(req)
}
