import { NextRequest, NextResponse } from 'next/server'
import { refreshReportPrecompute } from '@/strategies/report-precompute'
import { isAuthorizedRequest } from '@/utils/dlmm/config'

/** ~28 filter shapes x (consensus + capital); measured well under a minute. */
export const maxDuration = 300

/** Same shared secret the Go cron passes to the other scheduled API calls. */
function getPrecomputeSecret(): string {
  return (
    process.env.STRATEGY_REPORT_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getPrecomputeSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const run = await refreshReportPrecompute()
    return NextResponse.json({ success: run.failed === 0, ...run })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
