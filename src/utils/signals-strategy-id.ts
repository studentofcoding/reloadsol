export type SignalsStrategyTemplate = 'default' | 'sell_over_100'

export const SIGNALS_STRATEGY_STORAGE_KEY = 'signals_active_strategy'

const TEMPLATE_TO_STRATEGY_ID: Record<SignalsStrategyTemplate, string> = {
  default: 'signals_default',
  sell_over_100: 'signals_sell_over_100',
}

export function resolveSignalsStrategyId(
  template: SignalsStrategyTemplate,
): string {
  return TEMPLATE_TO_STRATEGY_ID[template]
}

export function readSignalsStrategyTemplate(): SignalsStrategyTemplate {
  if (typeof window === 'undefined') return 'sell_over_100'
  const value = localStorage.getItem(SIGNALS_STRATEGY_STORAGE_KEY)
  return value === 'default' || value === 'sell_over_100' ? value : 'sell_over_100'
}

export function writeSignalsStrategyTemplate(
  template: SignalsStrategyTemplate,
): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(SIGNALS_STRATEGY_STORAGE_KEY, template)
}

export function isSignalsStrategyId(strategyId: string | null | undefined): boolean {
  return strategyId === 'signals_default' || strategyId === 'signals_sell_over_100'
}
