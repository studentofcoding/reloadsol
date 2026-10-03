import { NextRequest, NextResponse, connection } from 'next/server'
import { hasTrendingTrackerSecret } from '@/utils/api-auth'
import { query } from '@/utils/db'
import { log } from '@/utils/unified-logger'
import { createR2Store, r2ConfigFromEnv, r2MissingEnv } from '@/utils/r2-store'
import {
  archiveConfigFromEnv,
  isArchiveEnabled,
  runEvidenceArchive,
} from '@/strategies/evidence-archive'

/**
 * Daily evidence archive (cron `evidence_archive`, default every 24 h).
 * Postgres -> append-only gzip NDJSON in R2. SPEC: docs/specs/SPEC-evidence-bar-archive-v1.md
 *
 * Inert until `EVIDENCE_ARCHIVE_ENABLED=1`. Enabled without R2 credentials it answers 503 naming the
 * missing env VARIABLE NAMES (never values), so the Go worker records a loud failure.
 * Auth = `?key=` / `Bearer` TRENDING_TRACKER_SECRET. Job lock -> 409 skip.
 */
const LOCK = 'evidence_archive'

export async function POST(request: NextRequest) {
  await connection()
  if (!hasTrendingTrackerSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!isArchiveEnabled()) {
    return NextResponse.json({ success: true, skipped: true, reason: 'EVIDENCE_ARCHIVE_ENABLED is not 1 (or kill switch on)' })
  }
  const cfg = r2ConfigFromEnv()
  if (!cfg) {
    return NextResponse.json(
      { success: false, error: 'R2 credentials missing', missing_env: r2MissingEnv() },
      { status: 503 },
    )
  }

  const { acquireJobLock, releaseJobLock, startJobLockHeartbeat } = await import('@/utils/bot-job-lock')
  const ttl = 600
  const lock = await acquireJobLock(LOCK, ttl)
  if (!lock.acquired) {
    return NextResponse.json({ success: false, skipped: true, reason: lock.reason }, { status: 409 })
  }
  const heartbeat = startJobLockHeartbeat(LOCK, ttl, 60)
  try {
    const summary = await runEvidenceArchive({
      query,
      store: createR2Store(cfg),
      now: new Date(),
      config: archiveConfigFromEnv(),
      log: {
        info: (m, ctx) => log.info('api_request', `evidence_archive: ${m}`, ctx as Record<string, unknown>),
        warn: (m, ctx) => log.warn('api_request', `evidence_archive: ${m}`, ctx as Record<string, unknown>),
      },
    })
    const failed = summary.failed > 0
    // removeConsole strips info in prod builds; warn survives, and this is one line a day.
    log.warn('api_request', 'evidence_archive: run complete', {
      days: summary.days,
      ok: summary.ok,
      failed: summary.failed,
    })
    return NextResponse.json(
      {
        success: !failed,
        days: summary.days,
        ok: summary.ok,
        failed: summary.failed,
        manifests: summary.manifests,
        results: summary.results.map((r) => ({
          dataset: r.dataset,
          day: r.day,
          status: r.status,
          rows: r.rows ?? 0,
          bytes_gz: r.bytesGz ?? 0,
          detail: r.detail ?? null,
        })),
      },
      { status: failed ? 500 : 200 },
    )
  } catch (error) {
    log.error('error_handling', 'evidence archive crashed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  } finally {
    clearInterval(heartbeat)
    await releaseJobLock(LOCK)
  }
}
