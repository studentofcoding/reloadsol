function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export type SoftMlSize = {
  sol: number
  mult: number
}

/**
 * Flat since 2026-10-01 — the multiplier no longer sizes.
 *
 * `ml_size_mult` was the closed-loop score `cl_p` used directly as the stake fraction. It was measured
 * twice to have no rank power: within a strategy the two mass tiers are +87.0% (n=73) against +96.6%
 * (n=88) — t ≈ 0.25, i.e. noise — and across strategies the level *inverts* (gmgn_sm_kol at `cl_p` 0.389
 * wins 13.2% while the mcap family at 0.389 wins 55.0%). Applied as a multiplier it cost 1.531 SOL over
 * two days on the dashboard's own rows, and the tilt it inspired was worse still (clustered t = −2.52).
 * So the size path is flat: the base stake, scaled only by the Level 1 market scalar.
 *
 * `SOL_ML_SIZE_ENABLED=1` restores the old behaviour for a soak. The gate that would earn a non-flat
 * multiplier back is `SPEC-sizing-level-2-probabilistic-v1` §4 — rank power with a confidence interval, a
 * per-bin sample floor, cross-strategy comparability, and lift over flat clustered by token. Not a retune.
 */
export function resolveMlSizeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.SOL_ML_SIZE_ENABLED ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/**
 * Scale a base stake by the ML multiplier — flat unless `SOL_ML_SIZE_ENABLED=1`.
 *
 * The legacy form shrinks by pBad (and optional indexer-style confidence); missing pBad → multiplier 1,
 * floored at `SOL_ML_SIZE_FLOOR` (default 0.25).
 */
export function softMlSize(
  baseSol: number,
  opts: { pBad: number | null; confidence?: number },
): SoftMlSize {
  const base = Number.isFinite(baseSol) && baseSol > 0 ? baseSol : 0
  if (!resolveMlSizeEnabled()) return { sol: base, mult: 1 }

  const floor = envNum('SOL_ML_SIZE_FLOOR', 0.25)
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
