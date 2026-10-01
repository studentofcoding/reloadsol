/**
 * The exit contract every paper open stamps.
 *
 * SPEC-strategy-exit-standard-v1 rules S8 and S10. Two things an exit needs that the
 * `sl_tp_positions` row could not previously state:
 *
 *   S8 — what the thresholds are measured against. `reference_value` is the number, `reference_kind`
 *        says what it is (`price` | `mcap`), and `exit_basis` says what `stop_loss_percentage` /
 *        `take_profit_percentage` are expressed in. Without them the row is a bare number and every
 *        caller has to agree on a convention — which is how the mcap family ended up registering a
 *        price-derived value it cannot declare.
 *
 *   S10 — `entry_price` is the price actually PAID, not the market quote. A modelled fill pays
 *        `spotPrice * (1 + impact + spread)`, so a stop measured from the quote is measured from a
 *        price the trade never paid. The impact model already exists (`execution-model.ts`); this
 *        calls it at open, where it was previously only called at close.
 *
 * Kept deliberately free of network calls: the entry price is derived from the analytic model at
 * the depth the execution params imply, so opening a position does not spend a rate-limited quote.
 * The close path still refines depth from a real quote, and records which source it used.
 */
import {
  computeBuyFill,
  resolveDepth,
  resolveExecutionParams,
} from './execution-model'
import { addSLTPPosition } from '@/utils/sl-tp-tracker'

export type ExitBasis = 'price' | 'mcap'

/** The thresholds an exit will be evaluated against, already adjusted for this trade. */
export type SimExitThresholds = {
  takeProfitPct: number
  stopLossPct: number
  maxHoldHours: number
}

/**
 * The impact-included price a modelled buy pays for `notionalQuote` at `spotPriceUsd`.
 *
 * Pure arithmetic — no quote, no I/O. Returns `spotPriceUsd` unchanged when the inputs cannot
 * support a fill, so a caller always gets a usable reference rather than zero.
 */
export function impactedEntryPriceUsd(params: {
  spotPriceUsd: number
  notionalQuote: number
}): number {
  const { spotPriceUsd } = params
  if (!(spotPriceUsd > 0)) return spotPriceUsd
  if (!(params.notionalQuote > 0)) return spotPriceUsd

  try {
    const exec = resolveExecutionParams()
    const depth = resolveDepth({}, exec)
    const fill = computeBuyFill({
      side: 'buy',
      spotPrice: spotPriceUsd,
      notionalQuote: params.notionalQuote,
      depth,
      params: exec,
    })
    return fill.effectivePrice > 0 ? fill.effectivePrice : spotPriceUsd
  } catch {
    return spotPriceUsd
  }
}

/**
 * Register one paper position with the SL/TP tracker, carrying its exit contract.
 *
 * Returns null rather than throwing, and registers nothing when there is no usable price — the
 * sims' existing behaviour, kept deliberately: inventing a price would fabricate trigger data.
 */
export async function registerSimExitContract(params: {
  chain: string
  walletAddress: string
  strategyId: string
  mintAddress: string
  symbol: string
  positionSize: number
  /** The price actually paid (S10). Also the default reference value. */
  entryPriceUsd: number
  referenceValue?: number
  basis?: ExitBasis
  thresholds: SimExitThresholds
}): Promise<string | null> {
  const { entryPriceUsd } = params
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) return null

  const basis = params.basis ?? 'price'
  const thresholds = params.thresholds
  if (!Number.isFinite(thresholds.takeProfitPct) || !Number.isFinite(thresholds.stopLossPct)) {
    return null
  }

  try {
    return await addSLTPPosition({
      walletAddress: params.walletAddress,
      tokenAddress: params.mintAddress,
      tokenSymbol: params.symbol,
      positionSize: params.positionSize,
      entryPrice: entryPriceUsd,
      // The trigger compares gain% against these, so the stop must be negative: a threshold of
      // +30 would put the stop above the entry and fire on the first tick.
      stopLossPercentage: -Math.abs(thresholds.stopLossPct),
      takeProfitPercentage: Math.abs(thresholds.takeProfitPct),
      positionType: 'bot',
      strategyId: params.strategyId,
      isSimulation: true,
      referenceKind: basis,
      referenceValue: params.referenceValue ?? entryPriceUsd,
      exitBasis: basis,
      chain: params.chain,
      // A `bot` row reads ONLY tp1/2/3_percentage in checkSLTPTriggers, and take_profit_percentage
      // is read only by the `manual` branch. Registering the TP as TP1 is what makes it fire at
      // all: without it `take_profit_percentage` is a field the worker never evaluates, which is
      // why `Finished: 211 (SL: 211, TP1: 0, TP2: 0, TP3: 0)`.
      tp1Percentage: Math.abs(thresholds.takeProfitPct),
      tp1SellPercentage: 100,
      tp3Enabled: false,
    })
  } catch (error) {
    console.warn(
      '[sim-exit-contract] SL/TP registration skipped:',
      error instanceof Error ? error.message : error,
    )
    return null
  }
}
