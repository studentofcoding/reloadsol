import type { TrendingBotStrategy } from './types'

/**
 * Shared TP1/TP2/TP3/SL/max-hold exit ladder used by both the Solana trending
 * cycle (/api/trending/track shouldSellToken) and the Robinhood sim twin
 * (trending-bot-rh-sim). The two cycles diverged on two points; both behaviors
 * are preserved explicitly via options instead of forking the ladder again:
 *
 * - tp3Style 'profit' (RH): TP3 is a profit target — close when gain >= tp3.
 *   tp3Style 'trailing' (Solana): TP3 is a trailing stop — after TP1 executed,
 *   close when gain falls back to <= tp3.
 * - tp2RequiresTp1 (Solana): TP2 only fires after TP1 has executed; the RH
 *   twin closes at TP2 regardless of TP1 state.
 */

export type ExitLadderCloseReason = 'stop_loss' | 'tp1' | 'tp2' | 'tp3' | 'max_hold'

export type ExitLadderDecision =
  | { action: 'hold' }
  | { action: 'partial'; sellPct: number; reason: 'tp1' }
  | { action: 'close'; reason: ExitLadderCloseReason }

export function decideTrendingExit(params: {
  takeProfitLevels: TrendingBotStrategy['take_profit_levels']
  stopLossPct: number
  maxHoldHours: number
  gainPct: number
  heldHours: number
  tp1Done: boolean
  tp3Style?: 'profit' | 'trailing'
  tp2RequiresTp1?: boolean
}): ExitLadderDecision {
  const {
    takeProfitLevels: tp,
    stopLossPct,
    maxHoldHours,
    gainPct,
    heldHours,
    tp1Done,
    tp3Style = 'profit',
    tp2RequiresTp1 = false,
  } = params

  if (gainPct <= stopLossPct) {
    return { action: 'close', reason: 'stop_loss' }
  }
  if (tp3Style === 'profit' && tp.tp3_enabled && gainPct >= tp.tp3_percentage) {
    return { action: 'close', reason: 'tp3' }
  }
  if (gainPct >= tp.tp2_percentage && (!tp2RequiresTp1 || tp1Done)) {
    return { action: 'close', reason: 'tp2' }
  }
  if (!tp1Done && gainPct >= tp.tp1_percentage) {
    return tp.tp1_sell_percentage >= 100
      ? { action: 'close', reason: 'tp1' }
      : { action: 'partial', sellPct: tp.tp1_sell_percentage, reason: 'tp1' }
  }
  if (tp3Style === 'trailing' && tp1Done && tp.tp3_enabled && gainPct <= tp.tp3_percentage) {
    return { action: 'close', reason: 'tp3' }
  }
  if (maxHoldHours > 0 && heldHours >= maxHoldHours) {
    return { action: 'close', reason: 'max_hold' }
  }
  return { action: 'hold' }
}

/** RH twin semantics: TP3 as profit target, TP2 independent of TP1. */
export function decideRhTrendingExit(params: {
  strategy: TrendingBotStrategy
  gainPct: number
  heldHours: number
  tp1Done: boolean
}): ExitLadderDecision {
  const { strategy, gainPct, heldHours, tp1Done } = params
  return decideTrendingExit({
    takeProfitLevels: strategy.take_profit_levels,
    stopLossPct: strategy.stop_loss_percentage,
    maxHoldHours: strategy.max_hold_hours,
    gainPct,
    heldHours,
    tp1Done,
  })
}
