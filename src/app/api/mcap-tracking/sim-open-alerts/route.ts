import { NextRequest, NextResponse, connection } from 'next/server'
import { drainSimOpenAlerts } from '@/strategies/mcap-sim-open-alerts'
import { drainGmgnLiveBoostToasts } from '@/strategies/gmgn-live-boost'
import { drainSignalsEarlyAlerts } from '@/strategies/signals-early-alerts'
import { parseDbChain } from '@/utils/app-network-db'


export async function GET(request: NextRequest) {
  await connection()
  try {
    const chain = parseDbChain(request.nextUrl.searchParams.get('chain'))
    // Stage-1 early enter first, then Stage-2 sim-open confirms
    const alerts = [
      ...drainSignalsEarlyAlerts(chain),
      ...drainSimOpenAlerts(chain),
      ...drainGmgnLiveBoostToasts(chain),
    ]
    return NextResponse.json(
      { success: true, alerts },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        alerts: [],
      },
      { status: 500 },
    )
  }
}
