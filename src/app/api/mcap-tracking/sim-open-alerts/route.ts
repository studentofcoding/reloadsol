import { NextRequest, NextResponse, connection } from 'next/server'
import { drainSimOpenAlerts } from '@/strategies/mcap-sim-open-alerts'
import { drainGmgnLiveBoostToasts } from '@/strategies/gmgn-live-boost'
import { drainSignalsEarlyAlerts } from '@/strategies/signals-early-alerts'
import { parseDbChain } from '@/utils/app-network-db'
import { readRiskChips } from '@/strategies/risk-store'
import type { McapToast } from '@/types/mcap-toasts'

/** Attach the shadow risk chip to each toast item (best-effort, one query). */
async function attachRiskLabels(
  alerts: McapToast[],
  chain: string,
): Promise<void> {
  const addresses = alerts.flatMap((a) => (a.items ?? []).map((i) => i.address))
  if (addresses.length === 0) return
  const chips = await readRiskChips(chain, addresses)
  for (const alert of alerts) {
    for (const item of alert.items ?? []) {
      const chip = chips[item.address]
      if (chip) item.riskLabel = chip.text
    }
  }
}


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
    try {
      await attachRiskLabels(alerts, chain)
    } catch {
      // best-effort label — never fail the alerts payload
    }
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
