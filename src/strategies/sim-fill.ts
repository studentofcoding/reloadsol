/**
 * Simulated fills from REAL quotes.
 *
 * A Jupiter v2 order response contains everything a fill needs — the exact in/out amounts, the
 * pool's own price impact, and the fee — so a simulated buy or sell does not have to be modelled at
 * all when a quote is available: `effectivePrice = inAmount / outAmount`, and the rest is the
 * quote's own number. The analytic model stays as the fallback (non-Solana chains, quote failures,
 * and the low-liquidity long tail), and every fill records which one produced it.
 *
 * Budget. Measured with the account key: the endpoint answers ~8 sequential requests then `429`s,
 * and rejects 100% of concurrent requests — the account quota is around 0.5 rps, so the only safe
 * shape is spaced single requests. Volume is not the constraint: ~600 fills over three days is
 * ~0.002 rps. Everything here therefore goes through the shared serial gate and fails soft.
 */
import type { DepthSource, ExecutionParams, Fill } from './execution-model'

/** The shape we read off a Jupiter v2 order/quote response. */
export interface QuoteOrderLike {
  inAmount?: unknown
  outAmount?: unknown
  priceImpactPct?: unknown
  priceImpact?: unknown
}

function positiveNumber(raw: unknown): number | null {
  // Presence first: Number(null) is 0 and Number('') is 0, so coercing a missing field would
  // invent a real-looking amount.
  if (raw === undefined || raw === null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * The quote's price impact as a fraction. The response carries two fields that differ by 100×:
 * `priceImpactPct` is already a fraction (`-0.00018`) and `priceImpact` is a percent (`-0.018`).
 */
export function quoteImpactFraction(order: QuoteOrderLike): number | null {
  const pct = order?.priceImpactPct
  if (pct !== undefined && pct !== null && Number.isFinite(Number(pct))) return Number(pct)
  const percent = order?.priceImpact
  if (percent !== undefined && percent !== null && Number.isFinite(Number(percent))) {
    return Number(percent) / 100
  }
  return null
}

/**
 * Turn a real quote into a Fill. No modelling: the effective price IS the quote's ratio, and the
 * impact is the pool's own reported number. Returns null when the quote is unusable, so callers
 * fall back to the model rather than recording a fabricated fill.
 */
export function fillFromQuote(
  side: 'buy' | 'sell',
  order: QuoteOrderLike,
  params: ExecutionParams,
  depth: { depthQuote: number; depthSource: DepthSource },
): Fill | null {
  const inAmount = positiveNumber(order?.inAmount)
  const outAmount = positiveNumber(order?.outAmount)
  if (inAmount == null || outAmount == null) return null

  const impact = quoteImpactFraction(order)
  const impactBps = impact == null ? 0 : Math.abs(impact) * 10_000
  const feeQuote = (side === 'buy' ? inAmount : outAmount) * (params.feeBps / 10_000)

  if (side === 'buy') {
    // in = quote spent, out = tokens received.
    const effectivePrice = inAmount / outAmount
    return {
      side: 'buy',
      spotPrice: effectivePrice,
      notionalQuote: inAmount,
      effectivePrice,
      impactBps,
      spreadBps: params.spreadBps,
      feeQuote,
      fixedCostQuote: params.priorityFeeQuote,
      depthQuote: depth.depthQuote,
      depthSource: depth.depthSource,
      tokens: outAmount,
      costQuote: inAmount + params.priorityFeeQuote,
      proceedsQuote: 0,
    }
  }

  // in = tokens given up, out = quote received.
  const tokens = inAmount
  const effectivePrice = outAmount / tokens
  return {
    side: 'sell',
    spotPrice: effectivePrice,
    notionalQuote: outAmount,
    effectivePrice,
    impactBps,
    spreadBps: params.spreadBps,
    feeQuote,
    fixedCostQuote: params.priorityFeeQuote,
    depthQuote: depth.depthQuote,
    depthSource: depth.depthSource,
    tokens,
    costQuote: 0,
    proceedsQuote: Math.max(0, outAmount - params.priorityFeeQuote),
  }
}

/** How a fill was produced, recorded beside it so a modelled fill is never read as a real one. */
export type FillSource = 'jupiter' | 'model'

export function fillSourceLabel(source: FillSource): 'jupiter-quote' | 'model' {
  return source === 'jupiter' ? 'jupiter-quote' : 'model'
}
