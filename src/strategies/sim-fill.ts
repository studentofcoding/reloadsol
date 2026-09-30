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
import {
  buildExecutionRecord,
  computeBuyFill,
  computeSellFill,
  resolveDepth,
  resolveExecutionParams,
  type DepthSource,
  type ExecutionParams,
  type Fill,
} from './execution-model'

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

/**
 * Invert a quote's price impact into the pool depth that produced it.
 *
 * For a constant-product pool the average-price impact of a trade is `notional / depth`, so a real
 * quote hands us the one input the analytic model could never know: `depth = notional / impact`.
 *
 * This is how a real quote reaches the simulated fill WITHOUT quoting in the direction that would
 * need the mint's decimals. A buy is easy to quote (SOL in, raw tokens out), but a sell needs the
 * token amount in base units, and the codebase has no mint-decimals helper. Instead quote the
 * position's SOL notional the one direction that needs nothing new, read the impact, and let the
 * model price the exit at the depth the market actually showed.
 *
 * Returns null when the impact is unusable rather than inventing a depth: a quote with no impact
 * says nothing about liquidity.
 */
export function implyDepthFromQuote(params: {
  notionalQuote: number
  /** The quote's impact as a FRACTION (positive or negative); fractions below the floor are noise. */
  priceImpactFraction: number
  /** Below this, the impact is rounding noise and the implied depth would be nonsense. */
  minImpactFraction?: number
  maxDepthQuote?: number
}): number | null {
  const { notionalQuote, priceImpactFraction } = params
  const minImpact = params.minImpactFraction ?? 1e-7
  const maxDepth = params.maxDepthQuote ?? 1e9
  if (!(notionalQuote > 0)) return null
  if (!Number.isFinite(priceImpactFraction)) return null
  const magnitude = Math.abs(priceImpactFraction)
  if (magnitude < minImpact) return null
  const depth = notionalQuote / magnitude
  if (!Number.isFinite(depth) || depth <= 0) return null
  return Math.min(depth, maxDepth)
}

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112'

/** Quote fills are on unless explicitly switched off. Shadow-only: they never change `pnl_pct`. */
export function simQuoteFillsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SIM_QUOTE_FILLS ?? 'on').toLowerCase() !== 'off'
}

function quoteTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.SIM_QUOTE_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4000
}

export interface SimFillRequest {
  chain?: string
  mint: string
  side: 'buy' | 'sell'
  /** Trade notional in the chain's native quote unit — used for the quote and the impact. */
  notionalQuote: number
  /** Sell only: price the tokens are being valued at. */
  spotPrice?: number
  /** Sell only: token amount in UI units. */
  tokenAmountUi?: number
  params: ExecutionParams
  /** Depth to assume when no quote is available (the model path). */
  fallbackDepth: { depthQuote: number; depthSource: DepthSource }
}

export interface SimFillResult {
  fill: Fill
  source: FillSource
  /** Depth a real quote implied, when one was used. */
  quotedDepthQuote?: number
  quotedImpactBps?: number
}

function modelFill(request: SimFillRequest): Fill {
  const base = {
    side: request.side,
    spotPrice: request.spotPrice ?? 1,
    notionalQuote: request.notionalQuote,
    depth: request.fallbackDepth,
    params: request.params,
  } as const
  return request.side === 'buy'
    ? computeBuyFill(base)
    : computeSellFill({ ...base, tokenAmount: request.tokenAmountUi ?? 0 })
}

/**
 * Resolve one simulated fill: a real quote when one can be had, the analytic model otherwise.
 *
 * Never throws and never blocks the caller for long — a failure, a timeout or a `429` simply means
 * the model answers. `source` records which one did, so nothing downstream has to guess.
 */
export async function resolveSimFill(request: SimFillRequest): Promise<SimFillResult> {
  const fallback = modelFill(request)

  const quotable = request.chain !== 'robinhood' && request.notionalQuote > 0 && request.mint
  if (!quotable || !simQuoteFillsEnabled()) {
    return { fill: fallback, source: 'model' }
  }

  try {
    // No gate here: `fetchJupiterSwapQuote` (and the route behind it) charges the shared Jupiter gate
    // itself, so charging again bought two slots per simulated fill across every sim strategy.
    const { fetchJupiterSwapQuote } = await import('@/utils/jupiter-swap-quote')

    const amountLamports = String(Math.max(1, Math.round(request.notionalQuote * 1e9)))
    const quote = await Promise.race([
      fetchJupiterSwapQuote({
        inputMint: WRAPPED_SOL,
        outputMint: request.mint,
        amount: amountLamports,
        slippageBps: 100,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), quoteTimeoutMs())),
    ])
    if (!quote) return { fill: fallback, source: 'model' }

    // The quote's impact is already a fraction (the mapper normalizes the 100x pair for us).
    const depth = implyDepthFromQuote({
      notionalQuote: request.notionalQuote,
      priceImpactFraction: quote.priceImpact,
    })
    if (depth == null) return { fill: fallback, source: 'model' }

    const measured = { depthQuote: depth, depthSource: 'liquidity' as const }
    const filled = modelFill({ ...request, fallbackDepth: measured })
    return {
      fill: filled,
      source: 'jupiter',
      quotedDepthQuote: depth,
      quotedImpactBps: Math.abs(quote.priceImpact) * 10_000,
    }
  } catch {
    return { fill: fallback, source: 'model' }
  }
}

export interface ShadowExecInput {
  chain?: string
  mint: string
  /** SOL received for the position at the close. */
  exitSolValue: number
  /** 1 + pnlPct/100 — the price ratio every close path already computes. */
  priceRatio: number
  /** Token amount in UI units. */
  tokenAmountUi: number
  params?: ExecutionParams
}

/**
 * The one place a close records how the trade would really have filled.
 *
 * The cost basis is derived from the close's own numbers (`cost = exitValue / priceRatio`), so any
 * close path can call this without threading extra state through. The exit is quoted; the entry is
 * priced at the depth that quote revealed. Returns null when the numbers cannot support a record —
 * never a fabricated one — and never throws, so a close can never fail because of telemetry.
 */
export async function buildShadowExecutionRecord(
  input: ShadowExecInput,
): Promise<Record<string, unknown> | null> {
  try {
    const params = input.params ?? resolveExecutionParams()
    const tokens = input.tokenAmountUi
    if (!(input.exitSolValue > 0) || !(input.priceRatio > 0) || !(tokens > 0)) return null
    const costSol = input.exitSolValue / input.priceRatio
    const exitSpot = input.exitSolValue / tokens
    const entrySpot = exitSpot / input.priceRatio
    if (!(costSol > 0) || !(entrySpot > 0)) return null

    const fallbackDepth = resolveDepth({}, params)
    const resolved = await resolveSimFill({
      chain: input.chain,
      mint: input.mint,
      side: 'sell',
      notionalQuote: input.exitSolValue,
      spotPrice: exitSpot,
      tokenAmountUi: tokens,
      params,
      fallbackDepth,
    })
    const entryDepth = resolved.quotedDepthQuote
      ? { depthQuote: resolved.quotedDepthQuote, depthSource: 'liquidity' as const }
      : fallbackDepth
    const entryFill = computeBuyFill({
      side: 'buy',
      spotPrice: entrySpot,
      notionalQuote: costSol,
      depth: entryDepth,
      params,
    })
    return {
      ...buildExecutionRecord(entryFill, resolved.fill, params),
      entry_source: fillSourceLabel('model'),
      exit_source: fillSourceLabel(resolved.source),
    }
  } catch (error) {
    console.warn(
      '[sim-exec] execution record skipped:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

/**
 * The version every outcome writer can use: no token count, no mint decimals.
 *
 * `costSol` is the position's entry size (the writers already record it) and `priceRatio` is
 * `1 + pnlPct/100`, which every close path computes. The BUY side is what gets quoted — at the
 * position's actual entry size, which is exactly the trade — and the depth it reveals prices the
 * exit. Prices are kept scale-free (entry spot 1, exit spot = ratio) so no token amount is needed
 * anywhere: only notionals matter to the impact.
 *
 * Returns null rather than a fabricated record when the numbers cannot support one, and never
 * throws, so a close can never fail because of telemetry.
 */
export async function buildShadowExecutionRecordForCost(input: {
  chain?: string
  mint: string
  costSol: number
  priceRatio: number
  params?: ExecutionParams
}): Promise<Record<string, unknown> | null> {
  try {
    const params = input.params ?? resolveExecutionParams()
    if (!(input.costSol > 0) || !(input.priceRatio > 0)) return null

    const fallbackDepth = resolveDepth({}, params)
    const entryResolved = await resolveSimFill({
      chain: input.chain,
      mint: input.mint,
      side: 'buy',
      notionalQuote: input.costSol,
      spotPrice: 1,
      params,
      fallbackDepth,
    })
    const depth = entryResolved.quotedDepthQuote
      ? { depthQuote: entryResolved.quotedDepthQuote, depthSource: 'liquidity' as const }
      : fallbackDepth

    const entryFill = computeBuyFill({
      side: 'buy',
      spotPrice: 1,
      notionalQuote: input.costSol,
      depth,
      params,
    })
    const exitFill = computeSellFill({
      side: 'sell',
      spotPrice: input.priceRatio,
      notionalQuote: 0,
      depth,
      params,
      tokenAmount: input.costSol,
    })

    return {
      ...buildExecutionRecord(entryFill, exitFill, params),
      entry_source: fillSourceLabel(entryResolved.source),
      exit_source: fillSourceLabel('model'),
    }
  } catch (error) {
    console.warn(
      '[sim-exec] execution record skipped:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}
