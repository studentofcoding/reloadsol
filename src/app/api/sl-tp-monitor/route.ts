import { NextRequest, NextResponse, connection } from 'next/server'
import { 
  addSLTPPosition, 
  cleanupOldSLTPPositions,
  syncExistingOpenPositions,
  runSLTPMonitorAndSummarize,
  getSLTPTrackingSummary
} from '@/utils/sl-tp-tracker'
import { log } from '@/utils/unified-logger'
import { timingSafeEqual } from 'node:crypto'

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Fail CLOSED. The previous form fell back to a literal that is committed to this (public) repo
 * when TRENDING_TRACKER_SECRET was unset, so a mis-set env turned the money-path routes below into
 * "anyone who read the source". No secret configured = nobody is authorised.
 */
function isServiceAuthorized(request: NextRequest): boolean {
  const expected = process.env.TRENDING_TRACKER_SECRET?.trim()
  if (!expected) return false
  const key = new URL(request.url).searchParams.get('key')
  if (key && safeEqual(key, expected)) return true
  const auth = request.headers.get('authorization')
  return auth != null && safeEqual(auth, `Bearer ${expected}`)
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

// GET - Monitor all active SL/TP positions
export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')
    const wallet = searchParams.get('wallet')
    const mode = searchParams.get('mode') // optional: 'summary' | 'monitor'

    // /api/sl-tp-monitor sits in no wallet/dev tier (src/config/api-access.ts), so the edge treats it
    // as `open`: every verb below was reachable without credentials. Auth is therefore enforced here.
    if (!isServiceAuthorized(request)) return unauthorized()

    if (action === 'sync' && wallet) {
      // Sync existing open positions for a specific wallet
      const result = await syncExistingOpenPositions(wallet)
      
      return NextResponse.json({
        success: true,
        message: 'Sync completed',
        result
      })
    }

    // If client only wants the current summary without running monitor
    if (mode === 'summary') {
      const summary = await getSLTPTrackingSummary()
      return NextResponse.json({
        success: true,
        message: 'SL/TP tracking summary fetched',
        summary
      })
    }

    // Default action: run monitoring and return comprehensive summary (cron)
    const { acquireJobLock, releaseJobLock } = await import('@/utils/bot-job-lock')
    const jobLock = await acquireJobLock('sltp_monitor', 120)
    if (!jobLock.acquired) {
      return NextResponse.json(
        { success: false, skipped: true, reason: jobLock.reason },
        { status: 409 },
      )
    }

    // NO HEARTBEAT, and that is deliberate. One was added in 2e96be7 alongside this lock, because
    // the TTL (120s) equalled the Go client's per-pass timeout (main.go, runSLTPMonitor) — so a pass
    // that outlived its own timeout lost the lock while still running and the next 60s tick started a
    // SECOND pass over the same positions.
    //
    // Two things have changed since. `closeSimulatedPositionFromWorker` now checks whether the trade
    // already closed before writing anything (a40738e), so a concurrent pass is safe rather than a
    // double-close. And the heartbeat renews indefinitely, which means one slow pass never yields:
    // observed on 2026-10-02 as every tick reporting "previous run still in progress" for half an
    // hour while positions went unmanaged. It was protecting against a hazard that no longer exists
    // and starving the queue in exchange.
    //
    // So the lock is a 120s "one pass at a time" courtesy again, aligned with the client's own
    // timeout: a pass that overruns it is abandoned by the caller anyway, and the next tick takes
    // over. The lock still stops two passes starting simultaneously; it just no longer stops a stuck
    // one from ever being replaced.
    try {
      const summary = await runSLTPMonitorAndSummarize()

      return NextResponse.json({
        success: true,
        message: 'SL/TP monitoring completed',
        counts: {
          active: summary.statistics.total_active,
          finished: summary.statistics.total_finished,
          totalTrackedTokens: summary.statistics.total_tracked_tokens,
        },
        summary,
      })
    } finally {
      await releaseJobLock('sltp_monitor')
    }

  } catch (error) {
    log.error('error_handling', 'SL/TP monitor API error', error as Error)
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}

// POST - Add new SL/TP position
export async function POST(request: NextRequest) {
  if (!isServiceAuthorized(request)) return unauthorized()
  try {
    const body = await request.json()
    
    const positionId = await addSLTPPosition(body)
    
    return NextResponse.json({
      success: true,
      positionId,
      message: 'SL/TP position added successfully'
    })

  } catch (error) {
    log.error('error_handling', 'Failed to add SL/TP position via API', error as Error)
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}

// DELETE - Clean up old positions
export async function DELETE(request: NextRequest) {
  if (!isServiceAuthorized(request)) return unauthorized()
  try {
    const { searchParams } = new URL(request.url)
    // NaN would make `setDate(NaN)` an Invalid Date and the cleanup a no-op or an error; negative
    // would push the cutoff into the future and delete every inactive row. Clamp to >= 1 day.
    const parsedDays = parseInt(searchParams.get('days') || '30', 10)
    const daysOld = Number.isFinite(parsedDays) ? Math.max(1, parsedDays) : 30
    
    await cleanupOldSLTPPositions(daysOld)
    
    return NextResponse.json({
      success: true,
      message: `Cleaned up positions older than ${daysOld} days`
    })

  } catch (error) {
    log.error('error_handling', 'Failed to cleanup old SL/TP positions via API', error as Error)
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 })
  }
}