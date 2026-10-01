/**
 * Raptor hop policy — pair-aware, not a single global ceiling.
 *
 * Measured 2026-10-01 on prod: at `maxHops=1` a **token→token** quote fails outright —
 * `500 "Failed to get quote: No direct route found and maxHops=1"` — because two memecoins rarely share
 * a pool. At `maxHops=2` or `3` the same pair quotes fine. A route that touches a deep, verified mint
 * (SOL / USDC / USDT) does have a direct pool, so 1 hop is correct and cheaper there.
 *
 * That is why this is not one env value. Raising `RAPTOR_MAX_HOPS` globally would silently widen the
 * hop search on every SOL/USDC/USDT route — the thing `1` was deliberately protecting — while leaving
 * token→token broken whenever a caller forgot to override it. The policy belongs with the pair.
 *
 * The failure was not cosmetic: Raptor 500s, the surface escalates to the Jupiter picker, and those
 * escalations spent the 0.5 rps keyed budget until the *prepare* was rate-limited too, which then fell
 * back to a Lite lane that is per-IP banned on this host. One wrong hop count, a 429 cascade.
 */
import { TOKENS } from '@/utils/solana'

/** Mints with deep direct liquidity: a leg through one of these routes at a single hop. */
export const RAPTOR_VERIFIED_QUOTE_MINTS: ReadonlySet<string> = new Set([
  TOKENS.SOL,
  TOKENS.USDC,
  TOKENS.USDT,
])

export const RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT = 3

/** Hops for a token→token pair. Env-tunable; 1 restores the old behaviour exactly. */
export function getRaptorTokenTokenHops(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number.parseInt(env.RAPTOR_TOKEN_TOKEN_HOPS ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT
}

export function isVerifiedQuoteMint(mint: string): boolean {
  return RAPTOR_VERIFIED_QUOTE_MINTS.has(mint)
}

/**
 * Hops to ask Raptor for, given the pair. An explicit caller override always wins.
 *
 * - either side a verified mint → `RAPTOR_MAX_HOPS` (the existing value; 1 by default)
 * - token→token (neither side verified) → `RAPTOR_TOKEN_TOKEN_HOPS` (3 by default)
 */
export function resolveRaptorHops(
  inputMint: string,
  outputMint: string,
  options?: { requested?: number | null; env?: Record<string, string | undefined> },
): number {
  if (typeof options?.requested === 'number' && Number.isFinite(options.requested) && options.requested >= 1) {
    return Math.floor(options.requested)
  }
  const env = options?.env ?? process.env
  const base = Number(env.RAPTOR_MAX_HOPS)
  const verifiedHops = Number.isFinite(base) && base >= 1 ? Math.floor(base) : 1

  if (isVerifiedQuoteMint(inputMint) || isVerifiedQuoteMint(outputMint)) {
    return verifiedHops
  }
  return Math.max(verifiedHops, getRaptorTokenTokenHops(env))
}
