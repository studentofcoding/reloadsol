export type SolDlmmConfidence = {
  score: number
  noTrade: boolean
  lagS: number | null
  reasons: string[]
}

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Meteora screen age → 0..1 size/score factor (same shape as rhIndexerConfidence).
 * Lag decays to 0 at SOL_DLMM_MAX_LAG_S (default 15m). A fetch error cuts ×0.9.
 * Below SOL_DLMM_CONFIDENCE_FLOOR (default 0.35) → noTrade.
 */
export function solDlmmConfidence(opts: {
  lastOkAtMs: number | null
  fetchError?: boolean
  nowMs?: number
}): SolDlmmConfidence {
  const maxLag = envNum('SOL_DLMM_MAX_LAG_S', 900)
  const floor = envNum('SOL_DLMM_CONFIDENCE_FLOOR', 0.35)
  const reasons: string[] = []
  if (opts.lastOkAtMs == null || !Number.isFinite(opts.lastOkAtMs)) {
    return { score: 0, noTrade: true, lagS: null, reasons: ['no last-good screen'] }
  }
  const now = opts.nowMs ?? Date.now()
  const lagS = Math.max(0, (now - opts.lastOkAtMs) / 1000)
  let score = Math.max(0, 1 - lagS / maxLag)
  if (lagS > maxLag) reasons.push(`lag ${Math.round(lagS)}s > ${maxLag}s`)
  if (opts.fetchError) {
    score *= 0.9
    reasons.push('meteora fetch error')
  }
  score = Math.round(Math.min(1, score) * 1000) / 1000
  return { score, noTrade: score < floor, lagS, reasons }
}

export function applySolDlmmConfidence<T extends { score: number }>(
  candidates: T[],
  confidence: number,
): Array<T & { confidence: number }> {
  const c = Math.max(0, Math.min(1, confidence))
  return candidates.map((row) => ({
    ...row,
    score: Math.round(row.score * c * 10) / 10,
    confidence: c,
  }))
}
