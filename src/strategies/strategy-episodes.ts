import { fetchTradingRecordsForWallet } from '@/strategies/db'
import { fetchTokenMapActivity } from '@/strategies/token-map-activity'
import { fetchTokenOhlc } from '@/strategies/token-map-chart'
import { isOpenTrackerPosition } from '@/utils/trading-simulation'
import { computeOpenSimCycle } from '@/utils/simulation-trades'
import { query } from '@/utils/db'

const LOOKBACK_MS = 2 * 60 * 60 * 1000
const MAX_SPAN_MS = 48 * 60 * 60 * 1000
const OUTCOME_HORIZON_MS = 7 * 24 * 60 * 60 * 1000
export const IDEMPOTENT_WINDOW_MS = 60_000

/** Pure check: two window_end stamps are close enough to treat as the same finalize. */
export function isIdempotentWindowEnd(
  existingWindowEndIso: string,
  candidateWindowEndIso: string,
  tolMs = IDEMPOTENT_WINDOW_MS,
): boolean {
  const a = new Date(existingWindowEndIso).getTime()
  const b = new Date(candidateWindowEndIso).getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Math.abs(a - b) <= tolMs
}

const ENSURE_SQL = `
CREATE TABLE IF NOT EXISTS strategy_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_address TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  ohlc_interval TEXT NOT NULL DEFAULT '1m'
    CHECK (ohlc_interval IN ('1m', '5m', '15m', '1h')),
  ohlc_source TEXT NOT NULL DEFAULT 'none',
  bars JSONB NOT NULL DEFAULT '[]'::jsonb,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  outcome_ids UUID[] NOT NULL DEFAULT '{}',
  rug_label TEXT NULL,
  finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_episodes_token_window_end
  ON strategy_episodes (token_address, window_end);
CREATE INDEX IF NOT EXISTS idx_strategy_episodes_token_finalized
  ON strategy_episodes (token_address, finalized_at DESC);
UPDATE strategy_episodes SET rug_label = 'potential' WHERE rug_label = 'not_rug';
ALTER TABLE strategy_episodes
  DROP CONSTRAINT IF EXISTS strategy_episodes_rug_label_check;
DO $$ BEGIN
  ALTER TABLE strategy_episodes
    ADD CONSTRAINT strategy_episodes_rug_label_check
    CHECK (rug_label IS NULL OR rug_label IN ('rug', 'potential'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`

let ensurePromise: Promise<void> | null = null

export async function ensureStrategyEpisodesTable(): Promise<void> {
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

export type EpisodeOutcomeStamp = {
  id?: string | null
  entry_at: string | null
  exit_at: string | null
}

/** Pure window math for episode finalize. */
export function computeEpisodeWindow(
  outcomes: EpisodeOutcomeStamp[],
  nowMs = Date.now(),
): { windowStartIso: string; windowEndIso: string } | null {
  const since = nowMs - OUTCOME_HORIZON_MS
  const recent = outcomes.filter((o) => {
    const t = o.exit_at ?? o.entry_at
    if (!t) return false
    const ms = new Date(t).getTime()
    return Number.isFinite(ms) && ms >= since
  })
  if (recent.length === 0) return null

  let windowEnd = 0
  let earliestEntry = Infinity
  for (const o of recent) {
    if (o.exit_at) {
      const e = new Date(o.exit_at).getTime()
      if (Number.isFinite(e)) windowEnd = Math.max(windowEnd, e)
    }
    if (o.entry_at) {
      const e = new Date(o.entry_at).getTime()
      if (Number.isFinite(e)) earliestEntry = Math.min(earliestEntry, e)
    }
  }
  if (!windowEnd) windowEnd = nowMs
  if (!Number.isFinite(earliestEntry)) earliestEntry = windowEnd

  let windowStart = earliestEntry - LOOKBACK_MS
  const minStart = windowEnd - MAX_SPAN_MS
  if (windowStart < minStart) windowStart = minStart

  return {
    windowStartIso: new Date(windowStart).toISOString(),
    windowEndIso: new Date(windowEnd).toISOString(),
  }
}

const SIM_WALLETS = [
  process.env.MCAP_TRACKER_SIM_WALLET_ADDRESS || 'mcap-tracker-sim',
  process.env.SIGNALS_SIM_WALLET_ADDRESS || 'signals-strategy-sim',
  process.env.GMGN_SIM_WALLET_ADDRESS || 'gmgn-sim',
  process.env.SOCIAL_SIM_WALLET_ADDRESS || 'social-sim',
]

function trackerTable(): string {
  return process.env.NODE_ENV === 'development'
    ? 'trending_token_tracker_dev'
    : 'trending_token_tracker'
}

/** True if any strategy sim / tracker position is still open on this mint. */
export async function mintHasOpenStrategyPositions(
  tokenAddress: string,
): Promise<boolean> {
  const walletChecks = await Promise.all(
    SIM_WALLETS.map(async (wallet) => {
      try {
        const records = await fetchTradingRecordsForWallet(wallet)
        const cycle = computeOpenSimCycle(records, tokenAddress)
        return Boolean(cycle && cycle.simulationType === 'strategy')
      } catch {
        return false
      }
    }),
  )
  if (walletChecks.some(Boolean)) return true

  try {
    const { rows } = await query<{
      status: string | null
      trading_simulation: unknown
    }>(
      `SELECT status, trading_simulation FROM ${trackerTable()}
       WHERE token_address = $1 AND status = 'tracking'
       LIMIT 1`,
      [tokenAddress],
    )
    const row = rows[0]
    if (row && isOpenTrackerPosition(row)) return true
  } catch {
    /* tracker table may be missing */
  }
  return false
}

async function episodeExistsNearWindowEnd(
  tokenAddress: string,
  windowEndIso: string,
  outcomeId?: string | null,
): Promise<boolean> {
  await ensureStrategyEpisodesTable()
  if (outcomeId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM strategy_episodes
       WHERE token_address = $1 AND $2 = ANY(outcome_ids)
       LIMIT 1`,
      [tokenAddress, outcomeId],
    )
    if (rows[0]) return true
  }
  const { rows } = await query<{ window_end: string }>(
    `SELECT window_end FROM strategy_episodes
     WHERE token_address = $1
     ORDER BY window_end DESC
     LIMIT 5`,
    [tokenAddress],
  )
  return rows.some((r) => isIdempotentWindowEnd(r.window_end, windowEndIso))
}

export type FinalizeEpisodeResult =
  | { status: 'skipped_open' }
  | { status: 'skipped_idempotent' }
  | { status: 'skipped_no_window' }
  | { status: 'ok'; episodeId: string }

/**
 * When no strategy positions remain open on mint, archive OHLC + events + outcomes.
 */
export async function finalizeStrategyEpisode(
  tokenAddress: string,
  opts?: { outcomeId?: string | null },
): Promise<FinalizeEpisodeResult> {
  if (!tokenAddress) return { status: 'skipped_no_window' }

  if (await mintHasOpenStrategyPositions(tokenAddress)) {
    return { status: 'skipped_open' }
  }

  await ensureStrategyEpisodesTable()

  const { rows: outcomeRows } = await query<{
    id: string
    entry_at: string | null
    exit_at: string | null
  }>(
    `SELECT id, entry_at, exit_at FROM strategy_outcomes
     WHERE token_address = $1
       AND COALESCE(exit_at, entry_at, created_at) >= NOW() - INTERVAL '7 days'
     ORDER BY exit_at DESC NULLS LAST`,
    [tokenAddress],
  )

  const window = computeEpisodeWindow(outcomeRows)
  if (!window) return { status: 'skipped_no_window' }

  if (
    await episodeExistsNearWindowEnd(
      tokenAddress,
      window.windowEndIso,
      opts?.outcomeId,
    )
  ) {
    return { status: 'skipped_idempotent' }
  }

  const startMs = new Date(window.windowStartIso).getTime()
  const endMs = new Date(window.windowEndIso).getTime()
  const hours = Math.min(
    168,
    Math.max(1, Math.ceil((Date.now() - startMs) / (60 * 60 * 1000)) + 1),
  )

  const [ohlc, activities] = await Promise.all([
    fetchTokenOhlc({ tokenAddress, hours, interval: '1m' }),
    fetchTokenMapActivity({ tokenAddress, hours, limit: 200 }),
  ])

  const startSec = Math.floor(startMs / 1000)
  const endSec = Math.floor(endMs / 1000)
  const bars = ohlc.candles
    .filter((c) => c.time >= startSec && c.time <= endSec)
    .map((c) => ({
      t: c.time,
      o: c.open,
      h: c.high,
      l: c.low,
      c: c.close,
      ...(c.volume != null ? { v: c.volume } : {}),
    }))

  const events = activities
    .filter((a) => {
      const t = new Date(a.occurredAt).getTime()
      return Number.isFinite(t) && t >= startMs && t <= endMs
    })
    .map((a) => ({
      id: a.id,
      domain: a.domain,
      kind: a.kind,
      title: a.title,
      occurredAt: a.occurredAt,
      source: a.source ?? null,
    }))

  const outcomeIds = outcomeRows
    .filter((o) => {
      const entry = o.entry_at ? new Date(o.entry_at).getTime() : null
      const exit = o.exit_at ? new Date(o.exit_at).getTime() : null
      if (entry != null && entry >= startMs && entry <= endMs) return true
      if (exit != null && exit >= startMs && exit <= endMs) return true
      return false
    })
    .map((o) => o.id)

  const { rows } = await query<{ id: string }>(
    `INSERT INTO strategy_episodes (
       token_address, window_start, window_end,
       ohlc_interval, ohlc_source, bars, events, outcome_ids
     ) VALUES ($1, $2, $3, '1m', $4, $5::jsonb, $6::jsonb, $7::uuid[])
     ON CONFLICT (token_address, window_end) DO NOTHING
     RETURNING id`,
    [
      tokenAddress,
      window.windowStartIso,
      window.windowEndIso,
      ohlc.source || 'none',
      JSON.stringify(bars),
      JSON.stringify(events),
      outcomeIds,
    ],
  )

  const episodeId = rows[0]?.id
  if (!episodeId) return { status: 'skipped_idempotent' }
  return { status: 'ok', episodeId }
}

/** Fire-and-forget after outcome insert; never throws to caller. */
export function scheduleEpisodeFinalize(
  tokenAddress: string,
  outcomeId?: string | null,
): void {
  void finalizeStrategyEpisode(tokenAddress, { outcomeId }).catch((err) => {
    console.warn(
      '[strategy-episodes] finalize failed:',
      err instanceof Error ? err.message : err,
    )
  })
}
