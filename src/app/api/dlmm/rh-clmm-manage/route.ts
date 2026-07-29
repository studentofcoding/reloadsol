import { NextRequest, NextResponse } from 'next/server'
import { rejectWrongNetwork } from '@/utils/app-network-api'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import { runRhClmmManageCycle } from '@/utils/dlmm/rh-clmm-manage.server'

/**
 * RH CLMM manage cycle — alert-only (rec 3.1 phase A).
 * Read-only: RPC reads + Telegram alerts; no signing, no writes.
 */
export async function POST(req: NextRequest) {
  const wrong = rejectWrongNetwork(req, 'robinhood')
  if (wrong) return wrong

  const { searchParams } = new URL(req.url)
  const key = searchParams.get('key')
  if (!isAuthorizedRequest(key, process.env.DLMM_MANAGE_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { acquireJobLock, releaseJobLock } = await import('@/utils/bot-job-lock')
  const jobLock = await acquireJobLock('rh_clmm_manage', 300)
  if (!jobLock.acquired) {
    return NextResponse.json(
      { success: false, skipped: true, reason: jobLock.reason },
      { status: 409 },
    )
  }

  try {
    const result = await runRhClmmManageCycle()
    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'RH CLMM manage failed',
        checked: 0,
        oorCount: 0,
        alertsSent: 0,
        alerts: [],
      },
      { status: 500 },
    )
  } finally {
    await releaseJobLock('rh_clmm_manage')
  }
}

export async function GET(req: NextRequest) {
  return POST(req)
}
