import { query } from '@/utils/db'

/**
 * Rug-signal separation — is any single component doing the work the trip claims to do?
 *
 * Server-side twin of `scripts/rug-signal-validate.mjs`. The script has to run inside a container
 * with no TypeScript toolchain, so it keeps its own plain-JS copy of this arithmetic; when a rule
 * changes here, change it there too (and vice versa). This module is the one the dev page renders.
 *
 * Two design points, both learned the hard way:
 *   * **The trip is the scorer's stored `decision`**, never a re-derived score comparison. The old
 *     CLI re-derived it as `score >= threshold`, which could never fire, and reported `trips: 0`
 *     forever while the shape-pair path was tripping.
 *   * **Rows are not independent.** The same mint is re-evaluated on every sweep, so a bucket of 22
 *     rows can be 3 mints seen 11 times. Every rate here is reported twice — per row and per
 *     distinct mint — because the pooled per-row number is the one that lies.
 *
 * Nothing here writes. The label is derived forward from the market-cap minutes, independently of
 * the scorer being judged.
 */

export const SEPARATION = {
  minBars: 5,
  eventDrop: 0.6,
  eventWindowMin: 30,
  minLabelled: 30,
  minPositives: 5,
  coreThreshold: 40,
  coreMinLiquidity: 10,
} as const

export type Interval = { lo: number; hi: number }

export type Cell = {
  n: number
  hits: number
  /** null when there is nothing to divide by — never 0, which would read as a measured zero. */
  rate: number | null
  ci: Interval | null
  /** False below the sample floor: the number is not yet a result. */
  conclusive: boolean
}

export type Bucket = Cell & { label: string }
export type SweepPoint = Cell & { candidate: number }

export type SeparationRow = {
  mint: string
  createdAt: string
  day: string
  score: number | null
  decision: string
  staircase: number
  liquidity: number
  core: number
  liqRatio: number | null
  collapsed: boolean
}

export type SeparationReport = {
  days: number
  rows: {
    shadow: number
    judged: number
    labelled: number
    unlabellable: number
    collapses: number
    mints: number
    /** Per **row** — the same mint contributes once per sweep, so this base is overstated. */
    baseRate: number | null
    baseCi: Interval | null
    /** Per **distinct mint** — the base the per-mint buckets must be compared against. */
    mintCollapses: number
    mintBaseRate: number | null
    mintBaseCi: Interval | null
  }
  staircase: Bucket[]
  liquidity: Bucket[]
  staircaseSweep: SweepPoint[]
  liquiditySweep: SweepPoint[]
  coreSweep: SweepPoint[]
  perDay: Array<{ day: string; rows: number; collapses: number; staircaseTrips: number; staircaseCollapses: number }>
  verdict: { state: 'inconclusive' | 'no_lift' | 'lift'; text: string }
}

/** Wilson score interval — honest at small n, which is exactly where this starts. */
export function wilson(successes: number, n: number): Interval {
  if (n <= 0) return { lo: 0, hi: 1 }
  const z = 1.96
  const p = successes / n
  const denominator = 1 + (z * z) / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return {
    lo: Math.max(0, (centre - spread) / denominator),
    hi: Math.min(1, (centre + spread) / denominator),
  }
}

export function cell(hits: number, n: number, minPositives = SEPARATION.minPositives): Cell {
  if (n <= 0) return { n, hits, rate: null, ci: null, conclusive: false }
  return { n, hits, rate: hits / n, ci: wilson(hits, n), conclusive: n >= minPositives }
}

export function bucketize(
  values: Array<{ x: number | null; hit: boolean }>,
  buckets: Array<{ label: string; lo: number; hi: number }>,
): Bucket[] {
  return buckets.map((bucket) => {
    const inRange = values.filter((v) => v.x != null && v.x >= bucket.lo && v.x < bucket.hi)
    return { label: bucket.label, ...cell(inRange.filter((v) => v.hit).length, inRange.length) }
  })
}

/** First evaluation per mint. Ascending input, so the first seen is the earliest. */
export function dedupeByMint(rows: SeparationRow[]): SeparationRow[] {
  const seen = new Set<string>()
  const out: SeparationRow[] = []
  for (const row of rows) {
    if (seen.has(row.mint)) continue
    seen.add(row.mint)
    out.push(row)
  }
  return out
}

export const STAIRCASE_BUCKETS = [
  { label: '0–9', lo: 0, hi: 10 },
  { label: '10–24', lo: 10, hi: 25 },
  { label: '25–40', lo: 25, hi: 41 },
]

export const LIQUIDITY_BUCKETS = [
  { label: '< 2%', lo: 0, hi: 0.02 },
  { label: '2–5%', lo: 0.02, hi: 0.05 },
  { label: '5–10%', lo: 0.05, hi: 0.1 },
  { label: '≥ 10%', lo: 0.1, hi: Infinity },
]

const STAIRCASE_CANDIDATES = [30, 25, 20, 15, 10]
const LIQUIDITY_CANDIDATES = [0.01, 0.02, 0.03, 0.05]
const CORE_CANDIDATES = [46, 40, 35, 30, 25]

export function staircaseView(rows: SeparationRow[]): { buckets: Bucket[]; sweep: SweepPoint[] } {
  return {
    buckets: bucketize(
      rows.map((r) => ({ x: r.staircase, hit: r.collapsed })),
      STAIRCASE_BUCKETS,
    ),
    sweep: STAIRCASE_CANDIDATES.map((candidate) => ({
      candidate,
      ...cell(rows.filter((r) => r.staircase >= candidate && r.collapsed).length, rows.filter((r) => r.staircase >= candidate).length),
    })),
  }
}

export function liquidityView(rows: SeparationRow[]): { buckets: Bucket[]; sweep: SweepPoint[] } {
  return {
    buckets: bucketize(
      rows.map((r) => ({ x: r.liqRatio, hit: r.collapsed })),
      LIQUIDITY_BUCKETS,
    ),
    sweep: LIQUIDITY_CANDIDATES.map((candidate) => {
      const trips = rows.filter((r) => r.liqRatio != null && r.liqRatio <= candidate)
      return { candidate, ...cell(trips.filter((r) => r.collapsed).length, trips.length) }
    }),
  }
}

export function coreSweep(rows: SeparationRow[]): SweepPoint[] {
  return CORE_CANDIDATES.map((candidate) => {
    const trips = rows.filter(
      (r) => r.core >= candidate && r.liquidity >= SEPARATION.coreMinLiquidity,
    )
    return { candidate, ...cell(trips.filter((r) => r.collapsed).length, trips.length) }
  })
}

/**
 * **The clock for a rug verdict: a mint's first *held* minute.**
 *
 * Not `first_seen_at`. Measured 2026-10-02: that column is 100% populated inside
 * `token_mcap_tracking`, but the table covers only ~17% of the scored corpus (1,943 of 2,353 mints
 * absent, because the watch set is a 4-way union), 49 mints read as a *negative* age, and the median
 * lag from first-seen to our first candle is **−18 minutes** — the copier's 501-bar backfill runs
 * ahead of it. Our own series is therefore both the honest clock and the thing the feature block is
 * built from, so the two cannot disagree.
 *
 * A minute counts only when its close is a finite positive number: `NULL` in these arrays means "not
 * observed", never zero, so index 0 is not the answer — the first *valid* minute is.
 */
export function firstHeldMinute(
  hours: Array<{ hour_bucket: string; c_min: number[] | null }>,
): number | null {
  for (const row of hours) {
    const hourMs = Date.parse(row.hour_bucket)
    if (!Number.isFinite(hourMs) || !Array.isArray(row.c_min)) continue
    for (let i = 0; i < row.c_min.length; i++) {
      const c = row.c_min[i]
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
        return Math.floor((hourMs + i * 60_000) / 1000)
      }
    }
  }
  return null
}

/** Minute closes rebuilt from the per-hour `c_min` arrays. */
function expandCloses(rows: Array<{ hour_bucket: string; c_min: number[] | null }>): Array<{ t: number; c: number }> {
  const out: Array<{ t: number; c: number }> = []
  for (const row of rows) {
    const hourMs = Date.parse(row.hour_bucket)
    if (!Number.isFinite(hourMs) || !Array.isArray(row.c_min)) continue
    for (let i = 0; i < row.c_min.length; i++) {
      const c = row.c_min[i]
      if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
        out.push({ t: Math.floor((hourMs + i * 60_000) / 1000), c })
      }
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** The forward label: a ≥60% market-cap drop inside 30 minutes of the evaluation. */
export function labelForward(
  createdAt: string,
  series: Array<{ t: number; c: number }>,
  // Explicitly `number`: `SEPARATION` is `as const`, so a bare default would narrow these to the
  // literals `0.6` / `30` and callers tuning the rule could not pass their own value.
  eventDrop: number = SEPARATION.eventDrop,
  eventWindowMin: number = SEPARATION.eventWindowMin,
): boolean | null {
  const at = Math.floor(Date.parse(createdAt) / 1000)
  if (!Number.isFinite(at)) return null
  const windowSec = eventWindowMin * 60
  let baseline: number | null = null
  let trough: number | null = null
  for (const point of series) {
    if (point.t <= at) baseline = point.c
    else if (point.t <= at + windowSec) trough = trough == null ? point.c : Math.min(trough, point.c)
  }
  if (baseline == null || trough == null || baseline <= 0) return null
  return (baseline - trough) / baseline >= eventDrop
}

export async function loadRugSignalSeparation(days = 4): Promise<SeparationReport> {
  const window = Math.max(1, Math.floor(days))
  const { rows: shadowRows } = await query<{
    token_address: string
    created_at: string
    score: number | null
    decision: string
    bars_scored: number
    breakdown: Record<string, number> | null
    mcap: number | null
    liquidity_usd: number | null
  }>(
    `SELECT token_address, created_at::text AS created_at, score, decision, bars_scored,
            breakdown, mcap, liquidity_usd
       FROM rug_signal_shadow
      WHERE created_at > NOW() - make_interval(days => $1::int)
      ORDER BY created_at ASC`,
    [window],
  )

  const judged = shadowRows.filter((r) => Number(r.bars_scored) >= SEPARATION.minBars)
  const mints = [...new Set(judged.map((r) => r.token_address))]

  const series = new Map<string, Array<{ t: number; c: number }>>()
  if (mints.length > 0) {
    const { rows: minuteRows } = await query<{ token_address: string; hour_bucket: string; c_min: number[] | null }>(
      `SELECT token_address, hour_bucket::text AS hour_bucket, c_min
         FROM token_metrics_history
        WHERE token_address = ANY($1::text[])
          AND hour_bucket > NOW() - make_interval(days => $2::int)
        ORDER BY hour_bucket ASC`,
      [mints, Math.max(window, 2)],
    )
    for (const row of minuteRows) {
      const bucket = series.get(row.token_address) ?? []
      bucket.push(...expandCloses([row]))
      series.set(row.token_address, bucket)
    }
  }

  const labelled: SeparationRow[] = []
  let unlabellable = 0
  for (const row of judged) {
    if (row.score == null) continue
    const collapsed = labelForward(row.created_at, series.get(row.token_address) ?? [])
    if (collapsed == null) {
      unlabellable++
      continue
    }
    const breakdown = row.breakdown ?? {}
    const staircase = Number(breakdown.staircase ?? 0) || 0
    const liquidity = Number(breakdown.liquidity ?? 0) || 0
    const mcap = row.mcap
    const liquidityUsd = row.liquidity_usd
    const liqRatio =
      mcap != null && mcap > 0 && liquidityUsd != null && liquidityUsd >= 0 ? liquidityUsd / mcap : null
    labelled.push({
      mint: row.token_address,
      createdAt: row.created_at,
      day: row.created_at.slice(0, 10),
      score: row.score,
      decision: row.decision,
      staircase,
      liquidity,
      core: staircase + liquidity,
      liqRatio,
      collapsed,
    })
  }

  // The plain-English read is the point of the page: what does the fixture actually show?
  //
  // Two base rates, because there are two populations. The buckets are per **distinct mint**, so
  // comparing them to the per-row base would subtract a correlated sample from an independent one
  // and manufacture a lift — the per-row base is the one that flatters.
  const byMint = dedupeByMint(labelled)
  const collapses = labelled.filter((r) => r.collapsed).length
  const base = cell(collapses, labelled.length)
  const mintCollapses = byMint.filter((r) => r.collapsed).length
  const mintBase = cell(mintCollapses, byMint.length)
  const staircase = staircaseView(byMint)
  const liquidity = liquidityView(byMint)

  const days0 = [...new Set(labelled.map((r) => r.day))].sort()
  const perDay = days0.map((day) => {
    const dayRows = labelled.filter((r) => r.day === day)
    const trips = dayRows.filter((r) => r.staircase >= 25)
    return {
      day,
      rows: dayRows.length,
      collapses: dayRows.filter((r) => r.collapsed).length,
      staircaseTrips: trips.length,
      staircaseCollapses: trips.filter((r) => r.collapsed).length,
    }
  })

  const daysWithFloor = perDay.filter((d) => d.staircaseTrips >= SEPARATION.minPositives)
  // A day is only evidence if that day's own trips beat that day's own base rate — comparing every
  // day to one pooled base rate lets a good day carry a bad one.
  const daysAgreeing = daysWithFloor.filter(
    (d) => d.staircaseCollapses / Math.max(d.staircaseTrips, 1) > d.collapses / Math.max(d.rows, 1),
  )
  const staircaseTrips = cell(
    labelled.filter((r) => r.staircase >= 25 && r.collapsed).length,
    labelled.filter((r) => r.staircase >= 25).length,
  )

  let verdict: SeparationReport['verdict']
  if (labelled.length < SEPARATION.minLabelled || mintBase.rate == null) {
    verdict = {
      state: 'inconclusive',
      text: `${labelled.length} labelled rows against a floor of ${SEPARATION.minLabelled}. Not "no effect"; not yet a result.`,
    }
  } else if (mintCollapses < SEPARATION.minPositives) {
    verdict = { state: 'inconclusive', text: `Only ${mintCollapses} collapses — there is nothing to predict yet.` }
  } else if (!staircaseTrips.conclusive) {
    verdict = {
      state: 'inconclusive',
      text:
        `Staircase ≥ 25 has ${staircaseTrips.n} trips against a floor of ${SEPARATION.minPositives}. ` +
        'Precision is undefined here, NOT zero — the rule has not fired enough times to say anything.',
    }
  } else {
    // Compared against the per-mint base: the trips are counted per row, so the base must be too.
    const lift = (staircaseTrips.rate ?? 0) > mintBase.rate
    const asPct = (v: number) => `${(v * 100).toFixed(1)}%`
    verdict = {
      state: lift ? 'lift' : 'no_lift',
      text: lift
        ? `Staircase ≥ 25 carries signal: ${asPct(staircaseTrips.rate!)} of trips collapse against a ` +
          `${asPct(mintBase.rate)} base rate per distinct mint (${daysAgreeing.length}/${daysWithFloor.length} ` +
          'days with enough trips beat their own base rate).'
        : `No lift: staircase ≥ 25 is ${asPct(staircaseTrips.rate!)} against a ${asPct(mintBase.rate)} ` +
          'base rate per distinct mint.',
    }
  }

  return {
    days: window,
    rows: {
      shadow: shadowRows.length,
      judged: judged.length,
      labelled: labelled.length,
      unlabellable,
      collapses,
      mints: byMint.length,
      baseRate: base.rate,
      baseCi: base.ci,
      mintCollapses,
      mintBaseRate: mintBase.rate,
      mintBaseCi: mintBase.ci,
    },
    staircase: staircase.buckets,
    liquidity: liquidity.buckets,
    staircaseSweep: staircase.sweep,
    liquiditySweep: liquidity.sweep,
    coreSweep: coreSweep(byMint),
    perDay,
    verdict,
  }
}

/** Minutes for one mint, for the chart. Read-only and cached by the caller. */
export async function loadRugSeriesMinutes(
  mint: string,
  days = 2,
): Promise<Array<{ t: number; o: number; h: number; l: number; c: number; v?: number }>> {
  const { rows } = await query<{
    hour_bucket: string
    o_min: number[] | null
    h_min: number[] | null
    l_min: number[] | null
    c_min: number[] | null
    vol_min: number[] | null
  }>(
    `SELECT hour_bucket::text AS hour_bucket, o_min, h_min, l_min, c_min, vol_min
       FROM token_metrics_history
      WHERE token_address = $1 AND hour_bucket > NOW() - make_interval(days => $2::int)
      ORDER BY hour_bucket ASC`,
    [mint, Math.max(1, Math.floor(days))],
  )
  const out: Array<{ t: number; o: number; h: number; l: number; c: number; v?: number }> = []
  for (const row of rows) {
    const hourMs = Date.parse(row.hour_bucket)
    if (!Number.isFinite(hourMs) || !Array.isArray(row.c_min)) continue
    const count = Math.min(
      row.c_min.length,
      row.o_min?.length ?? row.c_min.length,
      row.h_min?.length ?? row.c_min.length,
      row.l_min?.length ?? row.c_min.length,
    )
    for (let i = 0; i < count; i++) {
      const c = row.c_min[i]
      if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue
      const o = typeof row.o_min?.[i] === 'number' ? row.o_min[i] : c
      const h = typeof row.h_min?.[i] === 'number' ? row.h_min[i] : c
      const l = typeof row.l_min?.[i] === 'number' ? row.l_min[i] : c
      const v = typeof row.vol_min?.[i] === 'number' ? row.vol_min[i] : undefined
      out.push({
        t: Math.floor((hourMs + i * 60_000) / 1000),
        o,
        h: Math.max(h, o, c),
        l: Math.min(l, o, c),
        c,
        ...(v != null ? { v } : {}),
      })
    }
  }
  return out
}
