/**
 * Prune guard for `token_ohlc_bars`.
 *
 * The sampler deletes bars older than `OHLC_BARS_RETENTION_HOURS` (default 48). With the archive on,
 * deleting a day that has not been copied out is unrecoverable, so when `OHLC_PRUNE_REQUIRES_ARCHIVE=1`
 * the prune cutoff is clamped to the start of the oldest complete day (inside the archive lookback)
 * that has no done row in `evidence_archive_runs`. Off by default: behaviour is unchanged until the
 * operator has R2 working. Fail-open on ledger read errors would risk data loss, so a read error
 * clamps to "prune nothing this tick" instead.
 */
import { eligibleDays, dayWindow } from '@/strategies/evidence-archive'
import type { QueryFn } from '@/strategies/evidence-archive'

type EnvLike = Record<string, string | undefined>

export function pruneRequiresArchive(env: EnvLike = process.env): boolean {
  return env.OHLC_PRUNE_REQUIRES_ARCHIVE?.trim() === '1'
}

/**
 * Earliest instant that must NOT be pruned (rows at or after it are kept), or null when every
 * eligible day is already archived. `Date(0)` means "ledger unreadable: keep everything".
 */
export async function barsPruneFloor(
  query: QueryFn,
  nowMs: number,
  env: EnvLike = process.env,
): Promise<Date | null> {
  const grace = Number(env.EVIDENCE_ARCHIVE_GRACE_HOURS) > 0 ? Number(env.EVIDENCE_ARCHIVE_GRACE_HOURS) : 2
  const lookback = Number(env.EVIDENCE_ARCHIVE_LOOKBACK_DAYS) > 0 ? Number(env.EVIDENCE_ARCHIVE_LOOKBACK_DAYS) : 3
  const days = eligibleDays({ nowMs, graceHours: grace, lookbackDays: lookback, maxDays: lookback })
  if (days.length === 0) return null
  try {
    const { rows } = await query<{ day: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM evidence_archive_runs
        WHERE dataset = 'token_ohlc_bars' AND status IN ('ok', 'empty') AND day = ANY($1::date[])`,
      [days],
    )
    const done = new Set(rows.map((r) => r.day))
    const firstPending = days.find((d) => !done.has(d))
    return firstPending ? new Date(dayWindow(firstPending).startIso) : null
  } catch {
    return new Date(0)
  }
}
