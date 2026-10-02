import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import { isServiceAuthorizedRequest, requireDevSession } from '@/utils/api-auth'
import { loadRugSignalSeparation } from '@/strategies/rug-signal-separation'

/**
 * Separation reader for the rug signal — the dev page's server-side twin of
 * `scripts/rug-signal-validate.mjs`, so the analysis is checkable in a browser instead of only in a
 * terminal. Read-only: it derives the collapse label and never writes a verdict or a label.
 *
 * `?days=` is clamped. Per-row and per-distinct-mint rates are both returned because the same mint is
 * re-evaluated every sweep — the pooled per-row number is the one that overstates the sample.
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
    const raw = Number(searchParams.get('days'))
    const days = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 30) : 4
    const report = await loadRugSignalSeparation(days)
    return NextResponse.json({ success: true, report })
  } catch (error) {
    log.error('error_handling', 'rug-signal separation read failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
