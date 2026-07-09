import { NextResponse } from 'next/server'
import { drainSimOpenAlerts } from '@/strategies/mcap-sim-open-alerts'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const alerts = drainSimOpenAlerts()
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
