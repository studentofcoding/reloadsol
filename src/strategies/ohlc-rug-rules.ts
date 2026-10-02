/** Pure OHLC hard rules for early rug-shape filter (≤10 × 1m bars). */

export type OhlcRugBar = {
  t: number
  o: number
  h: number
  l: number
  c: number
  v?: number
}

export type OhlcRugThresholds = {
  dumpPct: number
  wickRatio: number
  volDeathRatio: number
}

export const DEFAULT_OHLC_RUG_THRESHOLDS: OhlcRugThresholds = {
  dumpPct: 0.4,
  wickRatio: 0.6,
  volDeathRatio: 0.25,
}

export const OHLC_RUG_MAX_BARS = 10

export type OhlcRugRuleHit = {
  id: 'dump_10m' | 'wick_reject' | 'volume_death' | 'up_only_10'
  label: string
  value: number | null
  threshold: number
  /** true = rule tripped */
  passed: boolean
  skipped?: boolean
  skipReason?: string
}

export type OhlcRugFeatures = {
  n: number
  dumpPct: number | null
  avgUpperWick: number | null
  wickTripBars: number
  volDeathRatio: number | null
  /** Count of bars with c > o in the window (null if n === 0). */
  upOnlyCount: number | null
}

export type OhlcRugEval = {
  trip: boolean
  features: OhlcRugFeatures
  hits: OhlcRugRuleHit[]
}

const EPS = 1e-12

/** Default max age (s) of the newest bar relative to detect/eval time. */
export const OHLC_RUG_MAX_BAR_AGE_SEC_DEFAULT = 180

/**
 * Max age (s) the newest bar may have before the window is "stale".
 * `OHLC_RUG_MAX_BAR_AGE_SEC` overrides; `0` disables the guard; garbage → default.
 */
export function resolveOhlcRugMaxBarAgeSec(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.OHLC_RUG_MAX_BAR_AGE_SEC?.trim()
  if (!raw) return OHLC_RUG_MAX_BAR_AGE_SEC_DEFAULT
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return OHLC_RUG_MAX_BAR_AGE_SEC_DEFAULT
  return Math.floor(n)
}

function barTimeSec(bar: { t?: number; time?: number }): number | null {
  const raw = bar.t ?? bar.time
  if (raw == null || !Number.isFinite(raw)) return null
  // Accept ms epochs defensively; bars are seconds everywhere else.
  return raw > 1e12 ? Math.floor(raw / 1000) : raw
}

/**
 * Age (s) of the newest bar vs `nowSec`; null when there are no timestamped bars.
 */
export function ohlcNewestBarAgeSec<T extends { t?: number; time?: number }>(
  bars: T[],
  nowSec: number,
): number | null {
  let newest: number | null = null
  for (const b of bars) {
    const t = barTimeSec(b)
    if (t != null && (newest == null || t > newest)) newest = t
  }
  return newest == null ? null : nowSec - newest
}

/** True when the newest bar is older than `maxAgeSec` (`maxAgeSec <= 0` never stale). */
export function isOhlcWindowStale<T extends { t?: number; time?: number }>(
  bars: T[],
  nowSec: number,
  maxAgeSec: number,
): boolean {
  if (!(maxAgeSec > 0) || bars.length === 0) return false
  const age = ohlcNewestBarAgeSec(bars, nowSec)
  // No usable timestamp → cannot prove freshness → stale.
  return age == null || age > maxAgeSec
}

/**
 * Last N bars. With `opts.maxAgeSec` set, a series whose newest bar is older than
 * that (relative to `opts.nowSec`, default now) returns [] instead of old bars.
 * Without opts the behavior is unchanged (historical / as-of callers).
 */
export function takeLastOhlcBars<T extends { t?: number; time?: number }>(
  bars: T[],
  n = OHLC_RUG_MAX_BARS,
  opts?: { nowSec?: number; maxAgeSec?: number },
): T[] {
  if (opts?.maxAgeSec != null) {
    const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000)
    if (isOhlcWindowStale(bars, nowSec, opts.maxAgeSec)) return []
  }
  if (bars.length <= n) return bars.slice()
  return bars.slice(bars.length - n)
}

/**
 * Last-N window for Freeview rug rules.
 * Canonical 24h bars win. An empty canonical series may use own-1m storage
 * only when `fallbackOwn1m` is set (Freeview). Entry shadow stays canonical.
 *
 * Recency: when `maxAgeSec > 0`, a series whose newest bar is older than that vs
 * `nowSec` is NOT current. A stale canonical series can still be replaced by a
 * fresh own-1m series (Freeview); otherwise the result is `{ bars: [], source:
 * 'stale' }` so callers skip instead of scoring a dead chart as live.
 */
export function resolveOhlcRugWindow(input: {
  cached: OhlcRugBar[]
  cachedSource: string
  own?: OhlcRugBar[]
  n?: number
  fallbackOwn1m?: boolean
  nowSec?: number
  maxAgeSec?: number
}): { bars: OhlcRugBar[]; source: string } {
  const n = input.n ?? OHLC_RUG_MAX_BARS
  const maxAgeSec = input.maxAgeSec ?? 0
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000)
  const guard = maxAgeSec > 0 ? { nowSec, maxAgeSec } : undefined
  let sawStale = false

  if (input.cached.length > 0) {
    const bars = takeLastOhlcBars(input.cached, n, guard)
    if (bars.length > 0) {
      return { bars, source: input.cachedSource || 'cached' }
    }
    sawStale = true
  }
  const own = input.own ?? []
  if (input.fallbackOwn1m && own.length > 0) {
    const bars = takeLastOhlcBars(own, n, guard)
    if (bars.length > 0) return { bars, source: 'own-1m' }
    sawStale = true
  }
  return { bars: [], source: sawStale ? 'stale' : 'none' }
}

export const OHLC_RUG_EMPTY_STORAGE =
  'No bars in the 24h OHLC cache or own-1m storage.'

function upperWickRatio(bar: OhlcRugBar): number | null {
  const range = bar.h - bar.l
  if (!(range > EPS)) return null
  const bodyTop = Math.max(bar.o, bar.c)
  return (bar.h - bodyTop) / range
}

/**
 * Evaluate dump / wick-reject / volume-death on ≤10 bars (OR of trips).
 * Missing volume → skip volume_death. n<10 uses whatever remains.
 */
export function evaluateOhlcRugRules(
  barsIn: OhlcRugBar[],
  thresholds: Partial<OhlcRugThresholds> = {},
): OhlcRugEval {
  const th = { ...DEFAULT_OHLC_RUG_THRESHOLDS, ...thresholds }
  const bars = takeLastOhlcBars(
    barsIn
      .filter(
        (b) =>
          Number.isFinite(b.t) &&
          Number.isFinite(b.o) &&
          Number.isFinite(b.h) &&
          Number.isFinite(b.l) &&
          Number.isFinite(b.c) &&
          b.c > 0 &&
          b.o > 0,
      )
      .sort((a, b) => a.t - b.t),
    OHLC_RUG_MAX_BARS,
  )

  const n = bars.length
  const hits: OhlcRugRuleHit[] = []

  let dumpPct: number | null = null
  if (n >= 1) {
    const first = bars[0]!
    const last = bars[n - 1]!
    dumpPct = (first.c - last.c) / first.c
  }
  const dumpTrip = dumpPct != null && dumpPct >= th.dumpPct
  hits.push({
    id: 'dump_10m',
    label: 'Dump ≥ threshold over window',
    value: dumpPct,
    threshold: th.dumpPct,
    passed: dumpTrip,
    skipped: n < 1,
    skipReason: n < 1 ? 'no bars' : undefined,
  })

  const wickRatios: number[] = []
  for (const b of bars) {
    const r = upperWickRatio(b)
    if (r != null) wickRatios.push(r)
  }
  const avgUpperWick =
    wickRatios.length > 0
      ? wickRatios.reduce((a, b) => a + b, 0) / wickRatios.length
      : null
  const wickTripBars = wickRatios.filter((r) => r >= th.wickRatio).length
  // ≥2 bars contributing + average upper-wick ≥ threshold
  const wickTrip =
    wickRatios.length >= 2 &&
    avgUpperWick != null &&
    avgUpperWick >= th.wickRatio
  hits.push({
    id: 'wick_reject',
    label: 'Avg upper-wick reject',
    value: avgUpperWick,
    threshold: th.wickRatio,
    passed: wickTrip,
    skipped: wickRatios.length < 2,
    skipReason:
      wickRatios.length < 2 ? 'need ≥2 bars with range' : undefined,
  })

  const vols = bars
    .map((b) => b.v)
    .filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
  let volDeathRatio: number | null = null
  let volSkipped = false
  let volSkipReason: string | undefined
  let volTrip = false
  if (vols.length < 2) {
    volSkipped = true
    volSkipReason = 'missing volume'
  } else {
    const lastVol = vols[vols.length - 1]!
    const earlier = vols.slice(0, -1)
    const meanEarlier = earlier.reduce((a, b) => a + b, 0) / earlier.length
    if (!(meanEarlier > 0)) {
      volSkipped = true
      volSkipReason = 'earlier volume mean is 0'
    } else {
      volDeathRatio = lastVol / meanEarlier
      volTrip = volDeathRatio <= th.volDeathRatio
    }
  }
  hits.push({
    id: 'volume_death',
    label: 'Volume death (last / earlier mean)',
    value: volDeathRatio,
    threshold: th.volDeathRatio,
    passed: volTrip,
    skipped: volSkipped,
    skipReason: volSkipReason,
  })

  const upOnlyCount = n > 0 ? bars.filter((b) => b.c > b.o).length : null
  const upOnlySkipped = n < OHLC_RUG_MAX_BARS
  const upOnlyTrip = !upOnlySkipped && upOnlyCount === OHLC_RUG_MAX_BARS
  hits.push({
    id: 'up_only_10',
    label: 'All 10 bars green (c > o)',
    value: upOnlyCount,
    threshold: OHLC_RUG_MAX_BARS,
    passed: upOnlyTrip,
    skipped: upOnlySkipped,
    skipReason: upOnlySkipped ? `need ${OHLC_RUG_MAX_BARS} bars` : undefined,
  })

  const trip = hits.some((h) => h.passed)

  return {
    trip,
    features: {
      n,
      dumpPct,
      avgUpperWick,
      wickTripBars,
      volDeathRatio,
      upOnlyCount,
    },
    hits,
  }
}

export function ohlcRugHitReasons(evalResult: OhlcRugEval): string[] {
  return evalResult.hits
    .filter((h) => h.passed)
    .map((h) => {
      const v =
        h.value == null
          ? '—'
          : h.id === 'dump_10m'
            ? `${(h.value * 100).toFixed(1)}%`
            : h.id === 'up_only_10'
              ? `${h.value}/${h.threshold}`
              : h.value.toFixed(3)
      const th =
        h.id === 'dump_10m'
          ? `${(h.threshold * 100).toFixed(0)}%`
          : h.id === 'up_only_10'
            ? `${h.threshold}`
            : h.threshold.toFixed(2)
      return `ohlc ${h.id}: ${v} vs ${th}`
    })
}
