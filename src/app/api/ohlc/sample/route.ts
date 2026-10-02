import { NextRequest, NextResponse, connection } from 'next/server'
import { query } from '@/utils/db'
import { getUsdPrices } from '@/utils/usd-prices'
import { log } from '@/utils/unified-logger'
import { hasTrendingTrackerSecret } from '@/utils/api-auth'
import {
  WATCH_RANGE_MAX,
  WATCH_RANGE_MIN,
  WATCH_SOCIAL_WINDOW_MIN,
  intEnv,
  loadWatchMints,
  resolveDetectWindowMin,
  resolveSamplerMaxMints,
} from '@/strategies/token-metrics-watch'

/**
 * 1-minute OHLC sampler (cron `ohlc_sampler`, default every 15s).
 *
 * Writes our own `token_ohlc_bars` series from batched Jupiter spot prices, so the
 * Freeview chart has a dependency-free price axis when brain / SolanaTracker / GMGN
 * all miss. One statement per tick: the per-minute upsert folds each sample into the
 * current minute (open = first, high/low = extremes, close = latest, samples++).
 *
 * Volume stays NULL here: this sampler only has a Jupiter spot price in scope and makes no candle
 * call. Upstream candle volume DOES exist (market-brain, Solana Tracker, both GMGN candle endpoints)
 * and is persisted by the metrics series instead — `token_metrics_history.vol_min`, one row per
 * (token, UTC hour) with 60 one-minute slots, written from real candles by `GET /api/metrics/copy`.
 * Ceiling: `volume_death` in ohlc-rug-rules is therefore always skipped for THIS series (the cache
 * path serves it). Upgrade path: give the sampler a candle call per watch mint.
 */

const DEFAULT_RETENTION_HOURS = 48

/** TRENDING_TRACKER_SECRET only; fails closed when it is unset (no committed fallback). */
function isServiceAuthorized(request: NextRequest): boolean {
  return hasTrendingTrackerSecret(request)
}

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
    const maxMints = resolveSamplerMaxMints()
    const detectWindowMin = resolveDetectWindowMin()
    const retentionHours = intEnv('OHLC_BARS_RETENTION_HOURS', DEFAULT_RETENTION_HOURS)
    const socialWindowMin = intEnv(
      'OHLC_SAMPLE_SOCIAL_WINDOW_MIN',
      WATCH_SOCIAL_WINDOW_MIN,
    )

    const mints = await loadWatchMints({
      maxMints,
      rangeMin: WATCH_RANGE_MIN,
      rangeMax: WATCH_RANGE_MAX,
      socialWindowMin,
      detectWindowMin,
    })

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
      max_mints: maxMints,
      detect_window_min: detectWindowMin,
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
