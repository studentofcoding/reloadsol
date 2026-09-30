/**
 * Standardized execution model for the paper strategies.
 *
 * The sims used to fill at spot on both sides, so a round trip at an unchanged price reported 0%.
 * Real fills do not: a constant-product pool charges pool impact, the DEX charges its fee, and both
 * directions cost a fixed priority/tip. Short-hold, high-turnover strategies pay that round trip
 * repeatedly, which is exactly what a spot-fill assumption hides.
 *
 * v1 formulas (see docs/specs/SPEC-sim-execution-model-v1.md):
 *
 *   impact      = coeff × (notional / depth) ^ exponent     # 1,1 = exact CPMM average-price impact
 *   buy  price  = spot × (1 + impact + spread)
 *   sell price  = spot × (1 − impact − spread)
 *   fee         = bps/1e4 of the quote side
 *   fixed cost  = priority fee + tip, per side
 *
 * Everything is a pure function of its inputs, so every stored fill is reproducible and a row's PnL
 * can be recomputed from what was written down.
 */

export const EXECUTION_MODEL_VERSION = 'exec-v1'

export interface ExecutionParams {
  /** DEX/LP fee per side, basis points. */
  feeBps: number
  /** Spread + latency allowance per side, basis points. No order book here, so this is a policy knob. */
  spreadBps: number
  /** Fixed per-side cost in the chain's native quote unit (priority fee + tip). */
  priorityFeeQuote: number
  impactCoeff: number
  impactExponent: number
  /** Depth used when the snapshot knows nothing; flagged as `assumed` in the fill. */
  assumedDepthQuote: number
  /** A trade can never consume the whole pool. */
  maxImpactFraction: number
  enabled: boolean
}

function num(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function resolveExecutionParams(env: Record<string, string | undefined> = process.env): ExecutionParams {
  return {
    feeBps: num(env.SIM_FEE_BPS, 100),
    spreadBps: num(env.SIM_SPREAD_BPS, 50),
    // The tip we actually pay, not a round number: the app sends 30,000 lamports (0.00003 SOL) per
    // transaction, and the chain's recent ask is ~0 — `getRecentPrioritizationFees` returned 0
    // micro-lamports/CU for 150 recent slots, both globally and for transactions touching the Jupiter
    // program. Modelling 0.002 charged a fabricated 2,000,000 lamports per side, which by itself
    // produced the entire modelled drag on the 14-day ledger (-61.78 SOL against +0.33 gross).
    // Raise this if we raise the send fee, or when congestion returns.
    priorityFeeQuote: num(env.SIM_PRIORITY_FEE_QUOTE, 0.00003),
    impactCoeff: num(env.SIM_IMPACT_COEFF, 1),
    impactExponent: num(env.SIM_IMPACT_EXPONENT, 1) || 1,
    assumedDepthQuote: num(env.SIM_ASSUMED_DEPTH_QUOTE, 30),
    maxImpactFraction: 0.95,
    enabled: (env.SIM_EXECUTION_MODEL ?? 'on').toLowerCase() !== 'off',
  }
}

export type DepthSource = 'liquidity' | 'volume_proxy' | 'assumed'

export interface DepthInput {
  /** Pool quote-side liquidity from the token snapshot, when the source provides it. */
  liquidityQuote?: number | null
  /** 24h quote volume, used only as a labelled stand-in. */
  volume24hQuote?: number | null
}

/**
 * Depth preference: measured liquidity, then a labelled volume proxy, then the assumed floor.
 * The source travels with the fill so an assumed depth can never be mistaken for a measured one.
 */
export function resolveDepth(
  input: DepthInput,
  params: ExecutionParams,
): { depthQuote: number; depthSource: DepthSource } {
  const liquidity = Number(input.liquidityQuote)
  if (Number.isFinite(liquidity) && liquidity > 0) {
    return { depthQuote: liquidity, depthSource: 'liquidity' }
  }
  const volume = Number(input.volume24hQuote)
  if (Number.isFinite(volume) && volume > 0) {
    // A day's volume spread over a day is a rough stand-in for resting depth — labelled as such.
    return { depthQuote: volume / 24, depthSource: 'volume_proxy' }
  }
  return { depthQuote: params.assumedDepthQuote, depthSource: 'assumed' }
}

export interface FillInput {
  side: 'buy' | 'sell'
  /** Spot price of the token in the chain's native quote unit. */
  spotPrice: number
  /** Trade size in the quote unit. For a sell, pass the notional of the tokens being sold. */
  notionalQuote: number
  depth: { depthQuote: number; depthSource: DepthSource }
  params: ExecutionParams
  /** Token amount, required for a sell so the proceeds can be computed. */
  tokenAmount?: number
}

export interface Fill {
  side: 'buy' | 'sell'
  spotPrice: number
  notionalQuote: number
  effectivePrice: number
  impactBps: number
  spreadBps: number
  feeQuote: number
  fixedCostQuote: number
  depthQuote: number
  depthSource: DepthSource
  /** buy: tokens received. sell: tokens sold. */
  tokens: number
  /** buy: quote paid including the fixed cost. */
  costQuote: number
  /** sell: quote received, net of fee and fixed cost. */
  proceedsQuote: number
}

function impactFraction(notionalQuote: number, depthQuote: number, params: ExecutionParams): number {
  if (!(notionalQuote > 0) || !(depthQuote > 0)) return 0
  const raw = params.impactCoeff * (notionalQuote / depthQuote) ** params.impactExponent
  if (!Number.isFinite(raw) || raw <= 0) return 0
  return Math.min(raw, params.maxImpactFraction)
}

/**
 * Buy: pay `notional`, receive tokens at the impacted price less fee.
 * Returns a fully zeroed fill (never NaN) for degenerate input.
 */
export function computeBuyFill(input: FillInput): Fill {
  const { spotPrice, notionalQuote, params } = input
  const depth = input.depth
  const base: Fill = {
    side: 'buy',
    spotPrice,
    notionalQuote,
    effectivePrice: 0,
    impactBps: 0,
    spreadBps: params.spreadBps,
    feeQuote: 0,
    fixedCostQuote: params.priorityFeeQuote,
    depthQuote: depth.depthQuote,
    depthSource: depth.depthSource,
    tokens: 0,
    costQuote: 0,
    proceedsQuote: 0,
  }
  if (!(spotPrice > 0) || !(notionalQuote > 0)) return base

  const impact = impactFraction(notionalQuote, depth.depthQuote, params)
  const spread = params.spreadBps / 10_000
  const fee = params.feeBps / 10_000
  const effectivePrice = spotPrice * (1 + impact + spread)
  const tokens = (notionalQuote * (1 - fee)) / effectivePrice

  return {
    ...base,
    effectivePrice,
    impactBps: impact * 10_000,
    feeQuote: notionalQuote * fee,
    tokens,
    costQuote: notionalQuote + params.priorityFeeQuote,
  }
}

/**
 * Sell: give `tokenAmount`, receive quote at the impacted price less fee.
 * The impact is computed on the exit's own notional, because depth is consumed by the exit too.
 */
export function computeSellFill(input: FillInput): Fill {
  const { spotPrice, params } = input
  const depth = input.depth
  const tokens = Number(input.tokenAmount)
  const notionalQuote = (spotPrice > 0 && tokens > 0 ? tokens * spotPrice : 0) || input.notionalQuote
  const base: Fill = {
    side: 'sell',
    spotPrice,
    notionalQuote,
    effectivePrice: 0,
    impactBps: 0,
    spreadBps: params.spreadBps,
    feeQuote: 0,
    fixedCostQuote: params.priorityFeeQuote,
    depthQuote: depth.depthQuote,
    depthSource: depth.depthSource,
    tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    costQuote: 0,
    proceedsQuote: 0,
  }
  if (!(spotPrice > 0) || !(base.tokens > 0)) return base

  const impact = impactFraction(notionalQuote, depth.depthQuote, params)
  const spread = params.spreadBps / 10_000
  const fee = params.feeBps / 10_000
  const effectivePrice = Math.max(0, spotPrice * (1 - impact - spread))
  const grossProceeds = base.tokens * effectivePrice
  const feeQuote = grossProceeds * fee

  return {
    ...base,
    effectivePrice,
    impactBps: impact * 10_000,
    feeQuote,
    proceedsQuote: Math.max(0, grossProceeds - feeQuote - params.priorityFeeQuote),
  }
}

export interface RealizedPnl {
  costQuote: number
  proceedsQuote: number
  pnlQuote: number
  pnlPct: number
}

/** The one PnL formula: net proceeds against all-in cost, both already modelled. */
export function computeRealizedPnl(entry: Fill, exit: Fill): RealizedPnl {
  const costQuote = entry.costQuote
  const proceedsQuote = exit.proceedsQuote
  const pnlQuote = proceedsQuote - costQuote
  return {
    costQuote,
    proceedsQuote,
    pnlQuote,
    pnlPct: costQuote > 0 ? (pnlQuote / costQuote) * 100 : 0,
  }
}

/** The `features.exec` record every writer stores, so a row's PnL is recomputable from its fills. */
export function buildExecutionRecord(entry: Fill | null, exit: Fill | null, params: ExecutionParams) {
  return {
    model: EXECUTION_MODEL_VERSION,
    params: {
      feeBps: params.feeBps,
      spreadBps: params.spreadBps,
      priorityFeeQuote: params.priorityFeeQuote,
      impactCoeff: params.impactCoeff,
      impactExponent: params.impactExponent,
    },
    entry: entry ? compactFill(entry) : null,
    exit: exit ? compactFill(exit) : null,
    ...(entry && exit ? { pnlQuote: computeRealizedPnl(entry, exit).pnlQuote } : {}),
  }
}

function compactFill(fill: Fill): Record<string, unknown> {
  return {
    side: fill.side,
    spotPrice: fill.spotPrice,
    notionalQuote: fill.notionalQuote,
    effectivePrice: fill.effectivePrice,
    impactBps: fill.impactBps,
    spreadBps: fill.spreadBps,
    feeQuote: fill.feeQuote,
    fixedCostQuote: fill.fixedCostQuote,
    depthQuote: fill.depthQuote,
    depthSource: fill.depthSource,
    tokens: fill.tokens,
    ...(fill.side === 'buy' ? { costQuote: fill.costQuote } : { proceedsQuote: fill.proceedsQuote }),
  }
}
