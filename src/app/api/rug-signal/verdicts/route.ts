import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import { isServiceAuthorizedRequest, requireDevSession } from '@/utils/api-auth'
import { loadRugVerdicts, rugVerdictHealth } from '@/strategies/rug-verdicts'

/**
 * Reader for `rug_verdicts` — one verdict per token, on the fixed 10-minute block.
 *
 * A sink with no reader is a dead store, and this one is meant to be read: it is the corpus the ML
 * label joins to, and the only place the per-token statistic is native rather than a per-mint dedupe
 * bolted onto a re-judged log.
 *
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
    const raw = Number(searchParams.get('limit'))
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 100
    const [verdicts, health] = await Promise.all([loadRugVerdicts(limit), rugVerdictHealth()])
    return NextResponse.json({ success: true, verdicts, health })
  } catch (error) {
    log.error('error_handling', 'rug-signal verdicts read failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  }
}
