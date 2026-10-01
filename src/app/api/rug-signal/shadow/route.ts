import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import { isServiceAuthorizedRequest, requireDevSession } from '@/utils/api-auth'
import { loadRugSignalShadow } from '@/strategies/rug-signal-shadow'

/**
 * Reader for the rug signal's counterfactual log (`rug_signal_shadow`).
 *
 * A shadow sink without a reader is a dead store, and the whole point of this one is to be read: the
 * validation needs the score distribution of tokens that **did** collapse against those that did
 * not, and the control half only exists because every evaluation is recorded, not just the trips.
 *
 * `?token=<mint>` traces one verdict; `?decision=would_rug|pass|no_bars` filters the population;
 * `?limit=` is clamped in the reader. Read-only.
 */

function isAuthorized(request: NextRequest): boolean {
  if (isServiceAuthorizedRequest(request)) return true
  return !(requireDevSession(request) instanceof NextResponse)
}

export async function GET(request: NextRequest) {
  await connection()
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const limitRaw = Number(searchParams.get('limit'))
    const { entries, summary } = await loadRugSignalShadow({
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100,
      tokenAddress: searchParams.get('token'),
      decision: searchParams.get('decision'),
    })
    return NextResponse.json({ success: true, summary, entries })
  } catch (error) {
    log.error('error_handling', 'rug-signal shadow read failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
