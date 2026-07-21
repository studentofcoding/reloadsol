import { NextRequest, NextResponse } from 'next/server'
import { runRosterWatch } from '@/strategies/wallet-digger/watch'
import { isAuthorizedRequest } from '@/utils/dlmm/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function getSecret(): string {
  return (
    process.env.GMGN_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runRosterWatch()
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
