import { query, queryOne } from '@/utils/db'

export type CronWorkerRuntimeRow = {
  worker_id: string
  last_started_at: string | null
  last_success_at: string | null
  last_error_at: string | null
  last_error_msg: string | null
  /** Last tick skipped because the job lock was held. A skip is the worker working, not failing. */
  last_skipped_at: string | null
  updated_at: string | null
}

export type CronWorkerRuntimeEvent = 'begin' | 'success' | 'fail' | 'skipped'

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS cron_worker_runtime (
  worker_id TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_msg TEXT,
  last_skipped_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

// `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so the column has to be
// added separately or every deployment against an existing volume keeps the old shape.
const ENSURE_SKIPPED_COLUMN_SQL = `
ALTER TABLE cron_worker_runtime
  ADD COLUMN IF NOT EXISTS last_skipped_at TIMESTAMPTZ`

let ensurePromise: Promise<void> | null = null

export async function ensureCronWorkerRuntimeTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = query(ENSURE_SQL)
      .then(() => query(ENSURE_SKIPPED_COLUMN_SQL))
      .then(() => undefined)
      .catch((err) => {
        ensurePromise = null
        throw err
      })
  }
  await ensurePromise
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d.toISOString()
  }
  return null
}

export async function listCronWorkerRuntime(): Promise<CronWorkerRuntimeRow[]> {
  await ensureCronWorkerRuntimeTable()
  const { rows } = await query<{
    worker_id: string
    last_started_at: unknown
    last_success_at: unknown
    last_error_at: unknown
    last_error_msg: string | null
    last_skipped_at: unknown
    updated_at: unknown
  }>(
    `SELECT worker_id, last_started_at, last_success_at, last_error_at,
            last_error_msg, last_skipped_at, updated_at
     FROM cron_worker_runtime
     ORDER BY worker_id ASC`,
  )
  return rows.map((r) => ({
    worker_id: r.worker_id,
    last_started_at: toIsoOrNull(r.last_started_at),
    last_success_at: toIsoOrNull(r.last_success_at),
    last_error_at: toIsoOrNull(r.last_error_at),
    last_error_msg: r.last_error_msg ?? null,
    last_skipped_at: toIsoOrNull(r.last_skipped_at),
    updated_at: toIsoOrNull(r.updated_at),
  }))
}

export async function upsertCronWorkerRuntimeEvent(params: {
  workerId: string
  event: CronWorkerRuntimeEvent
  errorMsg?: string | null
  at?: string | null
}): Promise<CronWorkerRuntimeRow | null> {
  const workerId = params.workerId.trim()
  if (!workerId) return null

  await ensureCronWorkerRuntimeTable()

  const at = params.at?.trim() || new Date().toISOString()
  const errorMsg =
    params.event === 'fail' ? (params.errorMsg ?? '').slice(0, 2000) : null

  if (params.event === 'begin') {
    await query(
      `INSERT INTO cron_worker_runtime (worker_id, last_started_at, updated_at)
       VALUES ($1, $2::timestamptz, NOW())
       ON CONFLICT (worker_id) DO UPDATE SET
         last_started_at = EXCLUDED.last_started_at,
         updated_at = NOW()`,
      [workerId, at],
    )
  } else if (params.event === 'success') {
    await query(
      `INSERT INTO cron_worker_runtime (
         worker_id, last_success_at, last_error_msg, updated_at
       ) VALUES ($1, $2::timestamptz, '', NOW())
       ON CONFLICT (worker_id) DO UPDATE SET
         last_success_at = EXCLUDED.last_success_at,
         last_error_msg = '',
         updated_at = NOW()`,
      [workerId, at],
    )
  } else if (params.event === 'skipped') {
    // Deliberately touches neither the success nor the error timestamp: a held job lock means a
    // previous pass is still running, which is the lock working. Before this branch existed the Go
    // side's `skipped` event fell into the failure path below and was recorded as an error.
    await query(
      `INSERT INTO cron_worker_runtime (worker_id, last_skipped_at, updated_at)
       VALUES ($1, $2::timestamptz, NOW())
       ON CONFLICT (worker_id) DO UPDATE SET
         last_skipped_at = EXCLUDED.last_skipped_at,
         updated_at = NOW()`,
      [workerId, at],
    )
  } else {
    await query(
      `INSERT INTO cron_worker_runtime (
         worker_id, last_error_at, last_error_msg, updated_at
       ) VALUES ($1, $2::timestamptz, $3, NOW())
       ON CONFLICT (worker_id) DO UPDATE SET
         last_error_at = EXCLUDED.last_error_at,
         last_error_msg = EXCLUDED.last_error_msg,
         updated_at = NOW()`,
      [workerId, at, errorMsg],
    )
  }

  const row = await queryOne<{
    worker_id: string
    last_started_at: unknown
    last_success_at: unknown
    last_error_at: unknown
    last_error_msg: string | null
    last_skipped_at: unknown
    updated_at: unknown
  }>(
    `SELECT worker_id, last_started_at, last_success_at, last_error_at,
            last_error_msg, last_skipped_at, updated_at
     FROM cron_worker_runtime WHERE worker_id = $1`,
    [workerId],
  )
  if (!row) return null
  return {
    worker_id: row.worker_id,
    last_started_at: toIsoOrNull(row.last_started_at),
    last_success_at: toIsoOrNull(row.last_success_at),
    last_error_at: toIsoOrNull(row.last_error_at),
    last_error_msg: row.last_error_msg ?? null,
    last_skipped_at: toIsoOrNull(row.last_skipped_at),
    updated_at: toIsoOrNull(row.updated_at),
  }
}
