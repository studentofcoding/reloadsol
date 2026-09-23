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

/** Signals list picker. Separate from Board's `signals_active_strategy` template. */
export const SIGNALS_LIST_STRATEGY_STORAGE_KEY = 'signals_list_strategy_id'

export const SOL_SIGNALS_LIST_STRATEGY_IDS = [
  'signals_default',
  'signals_sell_over_100',
  'mcap_enter_first_seen',
  'mcap_enter_at_80',
] as const

export const RH_SIGNALS_LIST_STRATEGY_IDS = [
  'signals_default_rh',
  'mcap_enter_first_seen_rh',
  'mcap_enter_at_80_rh',
] as const

export type SignalsListChain = 'sol' | 'robinhood'

export type SignalsListPickerOption = {
  strategyId: string
  name: string
  domain: 'signals' | 'mcap_tracker'
  /** Null when n is 0. A real 0% mean stays 0. */
  avgPnlPct: number | null
  totalPnlPct: number | null
  /** strategy_outcomes trade_count for the sim row. */
  n: number
}

export function signalsListStrategyIds(chain: SignalsListChain): readonly string[] {
  return chain === 'robinhood'
    ? RH_SIGNALS_LIST_STRATEGY_IDS
    : SOL_SIGNALS_LIST_STRATEGY_IDS
}

/** Empty storage. Not the highest-avg strategy. */
export function signalsListStrategyFallback(chain: SignalsListChain): string {
  return chain === 'robinhood' ? 'signals_default_rh' : 'signals_sell_over_100'
}

export function resolveSignalsListStrategyId(
  stored: string | null | undefined,
  chain: SignalsListChain,
): string {
  const ids = signalsListStrategyIds(chain)
  if (stored && ids.includes(stored)) return stored
  return signalsListStrategyFallback(chain)
}

export function readSignalsListStrategyId(chain: SignalsListChain): string {
  if (typeof window === 'undefined') return signalsListStrategyFallback(chain)
  return resolveSignalsListStrategyId(
    localStorage.getItem(SIGNALS_LIST_STRATEGY_STORAGE_KEY),
    chain,
  )
}

export function writeSignalsListStrategyId(strategyId: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(SIGNALS_LIST_STRATEGY_STORAGE_KEY, strategyId)
}

/** n>0: `{name} · {avg}% avg · n={n}`. n=0: `{name} · n=0` (no fake 0% average). */
export function formatSignalsListOptionLabel(option: {
  name: string
  avgPnlPct: number | null
  n: number
}): string {
  if (option.n > 0 && option.avgPnlPct != null && Number.isFinite(option.avgPnlPct)) {
    return `${option.name} · ${Math.round(option.avgPnlPct)}% avg · n=${option.n}`
  }
  return `${option.name} · n=0`
}

/** Option title. One decimal on the raw sum. */
export function formatSignalsListOptionTitle(option: {
  n: number
  totalPnlPct: number | null
}): string | undefined {
  if (option.n > 0 && option.totalPnlPct != null && Number.isFinite(option.totalPnlPct)) {
    return `sum ${option.totalPnlPct.toFixed(1)}%`
  }
  return undefined
}
