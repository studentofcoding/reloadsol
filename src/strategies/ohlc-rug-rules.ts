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
  id: 'dump_10m' | 'wick_reject' | 'volume_death'
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
}

export type OhlcRugEval = {
  trip: boolean
  features: OhlcRugFeatures
  hits: OhlcRugRuleHit[]
}

const EPS = 1e-12

export function takeLastOhlcBars<T extends { t?: number; time?: number }>(
  bars: T[],
  n = OHLC_RUG_MAX_BARS,
): T[] {
  if (bars.length <= n) return bars.slice()
  return bars.slice(bars.length - n)
}

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

  const trip = hits.some((h) => h.passed)

  return {
    trip,
    features: {
      n,
      dumpPct,
      avgUpperWick,
      wickTripBars,
      volDeathRatio,
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
            : h.value.toFixed(3)
      const th =
        h.id === 'dump_10m'
          ? `${(h.threshold * 100).toFixed(0)}%`
          : h.threshold.toFixed(2)
      return `ohlc ${h.id}: ${v} vs ${th}`
    })
}
