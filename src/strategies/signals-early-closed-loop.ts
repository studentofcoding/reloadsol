/**
 * Attach closed-loop mlScore onto Stage-1 Early Enter candidates.
 * Reuses loadCombinedScore / scoreClosedLoopFromCombined — same path as
 * GET /api/strategies/ml/score and catch-train badges. Fail-soft per mint.
 */
import { isMlClosedLoopEnabled } from '@/strategies/closed-loop-ml'
import { loadCombinedScore } from '@/strategies/combined-score-load'
import type { CombinedScoreChain } from '@/strategies/combined-score'
import { NOUL_GROWTH_ARM_CUT } from '@/strategies/early-enter-noul-shadow'
import { computeEntryMcapBand } from '@/strategies/outcome-features'
import { shouldEmitSignalsEarlyAlert } from '@/strategies/signals-early-alerts'
import type { ScoredSignal } from '@/strategies/signals-pipeline'

export const EARLY_ENTER_CL_CONCURRENCY = 4
export const EARLY_ENTER_CL_HOURS = 24

/**
 * Probability spread below this, across two or more entry-mcap bands or
 * milestone arms, is the same decorative constant (production range was 0.006).
 */
export const DECORATIVE_CL_SCORE_RANGE = 0.02

export type ClosedLoopScoreLoader = typeof loadCombinedScore

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  }
  const n = Math.min(concurrency, items.length)
  if (n === 0) return results
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

/**
 * True when finite scores ignore entry-mcap band and the at_80 arm.
 * Callers should drop those scores to null so shadow rows are skipped_null.
 */
export function isDecorativeClosedLoopBatch(
  rows: Array<{
    mlScore: number | null | undefined
    entryMcap: number | null | undefined
    milestone80?: boolean
  }>,
): boolean {
  const finite = rows.filter(
    (row): row is {
      mlScore: number
      entryMcap: number | null | undefined
      milestone80?: boolean
    } => row.mlScore != null && Number.isFinite(row.mlScore),
  )
  if (finite.length < 2) return false
  let min = Infinity
  let max = -Infinity
  const bands = new Set<string>()
  const arms = new Set<string>()
  for (const row of finite) {
    min = Math.min(min, row.mlScore)
    max = Math.max(max, row.mlScore)
    const band = computeEntryMcapBand(
      typeof row.entryMcap === 'number' ? row.entryMcap : null,
    )
    if (band) bands.add(band)
    if (row.milestone80 != null) arms.add(row.milestone80 ? 'at_80' : 'first_seen')
  }
  if (max - min >= DECORATIVE_CL_SCORE_RANGE) return false
  return bands.size >= 2 || arms.size >= 2
}

async function scoreOneMint(
  signal: ScoredSignal,
  chain: CombinedScoreChain,
  loadScore: ClosedLoopScoreLoader,
): Promise<{ mlScore: number | null; modelVersion: string | null }> {
  try {
    const growth = signal.mcap_growth_percent ?? 0
    const payload = await loadScore({
      address: signal.token_address,
      chain,
      hours: EARLY_ENTER_CL_HOURS,
      entryMcap: signal.current_mcap,
      milestone80: growth >= NOUL_GROWTH_ARM_CUT,
    })
    const mlScore =
      payload.mlScore != null && Number.isFinite(payload.mlScore)
        ? payload.mlScore
        : null
    const modelVersion =
      typeof payload.modelVersion === 'string' && payload.modelVersion.length > 0
        ? payload.modelVersion
        : null
    return { mlScore, modelVersion }
  } catch {
    return { mlScore: null, modelVersion: null }
  }
}

/**
 * Score Stage-1-eligible signals with closed-loop mlScore.
 * Non-candidates are left unchanged. Missing model / flag off / infer throw → null.
 */
export async function attachClosedLoopScoresToSignals(
  signals: ScoredSignal[],
  opts?: {
    chain?: CombinedScoreChain
    concurrency?: number
    loadCombinedScore?: ClosedLoopScoreLoader
    closedLoopEnabled?: boolean
  },
): Promise<ScoredSignal[]> {
  const chain = opts?.chain ?? 'sol'
  const concurrency = opts?.concurrency ?? EARLY_ENTER_CL_CONCURRENCY
  const loadScore = opts?.loadCombinedScore ?? loadCombinedScore
  const enabled = opts?.closedLoopEnabled ?? isMlClosedLoopEnabled()

  const candidateIdx: number[] = []
  signals.forEach((signal, idx) => {
    if (shouldEmitSignalsEarlyAlert(signal)) candidateIdx.push(idx)
  })
  if (candidateIdx.length === 0) return signals

  if (!enabled) {
    return signals.map((signal, idx) => {
      if (!candidateIdx.includes(idx)) return signal
      return {
        ...signal,
        ml_closed_loop_score: null,
        ml_closed_loop_version: null,
      }
    })
  }

  const scored = await mapPool(candidateIdx, concurrency, async (idx) => {
    const signal = signals[idx]
    return scoreOneMint(signal, chain, loadScore)
  })

  const byIdx = new Map<number, { mlScore: number | null; modelVersion: string | null }>()
  candidateIdx.forEach((idx, i) => {
    byIdx.set(idx, scored[i] ?? { mlScore: null, modelVersion: null })
  })

  const decorated = isDecorativeClosedLoopBatch(
    candidateIdx.map((idx) => {
      const signal = signals[idx]
      const cl = byIdx.get(idx)
      const growth = signal.mcap_growth_percent ?? 0
      return {
        mlScore: cl?.mlScore ?? null,
        entryMcap: signal.current_mcap,
        milestone80: growth >= NOUL_GROWTH_ARM_CUT,
      }
    }),
  )

  return signals.map((signal, idx) => {
    const cl = byIdx.get(idx)
    if (!cl) return signal
    return {
      ...signal,
      ml_closed_loop_score: decorated ? null : cl.mlScore,
      ml_closed_loop_version: cl.modelVersion,
    }
  })
}
