/**
 * Does strategy agreement predict the outcome?
 *
 * The Reports overlap table showed "median PnL rises with breadth", but breadth was
 * raw `count(DISTINCT strategy_id)` and three of the "agreeing" strategies were grid
 * neighbours (see src/strategies/strategy-family.ts). This module answers the question
 * honestly: breadth is counted in independent *families*, and every claim carries a
 * confidence interval plus an explicit `inconclusive` state when there is not enough
 * data to say anything.
 *
 * Statistical choices:
 * - Unit is a TOKEN, not a trade: breadth is a token property, and counting trades
 *   would weight a token by how many strategies happened to enter it.
 * - A token's value is the MEDIAN of its trades' pnl_pct, and the bucket statistic is
 *   the median of those token values. The distribution is right-tailed (att_rh:
 *   mean +83 % vs median -39 % on first entries), so a mean would report the tail.
 * - CIs are bootstrap percentile intervals on the median (10k resamples, seeded PRNG so
 *   a report is reproducible) and a Wilson interval for the win rate, which is correct
 *   at small n unlike the normal approximation.
 * - Nothing here is a gate. `significant` is deliberately conservative: it is false
 *   when the CI straddles 0 or either side is under the token floor.
 */

export type ConsensusTokenInput = {
  /** Independent families that entered this token (see resolveStrategyFamily). */
  families: string[]
  /** Every trade's pnl_pct for this token. */
  pnls: number[]
}

export type ConsensusBucket = {
  /** Capped at 3, so 3 means "3 or more". */
  family_count: number
  label: string
  tokens: number
  trades: number
  median_pnl_pct: number | null
  mean_pnl_pct: number | null
  /** Share of tokens whose own median pnl is positive. Wilson CI is over this. */
  win_rate: number | null
  median_ci: [number, number] | null
  win_rate_ci: [number, number] | null
}

export type ConsensusLift = {
  vs: string
  delta_median_pct: number | null
  delta_ci: [number, number] | null
  significant: boolean
  inconclusive: boolean
  reason: string
}

export type ConsensusTestResult = {
  buckets: ConsensusBucket[]
  lifts: ConsensusLift[]
  min_tokens_per_bucket: number
  samples: number
  seed: number
}

export const DEFAULT_SAMPLES = 10_000
export const DEFAULT_SEED = 0x5eed
export const DEFAULT_MIN_TOKENS_PER_BUCKET = 30
const Z_95 = 1.959963984540054

/** mulberry32 — small, fast, and deterministic per call (request-safe). */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

/**
 * Percentile bootstrap CI for the median. Resamples are drawn with replacement from
 * `values`; `alpha` 0.05 gives a 95 % interval.
 */
export function bootstrapMedianCI(
  values: readonly number[],
  opts: { samples?: number; alpha?: number; rng?: () => number } = {},
): [number, number] | null {
  if (values.length === 0) return null
  const samples = opts.samples ?? DEFAULT_SAMPLES
  const alpha = opts.alpha ?? 0.05
  const rng = opts.rng ?? makeRng(DEFAULT_SEED)
  const n = values.length
  const medians: number[] = new Array(samples)
  const draw: number[] = new Array(n)
  for (let s = 0; s < samples; s++) {
    for (let i = 0; i < n; i++) draw[i] = values[Math.floor(rng() * n)]!
    medians[s] = median(draw)!
  }
  medians.sort((a, b) => a - b)
  return [percentile(medians, alpha / 2), percentile(medians, 1 - alpha / 2)]
}

/** Bootstrap CI for the difference median(b) - median(a), resampling each side. */
export function bootstrapMedianDiffCI(
  a: readonly number[],
  b: readonly number[],
  opts: { samples?: number; alpha?: number; rng?: () => number } = {},
): [number, number] | null {
  if (a.length === 0 || b.length === 0) return null
  const samples = opts.samples ?? DEFAULT_SAMPLES
  const alpha = opts.alpha ?? 0.05
  const rng = opts.rng ?? makeRng(DEFAULT_SEED)
  const deltas: number[] = new Array(samples)
  const drawA: number[] = new Array(a.length)
  const drawB: number[] = new Array(b.length)
  for (let s = 0; s < samples; s++) {
    for (let i = 0; i < a.length; i++) drawA[i] = a[Math.floor(rng() * a.length)]!
    for (let i = 0; i < b.length; i++) drawB[i] = b[Math.floor(rng() * b.length)]!
    deltas[s] = median(drawB)! - median(drawA)!
  }
  deltas.sort((x, y) => x - y)
  return [percentile(deltas, alpha / 2), percentile(deltas, 1 - alpha / 2)]
}

/** Wilson score interval for a binomial proportion (correct at small n). */
export function wilsonCI(
  successes: number,
  n: number,
  z = Z_95,
): [number, number] | null {
  if (n <= 0) return null
  const p = successes / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const margin =
    (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

function bucketOf(familyCount: number): number {
  return Math.min(3, Math.max(1, familyCount))
}

function bucketLabel(familyCount: number): string {
  return familyCount >= 3 ? '3+' : String(familyCount)
}

export function runConsensusTest(
  tokens: readonly ConsensusTokenInput[],
  opts: { samples?: number; seed?: number; minTokensPerBucket?: number } = {},
): ConsensusTestResult {
  const samples = opts.samples ?? DEFAULT_SAMPLES
  const seed = opts.seed ?? DEFAULT_SEED
  const minTokensPerBucket =
    opts.minTokensPerBucket ?? DEFAULT_MIN_TOKENS_PER_BUCKET

  const byBucket = new Map<number, number[]>()
  const tradesByBucket = new Map<number, number>()
  for (const token of tokens) {
    const pnls = token.pnls.filter((p) => Number.isFinite(p))
    if (pnls.length === 0) continue
    const count = bucketOf(new Set(token.families).size)
    const value = median(pnls)!
    const list = byBucket.get(count)
    if (list) list.push(value)
    else byBucket.set(count, [value])
    tradesByBucket.set(count, (tradesByBucket.get(count) ?? 0) + pnls.length)
  }

  const buckets: ConsensusBucket[] = []
  for (const count of [...byBucket.keys()].sort((a, b) => a - b)) {
    const values = byBucket.get(count)!
    const wins = values.filter((v) => v > 0).length
    buckets.push({
      family_count: count,
      label: bucketLabel(count),
      tokens: values.length,
      trades: tradesByBucket.get(count) ?? 0,
      median_pnl_pct: median(values),
      mean_pnl_pct: values.reduce((a, b) => a + b, 0) / values.length,
      win_rate: wins / values.length,
      median_ci: bootstrapMedianCI(values, { samples, rng: makeRng(seed + count) }),
      win_rate_ci: wilsonCI(wins, values.length),
    })
  }

  const single = buckets.find((b) => b.family_count === 1)
  const singleValues = single ? byBucket.get(1)! : []
  const lifts: ConsensusLift[] = []

  for (const bucket of buckets) {
    if (bucket.family_count === 1) continue
    const values = byBucket.get(bucket.family_count)!
    const delta =
      single && bucket.median_pnl_pct != null && single.median_pnl_pct != null
        ? bucket.median_pnl_pct - single.median_pnl_pct
        : null

    if (!single || singleValues.length === 0) {
      lifts.push({
        vs: '1',
        delta_median_pct: null,
        delta_ci: null,
        significant: false,
        inconclusive: true,
        reason: 'no single-family bucket to compare against',
      })
      continue
    }

    const thin = singleValues.length < minTokensPerBucket || values.length < minTokensPerBucket
    const ci = bootstrapMedianDiffCI(singleValues, values, {
      samples,
      rng: makeRng(seed + 1000 + bucket.family_count),
    })
    const excludesZero = ci != null && (ci[0]! > 0 || ci[1]! < 0)
    const significant = !thin && excludesZero

    lifts.push({
      vs: '1',
      delta_median_pct: delta,
      delta_ci: ci,
      significant,
      inconclusive: !significant,
      reason: thin
        ? `thin sample (${values.length} vs ${singleValues.length} tokens, floor ${minTokensPerBucket})`
        : excludesZero
          ? 'CI excludes 0'
          : 'CI straddles 0',
    })
  }

  return {
    buckets,
    lifts,
    min_tokens_per_bucket: minTokensPerBucket,
    samples,
    seed,
  }
}
