import { NextResponse } from 'next/server'
import { drainSimOpenAlerts } from '@/strategies/mcap-sim-open-alerts'
import { drainGmgnLiveBoostToasts } from '@/strategies/gmgn-live-boost'
import { drainSignalsEarlyAlerts } from '@/strategies/signals-early-alerts'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    // Stage-1 early enter first, then Stage-2 sim-open confirms
    const alerts = [
      ...drainSignalsEarlyAlerts(),
      ...drainSimOpenAlerts(),
      ...drainGmgnLiveBoostToasts(),
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
