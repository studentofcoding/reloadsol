export function resolveTrackerStrategyId(
  sim: Record<string, unknown> | null | undefined,
): string | null {
  if (!sim) return null
  const buy = sim.buy_operation as { bot_strategy?: string } | null | undefined
  return (
    (sim.strategy_id as string | undefined) ??
    (sim.strategy as string | undefined) ??
    buy?.bot_strategy ??
    null
  )
}

type TrackerTokenLike = {
  trading_simulation?: unknown
  status?: string | null
}

export function isOpenTrackerPosition(token: TrackerTokenLike): boolean {
  if (token.status !== 'tracking') return false
  const sim = token.trading_simulation as Record<string, unknown> | null | undefined
  if (!sim) return false
  if (sim.current_status !== 'holding') return false
  const buy = sim.buy_operation as { bot_strategy?: string; signature?: string } | null | undefined
  if (!buy?.bot_strategy) return false
  const remaining = parseFloat(String(sim.remaining_token_amount ?? '0'))
  const initial = parseFloat(String(sim.initial_token_amount ?? '0'))
  if (!initial || remaining < 1e-6) return false
  return true
}

export function isSimulatedTrackerPosition(token: TrackerTokenLike): boolean {
  const sim = token.trading_simulation as { is_simulated?: boolean } | null | undefined
  if (!sim) return false
  return sim.is_simulated !== false
}
