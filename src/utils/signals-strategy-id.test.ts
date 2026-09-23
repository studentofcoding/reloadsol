import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SIGNALS_LIST_STRATEGY_STORAGE_KEY,
  SIGNALS_STRATEGY_STORAGE_KEY,
  formatSignalsListOptionLabel,
  formatSignalsListOptionTitle,
  readSignalsListStrategyId,
  readSignalsStrategyTemplate,
  resolveSignalsListStrategyId,
  writeSignalsListStrategyId,
  writeSignalsStrategyTemplate,
} from './signals-strategy-id'

const store = new Map<string, string>()

function installStorage() {
  store.clear()
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  store.clear()
})

describe('signals list strategy id', () => {
  it('falls back without writing Board storage', () => {
    installStorage()
    expect(readSignalsListStrategyId('sol')).toBe('signals_sell_over_100')
    expect(readSignalsListStrategyId('robinhood')).toBe('signals_default_rh')
    expect(store.has(SIGNALS_STRATEGY_STORAGE_KEY)).toBe(false)
    expect(store.has(SIGNALS_LIST_STRATEGY_STORAGE_KEY)).toBe(false)
    expect(readSignalsStrategyTemplate()).toBe('sell_over_100')
  })

  it('keeps an in-universe id and ignores ids from the other chain', () => {
    expect(resolveSignalsListStrategyId('mcap_enter_at_80', 'sol')).toBe('mcap_enter_at_80')
    expect(resolveSignalsListStrategyId('mcap_enter_at_80', 'robinhood')).toBe(
      'signals_default_rh',
    )
    expect(resolveSignalsListStrategyId('signals_sell_over_100', 'robinhood')).toBe(
      'signals_default_rh',
    )
    expect(resolveSignalsListStrategyId('', 'sol')).toBe('signals_sell_over_100')
    expect(resolveSignalsListStrategyId('not_a_strategy', 'sol')).toBe(
      'signals_sell_over_100',
    )
  })

  it('writes signals_list_strategy_id and leaves the Board template key alone', () => {
    installStorage()
    writeSignalsStrategyTemplate('default')
    writeSignalsListStrategyId('mcap_enter_first_seen')
    expect(store.get(SIGNALS_LIST_STRATEGY_STORAGE_KEY)).toBe('mcap_enter_first_seen')
    expect(store.get(SIGNALS_STRATEGY_STORAGE_KEY)).toBe('default')
    expect(readSignalsStrategyTemplate()).toBe('default')
    expect(readSignalsListStrategyId('sol')).toBe('mcap_enter_first_seen')
    expect(readSignalsListStrategyId('robinhood')).toBe('signals_default_rh')
  })

  it('does not treat an unknown Board value as a list id', () => {
    installStorage()
    store.set(SIGNALS_STRATEGY_STORAGE_KEY, 'mcap_enter_at_80')
    expect(readSignalsStrategyTemplate()).toBe('sell_over_100')
  })
})

describe('signals list option label', () => {
  it('rounds the mean and shows n, with sum on the title', () => {
    const option = { name: 'Sell over 100%', avgPnlPct: 359.4, totalPnlPct: 13657.2, n: 38 }
    expect(formatSignalsListOptionLabel(option)).toBe('Sell over 100% · 359% avg · n=38')
    expect(formatSignalsListOptionTitle(option)).toBe('sum 13657.2%')
  })

  it('does not invent a 0% average when n is 0', () => {
    const option = { name: 'Default momentum', avgPnlPct: null, totalPnlPct: null, n: 0 }
    expect(formatSignalsListOptionLabel(option)).toBe('Default momentum · n=0')
    expect(formatSignalsListOptionTitle(option)).toBeUndefined()
  })
})
