/**
 * Rug-signal calibration — replay the stored observations under candidate anchors.
 *
 * The problem this exists for: the trip was **unreachable**, not rare. Across 1,041 judged
 * observations the best joint score was 65/80 and the reachable pre-dump ceiling was 75, because
 * `volumeComponent` averages in a `dispersion` term (`1 − cv/volCvSafe`) that is ~0 on trade-driven
 * data — most minutes never traded, so the per-bucket volume CV is intrinsically large. Measuring
 * that term properly would mean calling "few trades" risky, which this module's own calibration
 * already refuted. So the fix is to stop averaging in a term our data cannot inform, and the
 * evidence for it comes from here.
 *
 * **Why this is not a script.** A standalone `.mjs` cannot import the scorer (the production image
 * ships no TypeScript toolchain), and re-implementing the scoring would make the calibration a
 * different program from the thing being calibrated. So the replay runs **in the app**, with the
 * real `evaluateRugSignalFrom1m`, and is driven by an API the dev page calls — which also makes the
 * loop interactive: change an anchor, see the trip rate.
 *
 * **It is a replay, not a write.** Nothing here touches the shadow log or the series: the historical
 * rows stay exactly as the old anchors scored them, so the record of what we believed is preserved.
 */

import { query } from '@/utils/db'
import { ohlcvMinutesToRugBars } from '@/strategies/rug-signal-detect'
import {
  evaluateRugSignalFrom1m,
  resolveRugSignalThresholds,
  type RugSignalThresholds,
} from '@/strategies/rug-signal'

/** Anchors a replay may vary. Everything the scorer's bands and conditions read. */
export type CalibrationOverrides = Partial<
  Pick<
    RugSignalThresholds,
    | 'threshold'
    | 'coreThreshold'
    | 'coreMinLiquidity'
    | 'stairBullishMin'
    | 'stairAvgGainMax'
    | 'stairPriceGainMin'
    | 'stairWickVarMax'
    | 'volCvSafe'
    | 'volExpansionWeight'
    | 'liqSafeRatio'
  >
>

export type CalibrationRun = {
  days: number
  overrides: CalibrationOverrides
  /** Shadow rows considered (judged, series-sourced). */
  sampled: number
  /** Rows whose bars could be rebuilt and re-scored. */
  rescored: number
  /** Rows compared against their stored breakdown (only when no override changes the scoring). */
  crossCheckChecked: number
  crossCheckMismatches: number
  trips: number
  tripRate: number
  /** Which path produced each trip — a core-pair trip is a different claim from a score trip. */
  tripsByPath: { score: number; core: number }
  /**
   * The same observations under both bar bases — T2's gate. `judged` is the number that matters:
   * ten 1m bars is two 5m bars, so the 5m basis reports `no_bars` (an unknown, not a low score)
   * where the 1m block can score. Both are reported so the switch is measurable, not a cliff.
   */
  bases: { fiveM: { judged: number; trips: number }; oneM: { judged: number; trips: number } }
  /** The shape pair (`staircase + liquidity`) across the population, against its own threshold. */
  core: { avg: number; max: number }
  best: { score: number; mint: string } | null
  scoreHistogram: Array<{ score: number; n: number }>
  /** Per component: average points, the observed maximum, and the component's own maximum. */
  components: Array<{ id: string; avgPoints: number; maxPoints: number; maxOf: number }>
  /** Per staircase condition: how often it was met, and where its values actually sit. */
  conditions: Array<{
    id: string
    metRate: number | null
    threshold: number | null
    p10: number | null
    p50: number | null
    p90: number | null
  }>
  /** Per band term: the observed distribution of its raw measure against its anchor. */
  measures: Array<{ id: string; p10: number | null; p50: number | null; p90: number | null }>
  /** The anchors this run actually used (env + overrides). */
  effective: CalibrationOverrides
}

/** Rows replayed in one call — bounded so a request cannot scan the whole log. */
const MAX_ROWS = 400
/** Bars the scorer needs: `windowBars` 5m bars plus slack, mirroring the detector's own lookback. */
const BARS_WINDOW_MINUTES = 240

/**
 * Whitelist and range-check an anchor override bag.
 *
 * A caller may propose anchors, but nothing from a request is spread into the scorer unchecked: an
 * unknown key, a string, or a NaN would quietly change scoring in ways no test covers. Unknown keys
 * are **dropped** rather than rejected, so a form can send a whole set and have the wrong ones
 * ignored — but a value outside its bounds is clamped, never trusted.
 */
export function sanitizeOverrides(input: unknown): CalibrationOverrides {
  if (!input || typeof input !== 'object') return {}
  const bounds: Record<keyof CalibrationOverrides, [number, number]> = {
    threshold: [0, 100],
    coreThreshold: [0, 100],
    coreMinLiquidity: [0, 20],
    stairBullishMin: [0, 1],
    stairAvgGainMax: [0, 1],
    stairPriceGainMin: [0, 10],
    stairWickVarMax: [0, 1],
    volCvSafe: [0, 10],
    volExpansionWeight: [0, 1],
    liqSafeRatio: [0, 10],
  }
  const out: CalibrationOverrides = {}
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!(key in bounds)) continue
    const value = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(value)) continue
    const [lo, hi] = bounds[key as keyof CalibrationOverrides]
    out[key as keyof CalibrationOverrides] = Math.min(Math.max(value, lo), hi)
  }
  return out
}

type ShadowPoint = {
  token_address: string
  created_at: string
  breakdown: Record<string, number> | null
  score: number | null
}

type HourRow = {
  token_address: string
  hour_bucket: string
  vol_min: number[] | null
  o_min: number[] | null
  h_min: number[] | null
  l_min: number[] | null
  c_min: number[] | null
  /** Written by the same sweep from the same `meme_quote_info` call the live path uses. */
  liquidity_close: number | null
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? null
}

/** Minutes as vendor-shaped bars, ascending, for one token up to (and including) `untilMs`. */
function barsUpTo(rows: HourRow[], untilMs: number) {
  const minutes: Array<{
    t: number
    o?: number | null
    h?: number | null
    l?: number | null
    c?: number | null
    v?: number | null
  }> = []
  const untilSec = Math.floor(untilMs / 1000)
  const fromSec = untilSec - BARS_WINDOW_MINUTES * 60

  for (const row of rows) {
    const hourMs = Date.parse(row.hour_bucket)
    if (!Number.isFinite(hourMs)) continue
    for (let i = 0; i < 60; i++) {
      const t = Math.floor(hourMs / 1000) + i * 60
      if (t < fromSec || t > untilSec) continue
      const c = row.c_min?.[i]
      if (c == null) continue
      minutes.push({
        t,
        o: row.o_min?.[i] ?? null,
        h: row.h_min?.[i] ?? null,
        l: row.l_min?.[i] ?? null,
        c,
        v: row.vol_min?.[i] ?? null,
      })
    }
  }
  return ohlcvMinutesToRugBars(minutes.sort((a, b) => a.t - b.t))
}

/** The most recent recorded liquidity at or before `untilMs` — the value the sweep had in hand. */
function liquidityAsOf(rows: HourRow[], untilMs: number): number | null {
  let found: number | null = null
  for (const row of rows) {
    const hourMs = Date.parse(row.hour_bucket)
    if (!Number.isFinite(hourMs)) continue
    if (hourMs > untilMs) break
    if (row.liquidity_close != null && Number.isFinite(row.liquidity_close)) {
      found = row.liquidity_close
    }
  }
  return found
}

/**
 * Re-score the stored observations under candidate anchors.
 *
 * Read-only apart from the caller's own persistence: it never writes a verdict, never writes the
 * series, and never touches the shadow log.
 */
export async function replayRugSignal(params: {
  days?: number
  overrides?: CalibrationOverrides
}): Promise<CalibrationRun> {
  const days = Math.min(Math.max(1, Math.floor(params.days ?? 1)), 14)
  const overrides = params.overrides ?? {}
  const thresholds = { ...resolveRugSignalThresholds(), ...overrides }

  const { rows: points } = await query<ShadowPoint>(
    `SELECT token_address, created_at::text, breakdown, score
       FROM rug_signal_shadow
      WHERE created_at > NOW() - make_interval(days => $1::int)
        AND bars_source = 'series'
        AND bars_scored >= 5
      ORDER BY created_at DESC
      LIMIT ${MAX_ROWS}`,
    [days],
  )

  if (points.length === 0) {
    return {
      days,
      overrides,
      sampled: 0,
      rescored: 0,
      crossCheckChecked: 0,
      crossCheckMismatches: 0,
      trips: 0,
      tripRate: 0,
      tripsByPath: { score: 0, core: 0 },
      bases: { fiveM: { judged: 0, trips: 0 }, oneM: { judged: 0, trips: 0 } },
      core: { avg: 0, max: 0 },
      best: null,
      scoreHistogram: [],
      components: [],
      conditions: [],
      measures: [],
      effective: {},
    }
  }

  // One query for every mint's hours, then group in memory — not a query per row.
  const mints = [...new Set(points.map((p) => p.token_address))]
  const { rows: hours } = await query<HourRow>(
    `SELECT token_address, hour_bucket::text, vol_min, o_min, h_min, l_min, c_min, liquidity_close
       FROM token_metrics_history
      WHERE token_address = ANY($1::text[])
        AND hour_bucket > NOW() - make_interval(days => $2::int)
      ORDER BY hour_bucket ASC`,
    [mints, days + 1],
  )
  const byMint = new Map<string, HourRow[]>()
  for (const row of hours) {
    const list = byMint.get(row.token_address) ?? []
    list.push(row)
    byMint.set(row.token_address, list)
  }

  // A replay is only cross-checkable against the log when it changes nothing about the scoring.
  const scoringTouched = Object.keys(overrides).length > 0

  const scores: number[] = []
  const perComponent = new Map<string, number[]>()
  const perComponentMax = new Map<string, number>()
  const conditionMet = new Map<string, number>()
  const conditionSeen = new Map<string, number>()
  /**
   * The measured values behind each condition, not just whether it passed. A met-rate alone says a
   * condition is rare; the distribution says *where* to put the threshold, which is the operator's
   * call rather than a number to guess at.
   */
  const conditionValues = new Map<string, number[]>()
  const conditionThreshold = new Map<string, number>()
  const measureValues = new Map<string, number[]>()
  let trips = 0
  let tripsByScore = 0
  let tripsByCore = 0
  const coreValues: number[] = []
  let best: { score: number; mint: string } | null = null
  let judgedFiveM = 0
  let judgedOneM = 0
  let tripsOneM = 0
  let crossCheckChecked = 0
  let crossCheckMismatches = 0

  for (const point of points) {
    const rows = byMint.get(point.token_address)
    if (!rows) continue
    const atMs = Date.parse(point.created_at)
    const bars = barsUpTo(rows, atMs)
    if (bars.length === 0) continue

    // Give the scorer the same three inputs the sweep gives it: the bars, the market cap at the
    // evaluation time (the last observed candle close — one source, one job), and the liquidity that
    // same sweep recorded. Omitting these silently zeroed the liquidity component and made this
    // replay disagree with the very log it exists to explain.
    const mcap = bars[bars.length - 1]?.c ?? null
    const liquidityUsd = liquidityAsOf(rows, atMs)

    const result = evaluateRugSignalFrom1m(
      { bars1m: bars, mcap, liquidityUsd, ageHours: null },
      thresholds,
    )

    // The same row under the block basis, reported beside the 5m result so the two are comparable on
    // real observations rather than a leap of faith. `judged` is the number that moves: ten 1m bars
    // is two 5m bars, so the 5m basis calls a fresh token `no_bars` where the block can score it.
    const block = evaluateRugSignalFrom1m(
      { bars1m: bars, mcap, liquidityUsd, ageHours: null },
      thresholds,
      { basis: '1m' },
    )
    if (result.judged) judgedFiveM++
    if (block.judged) judgedOneM++
    if (block.isRug) tripsOneM++

    if (!scoringTouched && point.breakdown) {
      crossCheckChecked++
      const same = (['staircase', 'volume', 'liquidity', 'dump'] as const).every(
        (id) => (point.breakdown?.[id] ?? 0) === (result.breakdown[id] ?? 0),
      )
      if (!same) crossCheckMismatches++
    }

    scores.push(result.score)
    coreValues.push(result.core)
    if (result.isRug) {
      trips++
      // Count the stronger claim when both hold: a score trip meets the original rule.
      if (result.score >= thresholds.threshold) tripsByScore++
      else tripsByCore++
    }
    if (!best || result.score > best.score) best = { score: result.score, mint: point.token_address }

    for (const component of result.components) {
      const list = perComponent.get(component.id) ?? []
      list.push(component.points)
      perComponent.set(component.id, list)
      perComponentMax.set(
        component.id,
        Math.max(perComponentMax.get(component.id) ?? 0, component.max),
      )
      for (const condition of component.conditions ?? []) {
        conditionSeen.set(condition.id, (conditionSeen.get(condition.id) ?? 0) + 1)
        if (condition.met) conditionMet.set(condition.id, (conditionMet.get(condition.id) ?? 0) + 1)
        if (condition.threshold != null && Number.isFinite(condition.threshold)) {
          conditionThreshold.set(condition.id, condition.threshold)
        }
        if (condition.value != null && Number.isFinite(condition.value)) {
          const values = conditionValues.get(condition.id) ?? []
          values.push(condition.value)
          conditionValues.set(condition.id, values)
        }
      }
      for (const measure of component.measures ?? []) {
        if (measure.value == null || !Number.isFinite(measure.value)) continue
        const list = measureValues.get(measure.id) ?? []
        list.push(measure.value)
        measureValues.set(measure.id, list)
      }
    }
  }

  const histogram = new Map<number, number>()
  for (const score of scores) histogram.set(score, (histogram.get(score) ?? 0) + 1)

  return {
    days,
    overrides,
    sampled: points.length,
    rescored: scores.length,
    crossCheckChecked,
    crossCheckMismatches,
    trips,
    tripRate: scores.length > 0 ? trips / scores.length : 0,
    tripsByPath: { score: tripsByScore, core: tripsByCore },
    bases: {
      fiveM: { judged: judgedFiveM, trips },
      oneM: { judged: judgedOneM, trips: tripsOneM },
    },
    core: {
      avg: coreValues.length > 0 ? coreValues.reduce((s, v) => s + v, 0) / coreValues.length : 0,
      max: coreValues.length > 0 ? Math.max(...coreValues) : 0,
    },
    best,
    scoreHistogram: [...histogram.entries()]
      .map(([score, n]) => ({ score, n }))
      .sort((a, b) => b.score - a.score),
    components: [...perComponent.entries()]
      .map(([id, values]) => ({
        id,
        avgPoints: values.reduce((s, v) => s + v, 0) / values.length,
        maxPoints: Math.max(...values),
        maxOf: perComponentMax.get(id) ?? 0,
      }))
      .sort((a, b) => b.maxOf - a.maxOf),
    conditions: [...conditionSeen.entries()].map(([id, seen]) => {
      const values = conditionValues.get(id) ?? []
      return {
        id,
        metRate: seen > 0 ? (conditionMet.get(id) ?? 0) / seen : null,
        threshold: conditionThreshold.get(id) ?? null,
        p10: percentile(values, 0.1),
        p50: percentile(values, 0.5),
        p90: percentile(values, 0.9),
      }
    }),
    measures: [...measureValues.entries()].map(([id, values]) => ({
      id,
      p10: percentile(values, 0.1),
      p50: percentile(values, 0.5),
      p90: percentile(values, 0.9),
    })),
    effective: {
      threshold: thresholds.threshold,
      coreThreshold: thresholds.coreThreshold,
      coreMinLiquidity: thresholds.coreMinLiquidity,
      volExpansionWeight: thresholds.volExpansionWeight,
      volCvSafe: thresholds.volCvSafe,
      liqSafeRatio: thresholds.liqSafeRatio,
      stairBullishMin: thresholds.stairBullishMin,
      stairAvgGainMax: thresholds.stairAvgGainMax,
      stairPriceGainMin: thresholds.stairPriceGainMin,
      stairWickVarMax: thresholds.stairWickVarMax,
    },
  }
}

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS rug_signal_calibration (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    days INTEGER NOT NULL,
    overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
    summary JSONB NOT NULL
  )
`
const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS rug_signal_calibration_created_idx
  ON rug_signal_calibration (created_at DESC)`

let ensurePromise: Promise<void> | null = null

async function ensureCalibrationTable(): Promise<void> {
  if (ensurePromise) {
    await ensurePromise
    return
  }
  ensurePromise = (async () => {
    await query(CREATE_TABLE_SQL)
    await query(CREATE_INDEX_SQL)
  })()
    .then(() => undefined)
    .catch((error) => {
      ensurePromise = null
      throw error
    })
  await ensurePromise
}

/** Persist a run so settings are comparable over time instead of living in a terminal scrollback. */
export async function recordCalibrationRun(run: CalibrationRun): Promise<void> {
  try {
    await ensureCalibrationTable()
    await query(
      `INSERT INTO rug_signal_calibration (days, overrides, summary) VALUES ($1, $2::jsonb, $3::jsonb)`,
      [run.days, JSON.stringify(run.overrides), JSON.stringify(run)],
    )
  } catch (error) {
    console.warn('[rug-signal:calibration] persist failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export type CalibrationRunRow = {
  id: string
  createdAt: string
  days: number
  overrides: CalibrationOverrides
  summary: CalibrationRun
}

export async function loadCalibrationRuns(limit = 10): Promise<CalibrationRunRow[]> {
  try {
    await ensureCalibrationTable()
    const take = Math.min(Math.max(1, Math.floor(limit)), 50)
    const { rows } = await query<{
      id: string
      created_at: string
      days: number
      overrides: CalibrationOverrides
      summary: CalibrationRun
    }>(
      `SELECT id::text AS id, created_at::text AS created_at, days, overrides, summary
         FROM rug_signal_calibration ORDER BY created_at DESC LIMIT $1`,
      [take],
    )
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      days: r.days,
      overrides: r.overrides,
      summary: r.summary,
    }))
  } catch (error) {
    console.warn('[rug-signal:calibration] read failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}
