function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export type SoftMlSize = {
  sol: number
  mult: number
}

/**
 * Shrink paper/live size by pBad (and optional indexer-style confidence).
 * Missing pBad → multiplier 1. Floor SOL_ML_SIZE_FLOOR (default 0.25).
 */
export function softMlSize(
  baseSol: number,
  opts: { pBad: number | null; confidence?: number },
): SoftMlSize {
  const floor = envNum('SOL_ML_SIZE_FLOOR', 0.25)
  const base = Number.isFinite(baseSol) && baseSol > 0 ? baseSol : 0
  const pBad =
    opts.pBad != null && Number.isFinite(opts.pBad) ? Math.min(1, Math.max(0, opts.pBad)) : 0
  const confidence =
    opts.confidence != null && Number.isFinite(opts.confidence)
      ? Math.min(1, Math.max(0, opts.confidence))
      : 1
  const rawMult = (1 - pBad) * confidence
  const mult = Math.max(floor, rawMult)
  return { sol: Math.round(base * mult * 1e9) / 1e9, mult: Math.round(mult * 1000) / 1000 }
}

export function stampMlSize(
  features: Record<string, unknown>,
  sized: SoftMlSize,
  extra?: { pBad?: number | null; pWinner?: number | null },
): Record<string, unknown> {
  return {
    ...features,
    ml_size_mult: sized.mult,
    ...(extra?.pBad != null ? { ml_p_bad: extra.pBad } : {}),
    ...(extra?.pWinner != null ? { ml_p_winner: extra.pWinner } : {}),
  }
}
