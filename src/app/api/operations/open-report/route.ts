import { NextRequest, NextResponse, connection } from 'next/server'
import { hasTrendingTrackerSecret } from '@/utils/api-auth'
import { log } from '@/utils/unified-logger'
import { isOpenReportEnabled, runOpenReport, type OpenReportMode } from '@/strategies/open-reporter'

/**
 * Opens reporter tick (cron `open_report`, default hourly). SPEC: docs/specs/SPEC-open-attempts-reporting-v1.md
 *
 * `?mode=auto` (default) posts the hourly summary, the daily one at OPEN_REPORT_DAILY_HOUR_WIB, and any due
 * alerts. `?dry=1` returns the texts without sending or touching the cooldown table.
 * Auth = `?key=` / Bearer TRENDING_TRACKER_SECRET. Reporting only: opens nothing, changes nothing.
 */
const MODES = new Set<OpenReportMode>(['auto', 'hourly', 'daily', 'alerts'])
const LOCK = 'open_report'

export async function POST(request: NextRequest) {
  await connection()
  if (!hasTrendingTrackerSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isOpenReportEnabled()) {
    return NextResponse.json({ success: true, skipped: true, reason: 'OPEN_REPORT_ENABLED is off' })
  }
  const modeParam = (request.nextUrl.searchParams.get('mode') ?? 'auto') as OpenReportMode
  if (!MODES.has(modeParam)) {
    return NextResponse.json({ error: 'mode must be auto|hourly|daily|alerts' }, { status: 400 })
  }
  const dry = request.nextUrl.searchParams.get('dry') === '1'

  const { acquireJobLock, releaseJobLock } = await import('@/utils/bot-job-lock')
  const lock = await acquireJobLock(LOCK, 120)
  if (!lock.acquired) {
    return NextResponse.json({ success: true, skipped: true, reason: lock.reason }, { status: 409 })
  }
  try {
    const run = await runOpenReport(modeParam, { dry })
    return NextResponse.json({
      success: true,
      skipped: run.skipped.length > 0 && run.posts.length === 0,
      dry: run.dry,
      telegram_configured: run.telegram,
      skipped_reasons: run.skipped,
      posts: run.posts.map((p) => ({ key: p.key, sent: p.sent, ...(dry ? { text: p.text } : {}) })),
    })
  } catch (error) {
    log.error('error_handling', 'open-report tick failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  } finally {
    await releaseJobLock(LOCK)
  }
}
