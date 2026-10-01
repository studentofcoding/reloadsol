/**
 * Pure rug-signal score — the staircase / manufactured-ramp engine from
 * `strategies/RUG_SIGNAL.md` §3-§6. No IO: bars, mcap, liquidity and age are passed in.
 *
 * Score = A staircase (40, static) + B volume (30, band) + C liquidity (20, band) + D dump
 * (10, static) = 0..100. A and D are static — pro-rata over boolean sub-conditions. B and C are
 * continuous bands that scale 0 (safest) → their max (riskiest).
 *
 * A live ramp reaches A+B+C = 90, so the default threshold of 80 is cleared by a staircase plus
 * flat-ish volume plus thin liquidity, without waiting for the drop.
 *
 * CALIBRATION STATUS — the band anchors are NOT measured. `token_ohlc_bars` carries no volume at
 * all (the 15s sampler writes a spot price into o/h/l/c), and on the only labelled volume corpus
 * the candidate signals did not separate rug from rising. See the SPEC's calibration section;
 * treat every anchor as a starting point, not a fitted constant.
 *
 * This is predictive by construction and is a *separate* module from the reactive
 * `ohlc-rug-rules.ts` spine; see docs/specs/SPEC-rug-signal-v1.md.
 */

export type RugSignalBar = {
  t: number
  o: number
  h: number
  l: number
  c: number
  v?: number
}

export type RugSignalThresholds = {
  /** 5m bars scored, newest-last. */
  windowBars: number
  /** Fewer bars than this in the window → the shape components are not evaluated. */
  minBars: number
  /** A: share of green bars that must be exceeded. */
  stairBullishMin: number
  /** A: mean gain on green bars that must not be reached. */
  stairAvgGainMax: number
  /** A+B: window price gain that must be exceeded. */
  stairPriceGainMin: number
  /** A: upper-wick variance that must not be reached. */
  stairWickVarMax: number
  /** B: volume dispersion (CV) at or above this reads "healthy" → 0 risk. */
  volCvSafe: number
  /** B: weight of the proportional-expansion term vs the dispersion term (0..1). */
  volExpansionWeight: number
  /** C: liquidity/mcap at or above this reads "deep" → 0 risk. */
  liqSafeRatio: number
  /** D: single-bar drop that confirms a dump. */
  dumpBarDrop: number
  /** D: peak-to-trough over any 5 consecutive bars. */
  dumpDrawdown: number
  /** Score at or above this is a rug. */
  threshold: number
  /** Guardrail (RUG_SIGNAL.md §6): skip only when age and liquidity are both known-outsiders. */
  maxAgeH: number
  maxLiqUsd: number
}

export const DEFAULT_RUG_SIGNAL_THRESHOLDS: RugSignalThresholds = {
  windowBars: 20,
  minBars: 5,
  stairBullishMin: 0.7,
  stairAvgGainMax: 0.05,
  stairPriceGainMin: 0.8,
  stairWickVarMax: 0.02,
  volCvSafe: 0.35,
  volExpansionWeight: 0.5,
  liqSafeRatio: 0.1,
  dumpBarDrop: 0.4,
  dumpDrawdown: 0.6,
  threshold: 80,
  maxAgeH: 48,
  maxLiqUsd: 100_000,
}

export const RUG_SIGNAL_WEIGHTS = {
  staircase: 40,
  volume: 30,
  liquidity: 20,
  dump: 10,
} as const

/** Sum of the component weights — the score ceiling (100 for the current split). */
export const RUG_SIGNAL_MAX_SCORE = Object.values(RUG_SIGNAL_WEIGHTS).reduce(
  (sum, weight) => sum + weight,
  0,
)

export type RugSignalComponentId = keyof typeof RUG_SIGNAL_WEIGHTS

export type RugSignalCondition = {
  id: string
  met: boolean
  value: number | null
  threshold: number
}

/** A continuous band input: the measured value, the anchor that maps it to 0 risk, and risk 0..1. */
export type RugSignalMeasure = {
  id: string
  value: number | null
  anchor: number
  /** 0 = safest, 1 = riskiest. */
  risk: number
}

export type RugSignalComponent = {
  id: RugSignalComponentId
  label: string
  points: number
  max: number
  /** Static components (staircase, dump) report boolean sub-conditions. */
  conditions?: RugSignalCondition[]
  /** Band components (volume, liquidity) report continuous measures. */
  measures?: RugSignalMeasure[]
  /** Set when the component could not be scored (missing volume / liquidity / bars). */
  note?: string
}

export type RugSignalEval = {
  score: number
  isRug: boolean
  skipped: boolean
  skipReason?: string
  breakdown: Record<RugSignalComponentId, number>
  components: RugSignalComponent[]
  reasons: string[]
}

const EPS = 1e-12

type EnvLike = Record<string, string | undefined>

function envNum(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function envFlag(env: EnvLike, key: string, fallback = false): boolean {
  const v = env[key]
  if (v === undefined || v === '') return fallback
  return v === '1' || v === 'true'
}

/** Every knob, env-overridable. `RUG_SIG_*` — see the SPEC's component table. */
export function resolveRugSignalThresholds(
  env: EnvLike = process.env,
): RugSignalThresholds {
  const d = DEFAULT_RUG_SIGNAL_THRESHOLDS
  return {
    windowBars: envNum(env, 'RUG_SIG_WINDOW', d.windowBars),
    minBars: envNum(env, 'RUG_SIG_MIN_BARS', d.minBars),
    stairBullishMin: envNum(env, 'RUG_SIG_STAIR_BULLISH', d.stairBullishMin),
    stairAvgGainMax: envNum(env, 'RUG_SIG_STAIR_AVG_GAIN', d.stairAvgGainMax),
    stairPriceGainMin: envNum(env, 'RUG_SIG_STAIR_PRICE_GAIN', d.stairPriceGainMin),
    stairWickVarMax: envNum(env, 'RUG_SIG_STAIR_WICK_VAR', d.stairWickVarMax),
    volCvSafe: envNum(env, 'RUG_SIG_VOL_CV_SAFE', d.volCvSafe),
    volExpansionWeight: envNum(
      env,
      'RUG_SIG_VOL_EXPANSION_W',
      d.volExpansionWeight,
    ),
    liqSafeRatio: envNum(env, 'RUG_SIG_LIQ_SAFE_RATIO', d.liqSafeRatio),
    dumpBarDrop: envNum(env, 'RUG_SIG_DUMP_BAR', d.dumpBarDrop),
    dumpDrawdown: envNum(env, 'RUG_SIG_DUMP_DRAWDOWN', d.dumpDrawdown),
    threshold: envNum(env, 'RUG_SIG_THRESHOLD', d.threshold),
    maxAgeH: envNum(env, 'RUG_SIG_MAX_AGE_H', d.maxAgeH),
    maxLiqUsd: envNum(env, 'RUG_SIG_MAX_LIQ_USD', d.maxLiqUsd),
  }
}

export function isRugSignalEnabled(env: EnvLike = process.env): boolean {
  return envFlag(env, 'RUG_SIGNAL_ENABLED', false)
}

/** Kill switch forces shadow; `off` is expressed by disabling the feature. */
export function rugSignalMode(env: EnvLike = process.env): 'shadow' | 'enforce' {
  if (envFlag(env, 'RUG_SIGNAL_KILL_SWITCH', false)) return 'shadow'
  return env.RUG_SIGNAL_MODE?.trim().toLowerCase() === 'shadow'
    ? 'shadow'
    : 'enforce'
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function variance(values: number[]): number | null {
  const m = mean(values)
  if (m == null) return null
  return values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length
}

/** Band helper: 0 = safest, 1 = riskiest. */
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function upperWickRatio(bar: RugSignalBar): number | null {
  const range = bar.h - bar.l
  if (!(range > EPS)) return null
  return (bar.h - Math.max(bar.o, bar.c)) / range
}

/** 1m → 5m buckets keyed on `floor(t / 300)`. v stays undefined unless every bar had it. */
export function aggregateTo5m(bars1m: RugSignalBar[]): RugSignalBar[] {
  const clean = bars1m
    .filter(
      (b) =>
        Number.isFinite(b.t) &&
        Number.isFinite(b.o) &&
        Number.isFinite(b.h) &&
        Number.isFinite(b.l) &&
        Number.isFinite(b.c) &&
        b.o > 0 &&
        b.c > 0,
    )
    .sort((a, b) => a.t - b.t)
  const out: RugSignalBar[] = []
  let bucket: number | null = null
  let cur: RugSignalBar | null = null
  let allHaveVolume = true
  for (const bar of clean) {
    const key = Math.floor(bar.t / 300)
    if (bucket !== key) {
      if (cur) out.push(cur)
      bucket = key
      cur = {
        t: key * 300,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v: bar.v,
      }
      allHaveVolume = typeof bar.v === 'number' && Number.isFinite(bar.v)
      continue
    }
    cur!.h = Math.max(cur!.h, bar.h)
    cur!.l = Math.min(cur!.l, bar.l)
    cur!.c = bar.c
    if (typeof bar.v === 'number' && Number.isFinite(bar.v) && allHaveVolume) {
      cur!.v = (cur!.v ?? 0) + bar.v
    } else {
      allHaveVolume = false
      cur!.v = undefined
    }
  }
  if (cur) out.push(cur)
  return out
}

function pointsFrom(conditions: RugSignalCondition[], max: number): number {
  if (conditions.length === 0) return 0
  const met = conditions.filter((c) => c.met).length
  return Math.round((max * met) / conditions.length)
}

function staircaseComponent(
  bars: RugSignalBar[],
  th: RugSignalThresholds,
): RugSignalComponent {
  const max = RUG_SIGNAL_WEIGHTS.staircase
  const label = 'Staircase'
  if (bars.length < th.minBars) {
    return {
      id: 'staircase',
      label,
      points: 0,
      max,
      conditions: [],
      note: `insufficient bars ${bars.length} < ${th.minBars}`,
    }
  }
  const greens = bars.filter((b) => b.c > b.o)
  const bullishRatio = bars.length > 0 ? greens.length / bars.length : null
  const avgGain = greens.length > 0 ? mean(greens.map((b) => (b.c - b.o) / b.o)) : null
  const first = bars[0]!
  const last = bars[bars.length - 1]!
  const priceGain = (last.c - first.c) / first.c
  const wicks = bars
    .map(upperWickRatio)
    .filter((r): r is number => r != null)
  const wickVar = wicks.length >= 2 ? variance(wicks) : null

  const conditions: RugSignalCondition[] = [
    {
      id: 'bullish_ratio',
      met: bullishRatio != null && bullishRatio > th.stairBullishMin,
      value: bullishRatio,
      threshold: th.stairBullishMin,
    },
    {
      id: 'avg_gain',
      met: avgGain != null && avgGain < th.stairAvgGainMax,
      value: avgGain,
      threshold: th.stairAvgGainMax,
    },
    {
      id: 'price_gain',
      met: priceGain > th.stairPriceGainMin,
      value: priceGain,
      threshold: th.stairPriceGainMin,
    },
    {
      id: 'wick_variance',
      met: wickVar != null && wickVar < th.stairWickVarMax,
      value: wickVar,
      threshold: th.stairWickVarMax,
    },
  ]
  return {
    id: 'staircase',
    label,
    points: pointsFrom(conditions, max),
    max,
    conditions,
  }
}

/**
 * B — volume band, 0 (safest) → 30 (riskiest).
 *
 * Two continuous sub-signals, averaged with `volExpansionWeight`:
 *   expansion = clamp01(1 − volGrowth / priceGain)  — volume growing as fast as price is organic
 *                                                     (risk 0); flat volume under a ramp is risk 1.
 *   dispersion = clamp01(1 − cv / volCvSafe)        — dead-flat volume is the manufactured tell.
 *
 * Not a hard gate: a ramp that is merely flat-ish lands part-way up the band.
 * Measured caveat: neither sub-signal separated rug from rising on our labelled corpus.
 */
function volumeComponent(
  bars: RugSignalBar[],
  th: RugSignalThresholds,
): RugSignalComponent {
  const max = RUG_SIGNAL_WEIGHTS.volume
  const label = 'Volume manipulation'
  const vols = bars
    .map((b) => b.v)
    .filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
  if (bars.length < 3 || vols.length < 3) {
    return {
      id: 'volume',
      label,
      points: 0,
      max,
      measures: [],
      note: 'volume unknown',
    }
  }
  const first = bars[0]!
  const last = bars[bars.length - 1]!
  const priceGain = (last.c - first.c) / first.c

  // The band is "price rising without proportional volume expansion" — with no rise there is no
  // manipulation to price, so it scores 0 instead of punishing an inert token on dispersion alone.
  if (!(priceGain > 0)) {
    return {
      id: 'volume',
      label,
      points: 0,
      max,
      measures: [],
      note: 'price not rising',
    }
  }

  const third = Math.max(1, Math.floor(vols.length / 3))
  const headMean = mean(vols.slice(0, third))
  const tailMean = mean(vols.slice(-third))
  const volGain =
    headMean != null && headMean > 0 && tailMean != null ? tailMean / headMean : null
  /** Growth fraction: 0 = flat, +1 = doubled. */
  const volGrowth = volGain == null ? null : volGain - 1
  const volCv = (() => {
    const m = mean(vols)
    if (m == null || !(m > 0)) return null
    const sd = Math.sqrt(variance(vols) ?? 0)
    return sd / m
  })()

  const w = Math.max(0, Math.min(1, th.volExpansionWeight))
  const expansionRisk =
    volGrowth != null && priceGain > 0 ? clamp01(1 - volGrowth / priceGain) : 0
  const dispersionRisk = volCv != null ? clamp01(1 - volCv / th.volCvSafe) : 0
  const risk01 = w * expansionRisk + (1 - w) * dispersionRisk

  const measures: RugSignalMeasure[] = [
    {
      id: 'expansion',
      value: volGrowth != null && priceGain > 0 ? volGrowth : null,
      anchor: priceGain > 0 ? priceGain : 0,
      risk: expansionRisk,
    },
    { id: 'dispersion', value: volCv, anchor: th.volCvSafe, risk: dispersionRisk },
  ]
  return {
    id: 'volume',
    label,
    points: Math.round(max * risk01),
    max,
    measures,
  }
}

function liquidityComponent(input: {
  mcap: number | null
  liquidityUsd: number | null
  th: RugSignalThresholds
}): RugSignalComponent {
  const max = RUG_SIGNAL_WEIGHTS.liquidity
  const label = 'Liquidity risk'
  const { mcap, liquidityUsd, th } = input
  if (mcap == null || !(mcap > 0) || liquidityUsd == null || !(liquidityUsd >= 0)) {
    return {
      id: 'liquidity',
      label,
      points: 0,
      max,
      measures: [],
      note: 'liquidity unknown',
    }
  }
  const ratio = liquidityUsd / mcap
  // Linear band from "deep" (liqSafeRatio → risk 0) down to zero liquidity (risk 1).
  const risk01 = clamp01(1 - ratio / th.liqSafeRatio)
  return {
    id: 'liquidity',
    label,
    points: Math.round(max * risk01),
    max,
    measures: [{ id: 'liq_ratio', value: ratio, anchor: th.liqSafeRatio, risk: risk01 }],
  }
}

function dumpComponent(
  bars: RugSignalBar[],
  th: RugSignalThresholds,
): RugSignalComponent {
  const max = RUG_SIGNAL_WEIGHTS.dump
  const label = 'Dump'
  if (bars.length === 0) {
    return { id: 'dump', label, points: 0, max, conditions: [], note: 'no bars' }
  }
  const barDrop = Math.max(...bars.map((b) => (b.o - b.c) / b.o))
  let drawdown = 0
  for (let i = 0; i + 4 < bars.length; i++) {
    const window = bars.slice(i, i + 5)
    const peak = Math.max(...window.map((b) => b.h))
    const trough = Math.min(...window.map((b) => b.l))
    if (peak > 0) drawdown = Math.max(drawdown, (peak - trough) / peak)
  }
  const conditions: RugSignalCondition[] = [
    {
      id: 'bar_drop',
      met: barDrop > th.dumpBarDrop,
      value: barDrop,
      threshold: th.dumpBarDrop,
    },
    {
      id: 'drawdown_5',
      met: drawdown > th.dumpDrawdown,
      value: drawdown,
      threshold: th.dumpDrawdown,
    },
  ]
  return {
    id: 'dump',
    label,
    points: pointsFrom(conditions, max),
    max,
    conditions,
  }
}

function fmt(v: number | null, digits = 2): string {
  return v == null ? '—' : v.toFixed(digits)
}

function componentReason(c: RugSignalComponent): string {
  const detail = c.conditions?.length
    ? c.conditions
        .map((x) => `${x.id} ${fmt(x.value, 3)} ${x.met ? 'vs' : '!'}${fmt(x.threshold, 3)}`)
        .join(', ')
    : c.measures?.length
      ? c.measures
          .map(
            (m) =>
              `${m.id} ${fmt(m.value, 3)}→${fmt(m.anchor, 3)} risk ${fmt(m.risk, 2)}`,
          )
          .join(', ')
      : (c.note ?? 'n/a')
  return `rug ${c.id}: ${c.points}/${c.max} (${detail})`
}

/**
 * Score a token's last ≤`windowBars` 5m bars.
 * `bars` may be 1m or 5m — callers should pass 5m (`aggregateTo5m`); the scorer only
 * reads what it is given.
 */
export function evaluateRugSignal(
  input: {
    bars: RugSignalBar[]
    mcap?: number | null
    liquidityUsd?: number | null
    ageHours?: number | null
  },
  thresholds: Partial<RugSignalThresholds> = {},
): RugSignalEval {
  const th = { ...DEFAULT_RUG_SIGNAL_THRESHOLDS, ...thresholds }
  const sorted = input.bars
    .filter((b) => Number.isFinite(b.t))
    .sort((a, b) => a.t - b.t)
  const bars = sorted.slice(Math.max(0, sorted.length - th.windowBars))

  const mcap = finite(input.mcap)
  const liquidityUsd = finite(input.liquidityUsd)
  const ageHours = finite(input.ageHours)

  const components: RugSignalComponent[] = [
    staircaseComponent(bars, th),
    volumeComponent(bars, th),
    liquidityComponent({ mcap, liquidityUsd, th }),
    dumpComponent(bars, th),
  ]

  const breakdown = components.reduce(
    (acc, c) => {
      acc[c.id] = c.points
      return acc
    },
    { staircase: 0, volume: 0, liquidity: 0, dump: 0 } as Record<
      RugSignalComponentId,
      number
    >,
  )

  const score = Math.min(
    RUG_SIGNAL_MAX_SCORE,
    Math.max(0, components.reduce((sum, c) => sum + c.points, 0)),
  )

  // Guardrail: skip only when we *know* both axes are outside the shape's target
  // (an old, liquid token is not this pattern's target). Unknowns never skip.
  let skipped = false
  let skipReason: string | undefined
  if (
    ageHours != null &&
    ageHours >= th.maxAgeH &&
    liquidityUsd != null &&
    liquidityUsd >= th.maxLiqUsd
  ) {
    skipped = true
    skipReason = `age ${fmt(ageHours, 1)}h ≥ ${th.maxAgeH}h and liquidity $${Math.round(liquidityUsd)} ≥ $${th.maxLiqUsd}`
  }

  const isRug = !skipped && score >= th.threshold

  const reasons = components.map(componentReason)
  if (skipped) reasons.push(`rug signal skipped: ${skipReason}`)
  reasons.push(
    `rug signal score ${score}/100 vs threshold ${th.threshold} → ${isRug ? 'rug' : 'not rug'}`,
  )

  return { score, isRug, skipped, skipReason, breakdown, components, reasons }
}

/** Convenience: build the scorer's input from 1m bars. */
export function evaluateRugSignalFrom1m(
  input: {
    bars1m: RugSignalBar[]
    mcap?: number | null
    liquidityUsd?: number | null
    ageHours?: number | null
  },
  thresholds: Partial<RugSignalThresholds> = {},
): RugSignalEval {
  return evaluateRugSignal(
    {
      bars: aggregateTo5m(input.bars1m),
      mcap: input.mcap,
      liquidityUsd: input.liquidityUsd,
      ageHours: input.ageHours,
    },
    thresholds,
  )
}
