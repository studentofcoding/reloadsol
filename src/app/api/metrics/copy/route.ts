import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import {
  fetchGmgnWebCandlesPaced,
  gmgnWebCopyRps,
  gmgnWebIsBlocked,
  takeGmgnWebBlockCount,
} from '@/utils/gmgn-web-extra'
import { readCachedTokenOhlc24h1m, type TokenOhlcBar } from '@/strategies/token-map-chart'
import {
  COPY_BAR_LIMIT,
  COPY_RESOLUTION_SECONDS,
  cadenceCoversWindow,
  clipCandlesToWindow,
  copyWindowSeconds,
  mapWithConcurrency,
  planCopyTargets,
  toCandleVolumes,
  type CachedCoverage,
} from '@/strategies/token-metrics-copier'
import { recordMetricHours, pruneTokenMetricsHistory } from '@/strategies/token-metrics-history'
import {
  DEFAULT_WATCH_MAX_MINTS,
  intEnv,
  loadWatchMints,
} from '@/strategies/token-metrics-watch'

/**
 * Metrics copier (cron `metrics_copier`, default every 15 min) — fills the durable 1m volume
 * series (`token_metrics_history.vol_min`) for the watch set.
 *
 * Two lanes, cheapest first:
 *   1. the **free lane** — the 24h 1m candle cache, which already carries per-candle volume and
 *      costs no upstream call (`readCachedTokenOhlc24h1m`, a pure read);
 *   2. the **copy lane** — GMGN web candles through our Worker, one call per token, paced at
 *      `METRICS_COPY_RPS` (default 2, measured-safe on the candle endpoint) so it never competes
 *      with the live chart/risk lane.
 *
 * One call at 1m/501 returns ~8.35 h of minutes, so a single sweep backfills every minute of that
 * window: **coverage comes from the series, not from the cadence.** Cadence exists only for
 * snapshot freshness — and a cadence longer than that window would lose minutes permanently, which
 * is why the guard below is loud.
 *
 * Deliberately never touches `token_ohlc_bars` (the sampler's own price series) and never writes a
 * rolling-window reading into a slot: a `stats5m`-style number is not a per-minute candle.
 */

const RESOLUTION = '1m'
const DEFAULT_LOOKBACK_MIN = 240
const DEFAULT_MAX_STALENESS_MIN = 30
const DEFAULT_CONCURRENCY = 8
const DEFAULT_CADENCE_SEC = 900
const CACHE_READ_CONCURRENCY = 16
const JOB_LOCK_SECONDS = 600
/** Prune a few times a day rather than on every sweep. */
const PRUNE_EVERY_HOURS = 6
/** How far back the 24h cache may legitimately reach (its own TTL, not the copy window). */
const CACHE_REACH_SECONDS = 24 * 60 * 60

function isServiceAuthorized(request: NextRequest): boolean {
  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')
  const expected = process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'
  if (key && key === expected) return true
  const auth = request.headers.get('authorization')
  return auth === `Bearer ${expected}`
}

type CachedSeries = { candles: TokenOhlcBar[]; source: string }

export async function POST(request: NextRequest) {
  await connection()
  if (!isServiceAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (process.env.METRICS_COPY_KILL_SWITCH === '1') {
    return NextResponse.json({ success: true, skipped: true, reason: 'kill switch' })
  }

  const { acquireJobLock, releaseJobLock } = await import('@/utils/bot-job-lock')
  const jobLock = await acquireJobLock('metrics_copier', JOB_LOCK_SECONDS)
  if (!jobLock.acquired) {
    return NextResponse.json(
      { success: false, skipped: true, reason: jobLock.reason },
      { status: 409 },
    )
  }

  try {
    const maxMints = intEnv('METRICS_COPY_MAX_MINTS', DEFAULT_WATCH_MAX_MINTS)
    const concurrency = intEnv('METRICS_COPY_CONCURRENCY', DEFAULT_CONCURRENCY)
    const lookbackMinutes = intEnv('METRICS_COPY_LOOKBACK_MIN', DEFAULT_LOOKBACK_MIN)
    const stalenessMinutes = intEnv('METRICS_COPY_MAX_STALENESS_MIN', DEFAULT_MAX_STALENESS_MIN)
    const cadenceSec = intEnv('METRICS_COPY_INTERVAL', DEFAULT_CADENCE_SEC)
    const limit = COPY_BAR_LIMIT

    // The one configuration error that destroys data silently: a cadence longer than the window a
    // single call covers loses every minute in the gap, and the vendor never re-serves them.
    const cadenceOk = cadenceCoversWindow(cadenceSec, limit, COPY_RESOLUTION_SECONDS)
    if (!cadenceOk) {
      console.warn('[metrics-copier] cadence exceeds the series window — minutes will be lost', {
        cadenceSec,
        windowSec: copyWindowSeconds(limit, COPY_RESOLUTION_SECONDS),
      })
    }

    const now = new Date()
    const mints = await loadWatchMints({ maxMints })

    // 1) FREE LANE — pure cache reads, no upstream calls.
    const reads = await mapWithConcurrency(mints, CACHE_READ_CONCURRENCY, (mint) =>
      readCachedTokenOhlc24h1m(mint),
    )
    const cacheByMint = new Map<string, CachedSeries>()
    const coverage = new Map<string, CachedCoverage>()
    mints.forEach((mint, index) => {
      const cached = reads[index]
      if (!cached || cached.candles.length === 0) return
      cacheByMint.set(mint, cached)
      let oldest = Number.POSITIVE_INFINITY
      let newest = Number.NEGATIVE_INFINITY
      for (const bar of cached.candles) {
        if (bar.time < oldest) oldest = bar.time
        if (bar.time > newest) newest = bar.time
      }
      coverage.set(mint, { oldest, newest })
    })

    const plan = planCopyTargets({
      watchMints: mints,
      cached: coverage,
      now,
      lookbackMinutes,
      maxStalenessMinutes: stalenessMinutes,
    })

    // 2) Cache minutes first: the writer is first-writer-wins per slot, so the minutes the cache
    //    already holds stay authoritative and the vendor call below only fills the gaps.
    let hoursWritten = 0
    let slotsAttempted = 0
    let fromCache = 0
    for (const mint of plan.fromCache) {
      const cached = cacheByMint.get(mint)
      if (!cached) continue
      const result = await recordMetricHours({
        tokenAddress: mint,
        candles: clipCandlesToWindow(toCandleVolumes(cached.candles), {
          now,
          windowSeconds: CACHE_REACH_SECONDS,
        }),
        source: 'cache_copy',
      })
      hoursWritten += result.hoursWritten
      slotsAttempted += result.slotsAttempted
      if (result.hoursWritten > 0) fromCache++
    }

    // 3) COPY LANE — one paced call per remaining mint. A 403/429 parks both lanes, so stop
    //    rather than churn the rest of the sweep into nulls.
    const rps = gmgnWebCopyRps()
    let fetched = 0
    let fetchFailed = 0
    let parked = false
    await mapWithConcurrency(plan.fetch, concurrency, async (mint) => {
      if (parked || gmgnWebIsBlocked()) {
        parked = true
        return null
      }
      const candles = await fetchGmgnWebCandlesPaced(mint, { resolution: RESOLUTION, limit, rps })
      if (!candles) {
        fetchFailed++
        return null
      }
      fetched++
      // The vendor's last 501 *traded* minutes can reach back years for a barely-traded token, so
      // clip to what this sweep can mean to observe before writing anything.
      const clipped = clipCandlesToWindow(candles, {
        now,
        windowSeconds: copyWindowSeconds(limit, COPY_RESOLUTION_SECONDS),
      })
      const result = await recordMetricHours({
        tokenAddress: mint,
        candles: clipped,
        source: 'gmgn_web',
      })
      hoursWritten += result.hoursWritten
      slotsAttempted += result.slotsAttempted
      return candles.length
    })

    // 4) Retention — whole hours only.
    let pruned = 0
    if (now.getUTCHours() % PRUNE_EVERY_HOURS === 0) {
      pruned = await pruneTokenMetricsHistory()
    }

    const blocks = takeGmgnWebBlockCount()
    const summary = {
      success: true,
      watch: mints.length,
      cache_covered: plan.fromCache.length,
      cache_written: fromCache,
      fetched,
      fetch_failed: fetchFailed,
      parked,
      hours: hoursWritten,
      slots: slotsAttempted,
      blocks,
      pruned,
      cadence_ok: cadenceOk,
      rps,
    }
    // console.warn, not log.info: production strips info/log via removeConsole and this line is
    // the ramp evidence (blocks + coverage) that decides whether METRICS_COPY_RPS can go up.
    console.warn('[metrics-copier] sweep', summary)
    return NextResponse.json(summary)
  } catch (error) {
    log.error('error_handling', 'metrics copier failed', error as Error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    )
  } finally {
    await releaseJobLock('metrics_copier')
  }
}
