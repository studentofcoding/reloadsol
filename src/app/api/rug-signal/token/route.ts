import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import { isServiceAuthorizedRequest, requireDevSession } from '@/utils/api-auth'
import { loadRugSeriesMinutes } from '@/strategies/rug-signal-separation'
import { loadRugSignalShadow } from '@/strategies/rug-signal-shadow'
import { query } from '@/utils/db'

/**
 * One token's evidence, for the chart on the rug-signal dev page.
 *
 * The bars are the *market-cap* minutes the scorer itself reads, so the picture shows what the
 * scorer saw rather than a different series that merely looks similar. The markers are the shadow
 * rows — every evaluation, not just the trips — so the moment a verdict was reached is visible on
 * the series it was reached from.
 *
 * Read-only. Label state comes from the rug registry so the page can show whether the label is
 * already applied; applying it goes through `POST /api/rug` like every other surface.
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
    const address = (searchParams.get('address') ?? '').trim()
    if (!address) {
      return NextResponse.json({ success: false, error: 'address is required' }, { status: 400 })
    }
    const rawHours = Number(searchParams.get('hours'))
    const hours = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(Math.floor(rawHours), 72) : 24

    const [bars, shadow, labelResult] = await Promise.all([
      loadRugSeriesMinutes(address, Math.max(1, Math.ceil(hours / 24))),
      loadRugSignalShadow({ limit: 200, tokenAddress: address }),
      query<{ source: string; added_at: string; token_symbol: string | null }>(
        `SELECT source, added_at::text AS added_at, token_symbol
           FROM token_rug_list WHERE token_address = $1 AND chain = 'sol' LIMIT 1`,
        [address],
      ),
    ])
    const labelRow = labelResult.rows[0]

    const since = Date.now() - hours * 3600 * 1000
    const markers = shadow.entries
      .filter((e) => Date.parse(e.createdAt) >= since)
      .map((e) => ({
        t: Math.floor(Date.parse(e.createdAt) / 1000),
        decision: e.decision,
        score: e.score,
        breakdown: e.breakdown,
        barsScored: e.barsScored,
        reason: e.reason,
      }))
      .filter((m) => Number.isFinite(m.t))

    return NextResponse.json({
      success: true,
      bars,
      markers,
      label: labelRow ? { source: labelRow.source, addedAt: labelRow.added_at } : null,
    })
  } catch (error) {
    log.error('error_handling', 'rug-signal token read failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
