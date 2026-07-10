import { query, queryOne } from '@/utils/db'

export type CronWorkerRuntimeRow = {
  worker_id: string
  last_started_at: string | null
  last_success_at: string | null
  last_error_at: string | null
  last_error_msg: string | null
  updated_at: string | null
}

export type CronWorkerRuntimeEvent = 'begin' | 'success' | 'fail'

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS cron_worker_runtime (
  worker_id TEXT PRIMARY KEY,
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_msg TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

let ensurePromise: Promise<void> | null = null

export async function ensureCronWorkerRuntimeTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = query(ENSURE_SQL)
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
    updated_at: unknown
  }>(
    `SELECT worker_id, last_started_at, last_success_at, last_error_at,
            last_error_msg, updated_at
     FROM cron_worker_runtime
     ORDER BY worker_id ASC`,
  )
  return rows.map((r) => ({
    worker_id: r.worker_id,
    last_started_at: toIsoOrNull(r.last_started_at),
    last_success_at: toIsoOrNull(r.last_success_at),
    last_error_at: toIsoOrNull(r.last_error_at),
    last_error_msg: r.last_error_msg ?? null,
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
    updated_at: unknown
  }>(
    `SELECT worker_id, last_started_at, last_success_at, last_error_at,
            last_error_msg, updated_at
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
    updated_at: toIsoOrNull(row.updated_at),
  }
}
