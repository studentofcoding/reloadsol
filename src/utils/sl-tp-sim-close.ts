/**
 * The SL/TP worker closing a PAPER position (SPEC-strategy-exit-standard G1 / S9).
 *
 * The worker could already detect a paper trigger, but `markSimulatedPositionClosed` only flips the
 * `sl_tp_positions` mirror row — it writes no outcome and no sell record, so the trade stayed open
 * everywhere that matters. This is the missing half.
 *
 * It dispatches to the closers that already exist for strategy deactivation
 * (`close-strategy-sim-position.ts`) rather than writing a third close path: those already build the
 * sell trading record that retires the open cycle, compute the PnL, and write the domain outcome —
 * the only thing they lacked was a reason other than "deactivated", and a live price to close at.
 *
 * Deliberately NOT touching the chain: every path here is `is_simulation: true`, and
 * `executeSellOrder` (which hardcodes `isSimulated: false`) is unreachable from this module.
 */
import type { SLTPPosition } from '@/utils/sl-tp-tracker'
import {
  closeMcapStrategySimPositions,
  closePriceStrategySimPosition,
  closeReasonForTrigger,
} from '@/strategies/close-strategy-sim-position'
import type { StrategyChain } from '@/strategies/types'

export type SimCloseDomain = 'mcap' | 'signals' | 'gmgn' | 'social'

/**
 * Which closer owns a strategy's paper positions, from its id.
 *
 * Returns null for an unrecognised family. That is deliberate: guessing a close path would write an
 * outcome under the wrong domain, which is worse than leaving the row for the strategy's own
 * closer. The coverage test asserts every active strategy resolves here.
 */
export function simCloseDomainForStrategy(strategyId: string): SimCloseDomain | null {
  if (strategyId.startsWith('search_mcap') || strategyId.startsWith('mcap_enter')) return 'mcap'
  if (strategyId.startsWith('gmgn')) return 'gmgn'
  if (strategyId.startsWith('social')) return 'social'
  // Signals ids arrive in two shapes: `signals_default_rh` and
  // `search_signals_signals_score40_g0_default`. Both are the signals domain.
  if (strategyId.startsWith('signals') || strategyId.startsWith('search_signals')) return 'signals'
  return null
}

export type SimCloseOutcome = {
  /** True when a close was written; false when the family is unrecognised or no cycle was found. */
  closed: boolean
  domain: SimCloseDomain | null
}

/**
 * Close one paper position on a worker trigger. Never throws: a close that fails is reported, not
 * allowed to abort the worker pass for every other position.
 */
export async function closeSimulatedPositionFromWorker(params: {
  position: SLTPPosition
  /** The `trigger_type` from `checkSLTPTriggers`, mapped onto the outcome vocabulary. */
  triggerType: string
  /** The live price the decision was made on — the same tick the trigger was evaluated against. */
  currentPrice: number
}): Promise<SimCloseOutcome> {
  const { position } = params
  const strategyId = position.strategy_id
  if (!strategyId) return { closed: false, domain: null }

  const domain = simCloseDomainForStrategy(strategyId)
  if (!domain) return { closed: false, domain: null }

  const chain: StrategyChain = position.chain === 'robinhood' ? 'robinhood' : 'sol'
  const closeReason = closeReasonForTrigger(params.triggerType)
  const sellPriceUsd =
    params.currentPrice > 0 ? params.currentPrice : undefined

  try {
    if (domain === 'mcap') {
      const result = await closeMcapStrategySimPositions(strategyId, chain, {
        closeReason,
        mintAddress: position.token_address,
        sellPriceUsd,
      })
      return { closed: result.closed > 0, domain }
    }

    await closePriceStrategySimPosition({
      domain,
      chain,
      strategyId,
      mintAddress: position.token_address,
      symbol: position.token_symbol,
      // The mirror row's creation is the open, so it is the best entry timestamp this side has.
      // `ensureCompleteBuyFeaturesForOutcome` rebuilds the features from the mint.
      entryAt: position.created_at,
      entryFeatures: {},
      closeReason,
      sellPriceUsd,
    })
    return { closed: true, domain }
  } catch (error) {
    console.warn(
      '[sl-tp-sim-close] paper close failed:',
      error instanceof Error ? error.message : error,
      { strategyId, mint: position.token_address, triggerType: params.triggerType },
    )
    return { closed: false, domain }
  }
}
