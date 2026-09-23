import { rawImpactToPct } from "@/utils/auto-slippage";
import type { SwapQuote } from "@/types";

/** Quote providers. Desk uses Jupiter V2, then Lite; arb prepare stays on Raptor. */
export type SwapQuoteProvider = "raptor" | "jupiter_lite" | "jupiter_swap";

/** Default absolute price-impact ceiling (percent). Override with `SWAP_QUOTE_MAX_IMPACT_PCT`. */
export const SWAP_QUOTE_DEFAULT_MAX_IMPACT_PCT = 15;

const PROVIDER_TIE_RANK: Record<SwapQuoteProvider, number> = {
  raptor: 0,
  jupiter_lite: 1,
  jupiter_swap: 2,
};

export type SwapQuoteCandidate = {
  provider: SwapQuoteProvider;
  /** Smallest-unit integer string; same input amount across candidates. */
  outAmount: string;
  /** Absolute impact on a 0–100 percent scale. */
  impactPct: number;
  quote: SwapQuote;
};

export function getSwapQuoteMaxImpactPct(): number {
  const raw = process.env.SWAP_QUOTE_MAX_IMPACT_PCT?.trim();
  if (!raw) return SWAP_QUOTE_DEFAULT_MAX_IMPACT_PCT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SWAP_QUOTE_DEFAULT_MAX_IMPACT_PCT;
}

/** Normalize provider impact (fraction or percent) to absolute percent. */
export function impactToAbsPct(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return rawImpactToPct(raw);
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n)) return rawImpactToPct(n);
  }
  return 0;
}

export function passesImpactGate(
  impactPct: number,
  maxImpactPct: number = getSwapQuoteMaxImpactPct(),
): boolean {
  return Number.isFinite(impactPct) && Math.abs(impactPct) <= maxImpactPct;
}

function outAmountBigInt(outAmount: string): bigint | null {
  if (!/^\d+$/.test(outAmount)) return null;
  try {
    const n = BigInt(outAmount);
    return n > BigInt(0) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Winner among gated routes: higher `outAmount`, then lower abs impact,
 * then prefer Raptor if still tied (Lite before Swap).
 */
export function pickBestSwapQuote(
  candidates: SwapQuoteCandidate[],
  maxImpactPct: number = getSwapQuoteMaxImpactPct(),
): SwapQuoteCandidate | null {
  const gated = candidates.filter((c) => {
    if (outAmountBigInt(c.outAmount) == null) return false;
    return passesImpactGate(c.impactPct, maxImpactPct);
  });
  if (gated.length === 0) return null;

  gated.sort((a, b) => {
    const outA = outAmountBigInt(a.outAmount)!;
    const outB = outAmountBigInt(b.outAmount)!;
    if (outA !== outB) return outA > outB ? -1 : 1;

    const impactCmp = Math.abs(a.impactPct) - Math.abs(b.impactPct);
    if (impactCmp !== 0) return impactCmp;

    return PROVIDER_TIE_RANK[a.provider] - PROVIDER_TIE_RANK[b.provider];
  });

  return gated[0] ?? null;
}
