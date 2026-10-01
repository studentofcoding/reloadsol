/**
 * The metrics copier — planning for the bulk 1m-volume sweep.
 *
 * The copier fills `token_metrics_history.vol_min` from sources that already exist in the stack:
 *   1. **the free lane** — the 24h 1m candle cache (`readCachedTokenOhlc24h1m`), which already
 *      carries per-candle `volume` and costs nothing;
 *   2. **the copy lane** — GMGN web candles through our Worker (`fetchGmgnWebCandlesPaced`),
 *      one call per token, which returns a **series**.
 *
 * ## Why cadence is not the same thing as coverage
 *
 * One call at `1m`/`limit=501` returns ~8.35 h of minutes, so a *single* sweep backfills every
 * minute of that window — slot completeness comes from the **series**, not from how often we run.
 * Cadence therefore exists only for snapshot freshness (`mcap_close` / `liquidity_close` /
 * `holders`).
 *
 * That creates exactly one dangerous configuration, guarded here: **if the cadence is longer than
 * the window the series covers, the minutes in between are lost forever** — the vendor only ever
 * re-serves the recent window, and nothing we store can reconstruct a minute we never saw. A daily
 * sweep against a 501-minute window would silently hole the series. `assertCadenceCoversWindow`
 * fails loudly instead; `cadenceCoversWindow` is the non-throwing form the request path uses.
 *
 * Nothing in this module throws on bad input — a bad knob degrades to the default window rather
 * than disabling the guard, and only the explicit `assert*` throws.
 */

import type { CandleVolume } from '@/strategies/token-metrics-history'

/** The upstream accepts 501 bars per call; 1m bars are the storage resolution. */
export const COPY_BAR_LIMIT = 501
export const COPY_RESOLUTION_SECONDS = 60

/** A bar as the 24h chart cache stores it (`TokenOhlcBar`, structurally typed to avoid a cycle). */
export type CopierCacheBar = { time: number; volume?: number }

/**
 * How long a single call covers. Guarded against nonsense: a zero window would otherwise make
 * every cadence "too long" and disable the copier.
 */
export function copyWindowSeconds(
  limit: number = COPY_BAR_LIMIT,
  resolutionSeconds: number = COPY_RESOLUTION_SECONDS,
): number {
  const bars =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : COPY_BAR_LIMIT
  const per = Number.isFinite(resolutionSeconds) && resolutionSeconds > 0
    ? resolutionSeconds
    : COPY_RESOLUTION_SECONDS
  return bars * per
}

/**
 * True when `cadenceSec` stays inside the window a single call covers. A **disabled** cadence
 * (`0` / non-finite) is treated as safe — nothing runs, so nothing can be skipped.
 */
export function cadenceCoversWindow(
  cadenceSec: number,
  limit: number = COPY_BAR_LIMIT,
  resolutionSeconds: number = COPY_RESOLUTION_SECONDS,
): boolean {
  if (!Number.isFinite(cadenceSec) || cadenceSec <= 0) return true
  return cadenceSec < copyWindowSeconds(limit, resolutionSeconds)
}

/** Throwing form, for the config/ops path. The request path uses `cadenceCoversWindow` + a warn. */
export function assertCadenceCoversWindow(
  cadenceSec: number,
  limit: number = COPY_BAR_LIMIT,
  resolutionSeconds: number = COPY_RESOLUTION_SECONDS,
): void {
  if (cadenceCoversWindow(cadenceSec, limit, resolutionSeconds)) return
  const window = copyWindowSeconds(limit, resolutionSeconds)
  throw new Error(
    `metrics copier cadence ${cadenceSec}s exceeds the ${window}s a single call covers ` +
      `(limit ${limit} x ${resolutionSeconds}s): every gap would lose minutes permanently`,
  )
}

/** Oldest/newest candle coverage of a cached series, in unix seconds. */
export type CachedCoverage = { oldest: number; newest: number }

export type CopyPlanInput = {
  watchMints: string[]
  /** mint → its cached 1m coverage. Absent means "nothing cached". */
  cached: Map<string, CachedCoverage> | Record<string, CachedCoverage>
  now: Date
  /** How far back a cached series must reach to skip the vendor call entirely. */
  lookbackMinutes: number
  /** A cache older than this is stale: its recent minutes are missing, so fetch regardless. */
  maxStalenessMinutes: number
}

export type CopyPlan = {
  /** Mints with cached candles — free minutes. Always copy these before fetching. */
  fromCache: string[]
  /** Mints whose cache does not cover the window — these cost one copy-lane call each. */
  fetch: string[]
}

/**
 * Decide what to copy from cache and what to fetch.
 *
 * A mint can appear in **both** lists, and that is deliberate: the cache contributes whatever
 * minutes it holds for free, and the vendor call fills the rest. Because the writer is
 * first-writer-wins per slot, copying the cache *first* keeps those minutes authoritative — so the
 * route must always run `fromCache` before `fetch`.
 */
export function planCopyTargets(input: CopyPlanInput): CopyPlan {
  const nowSec = Math.floor(input.now.getTime() / 1000)
  const lookbackSec = Math.max(0, input.lookbackMinutes) * 60
  const maxAgeSec = Math.max(0, input.maxStalenessMinutes) * 60
  const needFromSec = nowSec - lookbackSec
  const cache =
    input.cached instanceof Map ? input.cached : new Map(Object.entries(input.cached))

  const fromCache: string[] = []
  const fetch: string[] = []
  const seen = new Set<string>()

  for (const raw of input.watchMints) {
    const mint = raw?.trim()
    if (!mint || seen.has(mint)) continue
    seen.add(mint)

    const coverage = cache.get(mint)
    if (!coverage) {
      fetch.push(mint)
      continue
    }

    fromCache.push(mint)

    const fresh = nowSec - coverage.newest <= maxAgeSec
    const coversWindow = coverage.oldest <= needFromSec
    if (!fresh || !coversWindow) fetch.push(mint)
  }

  return { fromCache, fetch }
}

/**
 * Cached bars → the writer's candle shape. A missing or non-numeric `volume` is dropped by
 * `planSlotWrites`, which is the single place that rule lives — so this is a pure rename, not a
 * second validation site.
 */
export function toCandleVolumes(bars: CopierCacheBar[]): CandleVolume[] {
  const out: CandleVolume[] = []
  for (const bar of bars) {
    if (!Number.isFinite(bar?.time)) continue
    out.push({ t: bar.time, v: bar.volume })
  }
  return out
}

/**
 * Keep only candles inside the window a lane can actually mean to observe.
 *
 * GMGN returns the last `limit` **traded** minutes, so for a barely-traded token those 501 bars can
 * reach back *years* — measured on prod after the first sweep: 1,438 rows landed outside the
 * window, 205 of them stamped 2024. They are harmless to range-bounded reads and self-clear under
 * retention, but they skew the series' reported span, so each lane clips to its own reach.
 *
 * The bound is deliberately per-lane, because the reach differs: a copy-lane call covers
 * `limit x resolution`, while the 24h cache legitimately holds up to a day.
 */
export function clipCandlesToWindow(
  candles: CandleVolume[],
  opts: { now: Date; windowSeconds: number; slackSeconds?: number },
): CandleVolume[] {
  const nowSec = Math.floor(opts.now.getTime() / 1000)
  const windowSeconds =
    Number.isFinite(opts.windowSeconds) && opts.windowSeconds > 0
      ? opts.windowSeconds
      : COPY_BAR_LIMIT * COPY_RESOLUTION_SECONDS
  const slack = Number.isFinite(opts.slackSeconds) ? (opts.slackSeconds as number) : 120
  const fromSec = nowSec - windowSeconds - slack
  const toSec = nowSec + slack

  const out: CandleVolume[] = []
  for (const candle of candles) {
    if (!Number.isFinite(candle?.t)) continue
    if (candle.t < fromSec || candle.t > toSec) continue
    out.push(candle)
  }
  return out
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight, preserving input order.
 *
 * Never rejects: a failing item yields `null` in its slot, so one bad mint cannot abort a sweep —
 * the caller counts the nulls instead. `concurrency < 1` degrades to serial rather than throwing.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<R | null>> {
  const lanes = Math.max(1, Math.floor(Number.isFinite(concurrency) ? concurrency : 1))
  const results: Array<R | null> = new Array(items.length).fill(null)
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      try {
        results[index] = await fn(items[index]!, index)
      } catch {
        results[index] = null
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, () => worker()))
  return results
}

