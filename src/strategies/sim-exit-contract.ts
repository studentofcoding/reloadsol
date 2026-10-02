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

/**
 * Registrations that could not be built, since process start.
 *
 * `registerSimExitContract` returns null rather than throwing, and that is deliberate — inventing a
 * price would fabricate trigger data. But it used to be a single `console.warn`, so a strategy whose
 * opens silently stopped registering looked identical to one that had simply not opened. This is a
 * counter the exit summary can surface, which is the difference between "visible in a log" and
 * "measurable".
 */
let registrationFailures = 0

export function simExitRegistrationFailureCount(): number {
  return registrationFailures
}

function failLoudly(reason: string, params: { strategyId?: string; mintAddress?: string }): null {
  registrationFailures += 1
  // console.warn, not console.error: the production build strips info/debug but keeps warn, and the
  // failure is a skip rather than a crash. It carries the strategy and mint so a log line names the
  // offending open instead of just reporting a count.
  console.warn(
    `[sim-exit-contract] exit contract NOT registered (${reason}) — strategy=${params.strategyId ?? '?'} mint=${params.mintAddress ?? '?'}`,
  )
  return null
}

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
  if (!Number.isFinite(entryPriceUsd) || entryPriceUsd <= 0) {
    return failLoudly(`entry_price=${entryPriceUsd}`, params)
  }

  const basis = params.basis ?? 'price'
  const thresholds = params.thresholds
  if (!Number.isFinite(thresholds.takeProfitPct) || !Number.isFinite(thresholds.stopLossPct)) {
    return failLoudly(
      `thresholds not finite (tp=${thresholds.takeProfitPct} sl=${thresholds.stopLossPct})`,
      params,
    )
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
      //
      // The ladder is DEGENERATE ON PURPOSE, and that is why TP2/TP3 read 0 forever:
      // `tp1SellPercentage: 100` means TP1 closes the whole position, and `tp3Enabled: false`
      // disables the trailing tier. So the row carries one target, expressed as tier 1 — which
      // makes a three-tier ladder indistinguishable from a single TP, and means the 0s are correct
      // rather than a bug. Wiring real laddering is a separate behavioural change: it would alter
      // how every open position exits, so it does not belong in a change that is otherwise
      // recording what already happens. The tp2/tp3 columns stay for the manual path, which does
      // use them.
      tp1Percentage: Math.abs(thresholds.takeProfitPct),
      tp1SellPercentage: 100,
      tp3Enabled: false,
    })
  } catch (error) {
    return failLoudly(
      `registration threw: ${error instanceof Error ? error.message : String(error)}`,
      params,
    )
  }
}
