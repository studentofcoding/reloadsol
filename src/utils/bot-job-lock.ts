import { hostname } from 'node:os'
import { query } from '@/utils/db'
import {
  formatDbConnectionError,
  isDbCircuitOpen,
  isDbQuotaOrTimeoutError,
} from '@/utils/db-health'

const DEFAULT_TTL_SEC = parseInt(process.env.BOT_JOB_LOCK_TTL_SEC || '600', 10)

/**
 * Identity of this process, stable for its lifetime: host, pid, and the epoch it booted at.
 *
 * `locked_by` used to be a fresh random uuid per acquire, which could never be traced back to the
 * process holding the row — so when a deploy killed a cycle mid-run, nothing could tell that its
 * lock was dead and every tick waited out the whole TTL. A bare pid is not enough either: pids get
 * recycled, so the boot epoch is what distinguishes this process from a later one reusing its pid.
 */
const INSTANCE_HOST = hostname()
const INSTANCE_BOOTED_AT = Math.round(Date.now() - process.uptime() * 1000)
export const INSTANCE_ID = `${INSTANCE_HOST}:${process.pid}:${INSTANCE_BOOTED_AT}`

export interface LockOwner {
  host: string
  pid: number
  bootedAt: number
}

/** Parse an owner written by INSTANCE_ID. Legacy `worker-<uuid>` rows and junk parse to null. */
export function parseLockOwner(lockedBy: string | null | undefined): LockOwner | null {
  if (!lockedBy) return null
  const parts = lockedBy.split(':')
  if (parts.length !== 3) return null
  const [host, pidRaw, bootRaw] = parts
  // Digits only: Number('') is 0 and Number('4.5') is 4.5, so coercing would accept `web-1:42:`
  // and `web-1:4.5:…` as owners — and the sweep acts on whatever this returns.
  if (!host || !/^\d+$/.test(pidRaw) || !/^\d+$/.test(bootRaw)) return null
  const pid = Number(pidRaw)
  if (pid <= 0) return null
  return { host, pid, bootedAt: Number(bootRaw) }
}

/**
 * A lock is orphaned when its owner ran on THIS host and can no longer release it: its pid is gone,
 * or its pid is alive but belongs to a different process epoch (a recycled pid).
 *
 * Owners on other hosts are deliberately left alone — a pid only means something on the machine it
 * ran on, which is why the TTL stays as the cross-host backstop. Legacy rows without a parseable
 * owner are never swept, so this cannot delete a row it does not understand.
 */
export function isOrphanedLock(
  lockedBy: string | null | undefined,
  opts: { host: string; selfPid: number; selfBootedAt: number; isPidAlive: (pid: number) => boolean },
): boolean {
  const owner = parseLockOwner(lockedBy)
  if (!owner) return false
  if (owner.host !== opts.host) return false
  if (owner.pid === opts.selfPid) return owner.bootedAt !== opts.selfBootedAt
  return !opts.isPidAlive(owner.pid)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the pid exists but belongs to another user. Anything else: it is gone.
    return (error as { code?: string } | null)?.code === 'EPERM'
  }
}

/**
 * Clear rows left behind by processes on this host that are no longer running — the deploy/crash
 * case. Cheap: only same-host rows are fetched, and a guarded delete means we can only ever remove
 * the exact row we inspected, so a live owner that re-acquired in the meantime is untouched.
 */
export async function sweepOrphanedLocks(): Promise<number> {
  const { rows } = await query<{ job_name: string; locked_by: string | null }>(
    `SELECT job_name, locked_by FROM bot_job_locks WHERE locked_by LIKE $1`,
    [`${INSTANCE_HOST}:%`],
  )
  let removed = 0
  for (const row of rows) {
    if (row.locked_by === INSTANCE_ID) continue
    const orphaned = isOrphanedLock(row.locked_by, {
      host: INSTANCE_HOST,
      selfPid: process.pid,
      selfBootedAt: INSTANCE_BOOTED_AT,
      isPidAlive,
    })
    if (!orphaned) continue
    await query(`DELETE FROM bot_job_locks WHERE job_name = $1 AND locked_by = $2`, [
      row.job_name,
      row.locked_by,
    ])
    removed += 1
    console.warn(
      `[bot-job-lock] cleared orphaned lock ${row.job_name} left by ${row.locked_by} (process gone)`,
    )
  }
  return removed
}

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
  const lockedBy = INSTANCE_ID

  await query(
    `DELETE FROM bot_job_locks WHERE expires_at < $1`,
    [now.toISOString()],
  )
  // Then the deploy case: a row whose owner process no longer exists is dead now, not at its TTL.
  await sweepOrphanedLocks().catch(() => 0)

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

/**
 * Release a lock, but only if this instance still owns it. Every caller today releases a lock it
 * just acquired in the same process, so the owner check is exact — and it stops a stale process
 * from freeing a row a live one is holding.
 */
export async function releaseJobLock(jobName: string): Promise<void> {
  if (isDbCircuitOpen()) return
  await query(`DELETE FROM bot_job_locks WHERE job_name = $1 AND locked_by = $2`, [
    jobName,
    INSTANCE_ID,
  ])
}

/**
 * Extend a lock this instance already holds.
 *
 * The TTL is the only backstop that works across hosts: `sweepOrphanedLocks` can prove a
 * same-host owner is dead, but a container recreate gets a NEW hostname, so a lock left by the
 * previous container is a foreign owner and has to be waited out. That made a deploy-killed sweep
 * cost the whole TTL — and with a 15-minute cadence and a 600 s TTL, one death also skipped the
 * next run.
 *
 * Renewing lets the TTL be short enough to be a good backstop rather than a cost: a live sweep keeps
 * its own lock alive, and a dead one frees the job in one TTL. Guarded by `locked_by`, so a stale
 * process can never extend a lock that a live one has taken over.
 */
export async function renewJobLock(
  jobName: string,
  ttlSeconds = DEFAULT_TTL_SEC,
): Promise<boolean> {
  if (isDbCircuitOpen()) return false
  try {
    const { rowCount } = await query(
      `UPDATE bot_job_locks SET expires_at = $1 WHERE job_name = $2 AND locked_by = $3`,
      [new Date(Date.now() + ttlSeconds * 1000).toISOString(), jobName, INSTANCE_ID],
    )
    return rowCount > 0
  } catch (error) {
    // Best effort: a failed renewal is not a failure of the work the lock protects. If the DB stays
    // unreachable the lock simply expires and the next tick re-acquires it.
    console.warn(`[bot-job-lock] renew failed for ${jobName}:`, formatDbConnectionError(error))
    return false
  }
}

/**
 * Keep a held lock alive while `run` executes, then stop. Returns the timer so the caller can clear
 * it; unref'd so a forgotten handle can never keep the process alive.
 */
export function startJobLockHeartbeat(
  jobName: string,
  ttlSeconds: number,
  intervalSeconds: number,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void renewJobLock(jobName, ttlSeconds)
  }, Math.max(5, intervalSeconds) * 1000)
  timer.unref?.()
  return timer
}

/**
 * Lease length for `withJobLock`. The route-level `ttlSeconds` (900 s for the sim-track routes) used to be
 * the lease itself, so a web restart that killed a run left the lock held for up to 15 min — and a
 * container recreate gets a NEW hostname, so `sweepOrphanedLocks` can't prove the owner is dead.
 * Observed on prod: `signals_sim_track` had no successful run for ~15 min after each web ship.
 * Now the lock is a short lease renewed by a heartbeat while the run is alive.
 */
export const JOB_LOCK_LEASE_SEC = Math.max(
  30,
  parseInt(process.env.BOT_JOB_LOCK_LEASE_SEC || '90', 10) || 90,
)

/**
 * Run a cron route body under a job lock; overlapping ticks get 409 `skipped`.
 *
 * `ttlSeconds` is now the MAXIMUM hold time (a hung run still frees the job after it); the stored lease
 * is `min(ttlSeconds, JOB_LOCK_LEASE_SEC)`, renewed every third of a lease until then. A dead owner's
 * lock therefore lapses within one lease instead of one `ttlSeconds`.
 */
export async function withJobLock(
  jobName: string,
  ttlSeconds: number,
  run: () => Promise<Response>,
): Promise<Response> {
  const lease = Math.min(ttlSeconds, JOB_LOCK_LEASE_SEC)
  const lock = await acquireJobLock(jobName, lease)
  if (!lock.acquired) {
    return Response.json(
      { success: false, skipped: true, reason: lock.reason },
      { status: 409 },
    )
  }
  const startedAt = Date.now()
  const heartbeat = setInterval(() => {
    if (Date.now() - startedAt < ttlSeconds * 1000) void renewJobLock(jobName, lease)
  }, Math.max(5, Math.floor(lease / 3)) * 1000)
  heartbeat.unref?.()
  try {
    return await run()
  } finally {
    clearInterval(heartbeat)
    await releaseJobLock(jobName)
  }
}
