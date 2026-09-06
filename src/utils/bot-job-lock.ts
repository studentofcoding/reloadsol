import { query } from '@/utils/db'
import {
  formatDbConnectionError,
  isDbCircuitOpen,
  isDbQuotaOrTimeoutError,
} from '@/utils/db-health'

const DEFAULT_TTL_SEC = parseInt(process.env.BOT_JOB_LOCK_TTL_SEC || '600', 10)

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === '23505'
  )
}

/** Prevent overlapping cron/API job runs across server instances. */
export async function acquireJobLock(
  jobName: string,
  ttlSeconds = DEFAULT_TTL_SEC,
): Promise<{ acquired: boolean; reason?: string }> {
  if (isDbCircuitOpen()) {
    return {
      acquired: false,
      reason: 'Database circuit open — skipping job until cooldown',
    }
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString()
  const lockedBy = `worker-${crypto.randomUUID()}`

  await query(
    `DELETE FROM bot_job_locks WHERE expires_at < $1`,
    [now.toISOString()],
  )

  try {
    await query(
      `INSERT INTO bot_job_locks (job_name, locked_at, locked_by, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [jobName, now.toISOString(), lockedBy, expiresAt],
    )
    return { acquired: true }
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        acquired: false,
        reason: `Job "${jobName}" already running`,
      }
    }

    const reason = formatDbConnectionError(error)
    console.warn(`[bot-job-lock] lock insert failed for ${jobName}:`, reason)
    return {
      acquired: false,
      reason: isDbQuotaOrTimeoutError(error)
        ? 'Database unavailable (timeout) — job skipped'
        : reason,
    }
  }
}

export async function releaseJobLock(jobName: string): Promise<void> {
  if (isDbCircuitOpen()) return
  await query(`DELETE FROM bot_job_locks WHERE job_name = $1`, [jobName])
}

/** Run a cron route body under a job lock; overlapping ticks get 409 `skipped`. */
export async function withJobLock(
  jobName: string,
  ttlSeconds: number,
  run: () => Promise<Response>,
): Promise<Response> {
  const lock = await acquireJobLock(jobName, ttlSeconds)
  if (!lock.acquired) {
    return Response.json(
      { success: false, skipped: true, reason: lock.reason },
      { status: 409 },
    )
  }
  try {
    return await run()
  } finally {
    await releaseJobLock(jobName)
  }
}
