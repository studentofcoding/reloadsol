import { NextRequest, NextResponse, connection } from 'next/server'
import { log } from '@/utils/unified-logger'
import {
  fetchGmgnWebCandlesPaced,
  fetchGmgnWebSafety,
  gmgnWebCopyRps,
  gmgnWebCopyLaneBlocked,
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
import { recordMetricHours, recordMetricSnapshots, pruneTokenMetricsHistory } from '@/strategies/token-metrics-history'
import { ohlcvMinutesToRugBars } from '@/strategies/rug-signal-detect'
import {
  evaluateRugSignalFrom1m,
  isRugSignalEnabled,
  resolveRugSignalThresholds,
  rugSignalMode,
  type RugSignalBar,
} from '@/strategies/rug-signal'
import { recordRugSignalShadow } from '@/strategies/rug-signal-shadow'
import {
  DEFAULT_WATCH_MAX_MINTS,
  intEnv,
  loadWatchMints,
  loadWatchSymbols,
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
    // The watch set is addresses only; the symbol is a separate best-effort lookup from the same
    // tables. Resolved once per sweep, so a row is never written with a symbol invented from its mint.
    const symbols = await loadWatchSymbols(mints)

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
    /**
     * Candles kept for the shadow pass. The sweep is the only place that sees the **whole watch
     * set**, so it is the only place that can produce a control cohort (tokens that do not
     * collapse) — the pipeline call site only ever sees radar candidates.
     */
    const scored: Array<{ mint: string; bars: RugSignalBar[]; mcap: number | null }> = []
    await mapWithConcurrency(plan.fetch, concurrency, async (mint) => {
      // Only this lane's own endpoints can park the sweep — a challenge on the snapshot
      // endpoint used to cancel the whole pass even though candles were fetching cleanly.
      if (parked || gmgnWebCopyLaneBlocked()) {
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
      const bars = ohlcvMinutesToRugBars(clipped)
      if (bars.length > 0) {
        // The market-cap candle's last observed close *is* the token's mcap — one source, one job.
        let mcap: number | null = null
        for (let i = bars.length - 1; i >= 0; i--) {
          const close = bars[i]!.c
          if (Number.isFinite(close) && close > 0) {
            mcap = close
            break
          }
        }
        scored.push({ mint, bars, mcap })
      }
      const result = await recordMetricHours({
        tokenAddress: mint,
        candles: clipped,
        source: 'gmgn_web',
      })
      hoursWritten += result.hoursWritten
      slotsAttempted += result.slotsAttempted
      return candles.length
    })

    // 4) LIQUIDITY — the series' `liquidity_close` had no writer at all (0 rows), which leaves the
    //    C20 band and any series-derived label without the input they need. `meme_quote_info` is
    //    batched (≤8 addresses per call), so the whole watch set costs ~19 calls on the copy lane.
    //    Soft: no liquidity in the response → no write, and it never touches vol_min.
    let liquidityRows = 0
    const liquidityByMint = new Map<string, number>()
    if (mints.length > 0) {
      const safety = await fetchGmgnWebSafety(mints, { rps })
      for (const row of safety) {
        if (
          typeof row.liquidityUsd === 'number' &&
          Number.isFinite(row.liquidityUsd) &&
          row.liquidityUsd > 0
        ) {
          liquidityByMint.set(row.address, row.liquidityUsd)
        }
      }
      const samples = [...liquidityByMint.entries()].map(([tokenAddress, liquidityUsd]) => ({
        tokenAddress,
        chain: 'sol',
        liquidityUsd,
      }))
      if (samples.length > 0) {
        liquidityRows = await recordMetricSnapshots(samples, now, 'gmgn_web')
      }
    }

    // 5) SHADOW SCORING — score the whole watch set, not just the pipeline's radar candidates.
    //
    //    The bars are already in hand, so this is nearly free, and it is the *only* path that
    //    records tokens which do **not** collapse — the control cohort the validation needs a base
    //    rate from. It writes to the shadow log and never calls `markTokenRug`, so an `enforce`
    //    mode cannot turn a measurement sweep into a decision.
    let shadowRows = 0
    let seriesFed = 0
    let notJudged = 0
    if (isRugSignalEnabled() && scored.length > 0) {
      const thresholds = resolveRugSignalThresholds()
      const mode = rugSignalMode()
      for (const entry of scored) {
        const liquidityUsd = liquidityByMint.get(entry.mint) ?? null
        const result = evaluateRugSignalFrom1m(
          {
            bars1m: entry.bars,
            mcap: entry.mcap,
            liquidityUsd,
            // An unknown age never skips — the scorer's own rule — and the sweep has no tracker row.
            ageHours: null,
          },
          thresholds,
        )
        if (result.breakdown.volume > 0) seriesFed++
        // A score from too few bars is an **unknown**, not a negative. Recording it as `pass` would
        // quietly fill the control cohort with tokens nobody judged, which is how a precision figure
        // becomes fiction.
        if (!result.judged) notJudged++
        const decision = !result.judged ? 'no_bars' : result.isRug ? 'would_rug' : 'pass'
        const reason = result.judged
          ? (result.reasons[result.reasons.length - 1] ?? null)
          : `insufficient bars (${result.barsScored} x 5m)`
        await recordRugSignalShadow({
          chain: 'sol',
          tokenAddress: entry.mint,
          symbol: symbols.get(entry.mint) ?? null,
          score: result.score,
          breakdown: result.breakdown as unknown as Record<string, number>,
          barsSource: 'series',
          barsUsed: entry.bars.length,
          barsScored: result.barsScored,
          decision,
          mode,
          reason,
          mcap: entry.mcap,
          liquidityUsd,
          source: 'metrics_sweep',
        })
        shadowRows++
      }
    }

    // Coverage must be loud: a watch set we could not score otherwise reads as "no rugs found".
    if (scored.length < mints.length) {
      const haveSeries = new Set(scored.map((s) => s.mint))
      const uncovered = mints.filter((m) => !haveSeries.has(m))
      console.warn('[metrics-copier] watch mints with no candle series this sweep', {
        watch: mints.length,
        withCandles: scored.length,
        without: uncovered.length,
        examples: uncovered.slice(0, 5),
      })
    }

    // 6) Retention — whole hours only.
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
      liquidity_rows: liquidityRows,
      scored: scored.length,
      shadow_rows: shadowRows,
      series_fed: seriesFed,
      not_judged: notJudged,
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
