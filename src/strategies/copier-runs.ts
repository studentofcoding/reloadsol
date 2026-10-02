import { query } from '@/utils/db'

/**
 * Durable outcome record for the metrics copier — "is the backbone actually running?".
 *
 * The copier's failures lived only in the cron's stdout, and the recorder that would have written
 * them to the DB went through the web app — the very thing that was down 96% of the time. Result: a
 * seven-hour hole in the 1m series was invisible until someone went looking.
 *
 * So the record is written from the side that *is* alive:
 *   * a `running` row at the start of a sweep,
 *   * a terminal row (`completed` / `failed`) at the end.
 *
 * That makes both failure shapes visible without anything watching the process:
 *   * a sweep killed mid-flight (deploy recreate, crash) leaves a `running` row that never finishes;
 *   * a sweep the trigger never reached (EOF / DNS / refused) leaves no row, and the gap between
 *     expected cadence and recorded runs is the hole.
 *
 * **Fail-open, always.** Recording is diagnostics on work that has other reasons to happen, so every
 * function here swallows its own errors and returns a neutral value. A recorder that can fail the
 * sweep would be worse than no recorder — that lesson was learned the hard way on the symbol lookup.
 */

export type CopierRunOutcome = 'running' | 'completed' | 'failed'

export type CopierRunRow = {
  id: string
  startedAt: string
  finishedAt: string | null
  source: string
  outcome: CopierRunOutcome
  detail: string | null
  summary: Record<string, unknown> | null
  durationMs: number | null
}

let ensurePromise: Promise<void> | null = null

/** Created on first use, like `rug_signal_shadow` — this is a log, not a fact about the schema. */
function ensureTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await query(
        `CREATE TABLE IF NOT EXISTS copier_runs (
           id BIGSERIAL PRIMARY KEY,
           started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           finished_at TIMESTAMPTZ,
           source TEXT NOT NULL,
           outcome TEXT NOT NULL,
           detail TEXT,
           summary JSONB
         )`,
      )
      await query(
        `CREATE INDEX IF NOT EXISTS idx_copier_runs_started ON copier_runs(started_at DESC)`,
      )
    })()
      .then(() => undefined)
      .catch((error) => {
        // Let a later call retry rather than caching the failure forever.
        ensurePromise = null
        throw error
      })
  }
  return ensurePromise
}

/** Marks the start of a sweep. Returns an id to finish with, or null if recording is unavailable. */
export async function startCopierRun(source: string): Promise<string | null> {
  try {
    await ensureTable()
    const { rows } = await query<{ id: string }>(
      `INSERT INTO copier_runs (source, outcome) VALUES ($1, 'running') RETURNING id::text AS id`,
      [source],
    )
    return rows[0]?.id ?? null
  } catch {
    return null
  }
}

/** Closes a run. A null id (recording was unavailable at the start) is a no-op. */
export async function finishCopierRun(
  id: string | null,
  outcome: Exclude<CopierRunOutcome, 'running'>,
  detail?: { reason?: string | null; summary?: Record<string, unknown> | null },
): Promise<void> {
  if (!id) return
  try {
    await query(
      `UPDATE copier_runs
          SET finished_at = NOW(),
              outcome = $2,
              detail = $3,
              summary = $4::jsonb
        WHERE id = $1::bigint AND outcome = 'running'`,
      [id, outcome, detail?.reason ?? null, detail?.summary ? JSON.stringify(detail.summary) : null],
    )
  } catch {
    // Ignored on purpose: see the header.
  }
}

/** Last N runs, newest first — the raw material for the panel and for a watchdog. */
export async function loadCopierRuns(limit = 50): Promise<CopierRunRow[]> {
  try {
    await ensureTable()
    const { rows } = await query<{
      id: string
      started_at: string
      finished_at: string | null
      source: string
      outcome: CopierRunOutcome
      detail: string | null
      summary: Record<string, unknown> | null
      duration_ms: string | null
    }>(
      `SELECT id::text AS id, started_at::text AS started_at, finished_at::text AS finished_at,
              source, outcome, detail, summary,
              (EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000)::text AS duration_ms
         FROM copier_runs
        ORDER BY started_at DESC
        LIMIT $1`,
      [Math.min(Math.max(1, Math.floor(limit)), 500)],
    )
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      source: r.source,
      outcome: r.outcome,
      detail: r.detail,
      summary: r.summary,
      durationMs: r.duration_ms == null ? null : Math.round(Number(r.duration_ms)),
    }))
  } catch {
    return []
  }
}

export type CopierRunHealth = {
  windowMinutes: number
  completed: number
  failed: number
  running: number
  /** Runs still marked running past the stuck threshold — the killed-mid-flight signature. */
  stuck: number
  lastCompletedAt: string | null
  lastRunAt: string | null
}

/**
 * Health over a window. `stuckMinutes` separates "running right now" from "running three hours ago",
 * which is the difference between a sweep in progress and one a deploy killed.
 */
export async function copierRunHealth(
  windowMinutes = 180,
  stuckMinutes = 15,
): Promise<CopierRunHealth> {
  const empty: CopierRunHealth = {
    windowMinutes,
    completed: 0,
    failed: 0,
    running: 0,
    stuck: 0,
    lastCompletedAt: null,
    lastRunAt: null,
  }
  try {
    await ensureTable()
    const { rows } = await query<{
      outcome: CopierRunOutcome
      n: string
      stuck: string
      last_at: string | null
    }>(
      `SELECT outcome,
              COUNT(*)::text AS n,
              COUNT(*) FILTER (
                WHERE outcome = 'running' AND started_at < NOW() - make_interval(mins => $2::int)
              )::text AS stuck,
              MAX(started_at)::text AS last_at
         FROM copier_runs
        WHERE started_at > NOW() - make_interval(mins => $1::int)
        GROUP BY outcome`,
      [windowMinutes, stuckMinutes],
    )
    const { rows: completed } = await query<{ last: string | null }>(
      `SELECT MAX(finished_at)::text AS last FROM copier_runs WHERE outcome = 'completed'`,
    )
    const health = { ...empty, lastCompletedAt: completed[0]?.last ?? null }
    for (const row of rows) {
      const n = Number(row.n)
      if (row.outcome === 'completed') health.completed = n
      else if (row.outcome === 'failed') health.failed = n
      else if (row.outcome === 'running') health.running = n
      health.stuck += Number(row.stuck)
      if (row.last_at && (!health.lastRunAt || row.last_at > health.lastRunAt)) {
        health.lastRunAt = row.last_at
      }
    }
    return health
  } catch {
    return empty
  }
}
