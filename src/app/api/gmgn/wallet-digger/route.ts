import { NextRequest, NextResponse } from 'next/server'
import { getMergedGmgnRegistry } from '@/strategies/load-gmgn'
import { runWalletDigger } from '@/strategies/wallet-digger/digger'
import { isAuthorizedRequest } from '@/utils/dlmm/config'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

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
    const registry = await getMergedGmgnRegistry()
    const strategy = registry.gmgn_roster_concurrence
    const result = await runWalletDigger({
      rosterConfig: strategy?.config.roster,
    })
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
