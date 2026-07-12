import { describe, expect, it } from 'vitest'
import type { StrategyOutcomeRow } from './types'
import {
  buildDefaultGmgnSearchGrid,
  buildDefaultSignalsSearchGrid,
  passesGmgnEntryFilter,
  passesSignalsEntryFilter,
  walkForwardDomainSearch,
} from './domain-strategy-search'
import { isSearchStrategyId, searchStrategyId } from './strategy-search-bandit'

function outcome(
  partial: Partial<StrategyOutcomeRow> & { features?: Record<string, unknown> },
): StrategyOutcomeRow {
  return {
    id: partial.id ?? '1',
    strategy_id: partial.strategy_id ?? 'gmgn_smartmoney_default',
    domain: partial.domain ?? 'gmgn',
    token_address: 'mint',
    entry_at: partial.entry_at ?? '2026-06-01T00:00:00.000Z',
    exit_at: partial.exit_at ?? '2026-06-02T00:00:00.000Z',
    pnl_pct: partial.pnl_pct ?? 10,
    status: partial.status ?? 'won',
    is_simulated: true,
    features: partial.features ?? { smart_wallets: 4, top_10_holder_rate: 0.1 },
    created_at: partial.created_at ?? '2026-06-02T00:00:00.000Z',
  }
}

describe('domain-strategy-search', () => {
  it('filters gmgn by smart wallet floor', () => {
    expect(
      passesGmgnEntryFilter(outcome({ features: { smart_wallets: 2 } }), {
        minSmartWallets: 3,
      }),
    ).toBe(false)
    expect(
      passesGmgnEntryFilter(outcome({ features: { smart_wallets: 5 } }), {
        minSmartWallets: 3,
      }),
    ).toBe(true)
  })

  it('filters signals by score floor', () => {
    expect(
      passesSignalsEntryFilter(
        outcome({
          domain: 'signals',
          strategy_id: 'signals_default',
          features: { enter_score: 45 },
        }),
        { enterScoreFloor: 50 },
      ),
    ).toBe(false)
    expect(
      passesSignalsEntryFilter(
        outcome({
          domain: 'signals',
          strategy_id: 'signals_default',
          features: { enter_score: 55 },
        }),
        { enterScoreFloor: 50 },
      ),
    ).toBe(true)
  })

  it('builds non-empty gmgn/signals grids', () => {
    expect(buildDefaultGmgnSearchGrid().length).toBeGreaterThan(10)
    expect(buildDefaultSignalsSearchGrid().length).toBeGreaterThan(5)
  })

  it('walk-forward ranks gmgn configs', () => {
    const rows: StrategyOutcomeRow[] = []
    for (let w = 0; w < 6; w++) {
      const day = 1 + w * 7
      const month = day > 28 ? 7 : 6
      const d = day > 28 ? day - 28 : day
      for (let i = 0; i < 3; i++) {
        rows.push(
          outcome({
            id: `g-${w}-${i}`,
            entry_at: `2026-0${month}-${String(d).padStart(2, '0')}T00:00:00.000Z`,
            exit_at: `2026-0${month}-${String(d).padStart(2, '0')}T12:00:00.000Z`,
            pnl_pct: 20,
            features: { smart_wallets: 5, top_10_holder_rate: 0.1, radar_score: 70 },
          }),
        )
      }
    }
    const result = walkForwardDomainSearch({
      domain: 'gmgn',
      rows,
      configs: buildDefaultGmgnSearchGrid().slice(0, 20),
      holdoutWeeks: 2,
      minTradesHoldout: 2,
    })
    expect(result.ranked.length).toBeGreaterThan(0)
  })
})

describe('strategy-search-bandit ids', () => {
  it('prefixes search ids by domain', () => {
    expect(searchStrategyId('mcap_tracker', 'first_seen_sl-50_tp200_h96')).toMatch(
      /^search_mcap_/,
    )
    expect(isSearchStrategyId('search_gmgn_foo')).toBe(true)
    expect(isSearchStrategyId('mcap_enter_first_seen')).toBe(false)
  })
})
