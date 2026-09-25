import { NextRequest, NextResponse, connection } from 'next/server'
import { query } from '@/utils/db'
import { getUsdPrices } from '@/utils/usd-prices'
import { log } from '@/utils/unified-logger'

/**
 * 1-minute OHLC sampler (cron `ohlc_sampler`, default every 15s).
 *
 * Writes our own `token_ohlc_bars` series from batched Jupiter spot prices, so the
 * Freeview chart has a dependency-free price axis when brain / SolanaTracker / GMGN
 * all miss. One statement per tick: the per-minute upsert folds each sample into the
 * current minute (open = first, high/low = extremes, close = latest, samples++).
 *
 * Volume stays NULL — no source in our stack exposes a genuine 1-minute volume.
 */

const DEFAULT_MAX_MINTS = 300
const DEFAULT_RETENTION_HOURS = 48
const DEFAULT_RANGE_MIN = 30_000
const DEFAULT_RANGE_MAX = 2_000_000

function isServiceAuthorized(request: NextRequest): boolean {
  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')
  const expected = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'
  if (key && key === expected) return true
  const auth = request.headers.get('authorization')
  return auth === `Bearer ${expected}`
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Watch set: mcap candidates in the tracking band + trending-tracker rows + mints
 * with a recent sim buy (a cheap proxy for "has an open position" — the full open
 * cycle reconstruction is too heavy for a 15s tick). Sol only: pricing is Jupiter.
 */
const WATCH_SQL = `
WITH watch AS (
  SELECT token_address, last_updated_at AS seen_at
    FROM token_mcap_tracking
   WHERE COALESCE(chain, 'sol') = 'sol'
     AND current_mcap >= $1 AND current_mcap <= $2
  UNION ALL
  SELECT token_address, COALESCE(updated_at, tracking_started_at) AS seen_at
    FROM trending_token_tracker
   WHERE status IN ('tracking', 'waiting')
  UNION ALL
  SELECT t->>'mintAddress' AS token_address, r.created_at AS seen_at
    FROM trading_records r
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.data->'tokens', '[]'::jsonb)) t
   WHERE r.operation_type = 'buy'
     AND COALESCE(r.chain, 'sol') = 'sol'
     AND r.created_at > now() - interval '24 hours'
     AND COALESCE(t->>'mintAddress', '') <> ''
)
SELECT token_address
  FROM watch
 GROUP BY token_address
 ORDER BY max(seen_at) DESC NULLS LAST
 LIMIT $3
`

const UPSERT_SQL = `
INSERT INTO token_ohlc_bars (
  token_address, interval, open, high, low, close, timestamp, source, samples
)
SELECT m, '1m', p, p, p, p, date_trunc('minute', now()), 'sampler', 1
  FROM unnest($1::text[], $2::float8[]) AS u(m, p)
ON CONFLICT (token_address, interval, timestamp) DO UPDATE SET
  high    = GREATEST(token_ohlc_bars.high, EXCLUDED.high),
  low     = LEAST(token_ohlc_bars.low, EXCLUDED.low),
  close   = EXCLUDED.close,
  samples = token_ohlc_bars.samples + 1
`

export async function POST(request: NextRequest) {
  await connection()
  if (!isServiceAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { acquireJobLock, releaseJobLock } = await import('@/utils/bot-job-lock')
  const jobLock = await acquireJobLock('ohlc_sampler', 60)
  if (!jobLock.acquired) {
    return NextResponse.json(
      { success: false, skipped: true, reason: jobLock.reason },
      { status: 409 },
    )
  }

  try {
    const maxMints = intEnv('OHLC_SAMPLE_MAX_MINTS', DEFAULT_MAX_MINTS)
    const retentionHours = intEnv('OHLC_BARS_RETENTION_HOURS', DEFAULT_RETENTION_HOURS)

    const { rows } = await query<{ token_address: string }>(WATCH_SQL, [
      DEFAULT_RANGE_MIN,
      DEFAULT_RANGE_MAX,
      maxMints,
    ])
    const mints = rows.map((r) => r.token_address).filter(Boolean)

    let priced: Array<[string, number]> = []
    if (mints.length > 0) {
      const { prices } = await getUsdPrices(mints)
      priced = Object.entries(prices).filter(
        ([, p]) => typeof p === 'number' && Number.isFinite(p) && p > 0,
      )
      if (priced.length > 0) {
        await query(UPSERT_SQL, [
          priced.map(([m]) => m),
          priced.map(([, p]) => p),
        ])
      }
    }

    const { rowCount } = await query(
      `DELETE FROM token_ohlc_bars
        WHERE timestamp < now() - make_interval(hours => $1::int)`,
      [retentionHours],
    )

    return NextResponse.json({
      success: true,
      watch: mints.length,
      priced: priced.length,
      pruned: rowCount ?? 0,
      retention_hours: retentionHours,
    })
  } catch (error) {
    log.error('error_handling', 'OHLC sampler failed', error as Error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  } finally {
    await releaseJobLock('ohlc_sampler')
  }
}
