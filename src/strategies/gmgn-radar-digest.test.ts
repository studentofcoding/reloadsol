import { describe, expect, it } from 'vitest'
import {
  fitPnlLeaderboardSections,
  formatStrategyPnlLeaderboardHtml,
} from './gmgn-radar-digest'
import { rankTopPnlByActiveStrategy } from './db'
import type { StrategyDefinitionRow, StrategyOutcomeRow } from './types'

function def(
  overrides: Partial<StrategyDefinitionRow> & Pick<StrategyDefinitionRow, 'id' | 'domain' | 'name'>,
): StrategyDefinitionRow {
  return {
    description: null,
    config: {},
    is_active: true,
    execution_mode: 'sim_only',
    version: 1,
    updated_at: '2026-07-14T00:00:00.000Z',
    ...overrides,
  }
}

function outcome(
  overrides: Partial<StrategyOutcomeRow> &
    Pick<StrategyOutcomeRow, 'id' | 'strategy_id' | 'domain' | 'pnl_pct'>,
): StrategyOutcomeRow {
  return {
    token_address: 'mint1',
    entry_at: '2026-07-01T00:00:00.000Z',
    exit_at: '2026-07-02T00:00:00.000Z',
    status: 'closed',
    is_simulated: true,
    features: { token_symbol: 'AAA' },
    created_at: '2026-07-02T00:00:00.000Z',
    ...overrides,
  }
}

describe('rankTopPnlByActiveStrategy', () => {
  it('top 8 per active strategy by pnl_pct; skips inactive and empty', () => {
    const sections = rankTopPnlByActiveStrategy(
      [
        def({ id: 'att', domain: 'trending_bot', name: 'ATT', is_active: true }),
        def({
          id: 'mcap_enter_at_80',
          domain: 'mcap_tracker',
          name: 'Mcap 80',
          is_active: true,
        }),
        def({
          id: 'gmgn_off',
          domain: 'gmgn',
          name: 'GMGN Off',
          is_active: false,
        }),
        def({
          id: 'empty_active',
          domain: 'signals',
          name: 'Empty',
          is_active: true,
        }),
      ],
      [
        outcome({
          id: '1',
          strategy_id: 'mcap_enter_at_80',
          domain: 'mcap_tracker',
          pnl_pct: 50,
          features: { token_symbol: 'MID' },
        }),
        outcome({
          id: '2',
          strategy_id: 'mcap_enter_at_80',
          domain: 'mcap_tracker',
          pnl_pct: 200,
          is_simulated: false,
          features: { token_symbol: 'TOP' },
        }),
        outcome({
          id: '3',
          strategy_id: 'mcap_enter_at_80',
          domain: 'mcap_tracker',
          pnl_pct: 10,
        }),
        outcome({
          id: '4',
          strategy_id: 'att',
          domain: 'trending_bot',
          pnl_pct: 80,
        }),
        outcome({
          id: '5',
          strategy_id: 'gmgn_off',
          domain: 'gmgn',
          pnl_pct: 999,
        }),
        ...Array.from({ length: 10 }, (_, i) =>
          outcome({
            id: `fill-${i}`,
            strategy_id: 'mcap_enter_at_80',
            domain: 'mcap_tracker',
            pnl_pct: i + 1,
            token_address: `mint-fill-${i}`,
          }),
        ),
      ],
      8,
    )

    expect(sections.map((s) => s.strategy_id)).toEqual(['att', 'mcap_enter_at_80'])
    expect(sections.some((s) => s.strategy_id === 'gmgn_off')).toBe(false)
    expect(sections.some((s) => s.strategy_id === 'empty_active')).toBe(false)

    const mcap = sections.find((s) => s.strategy_id === 'mcap_enter_at_80')!
    expect(mcap.trades).toHaveLength(8)
    expect(mcap.trades[0]?.pnl_pct).toBe(200)
    expect(mcap.trades[0]?.is_simulated).toBe(false)
    expect(mcap.trades.every((t) => t.pnl_pct != null && t.pnl_pct >= 3)).toBe(true)
  })
})

describe('formatStrategyPnlLeaderboardHtml', () => {
  it('formats SIM/LIVE lines with strategy sections', () => {
    const html = formatStrategyPnlLeaderboardHtml({
      sections: [
        {
          domain: 'mcap_tracker',
          strategy_id: 'mcap_enter_at_80',
          name: 'Mcap 80',
          trades: [
            outcome({
              id: '1',
              strategy_id: 'mcap_enter_at_80',
              domain: 'mcap_tracker',
              pnl_pct: 182,
              is_simulated: true,
              features: { token_symbol: 'WOW' },
              token_address: 'SoLmint',
            }),
          ],
        },
      ],
      updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    })
    expect(html).toContain('Strategy PnL')
    expect(html).toContain('mcap_enter_at_80')
    expect(html).toContain('+182%')
    expect(html).toContain('[SIM]')
    expect(html).toContain('WOW')
    expect(html).toContain('SoLmint')
  })
})

describe('fitPnlLeaderboardSections', () => {
  it('drops lowest-trade-count section when over max chars', () => {
    const longAddr = 'A'.repeat(200)
    const sections = [
      {
        domain: 'trending_bot' as const,
        strategy_id: 'att',
        name: 'ATT',
        trades: [
          outcome({
            id: 'a1',
            strategy_id: 'att',
            domain: 'trending_bot',
            pnl_pct: 10,
            token_address: longAddr,
          }),
        ],
      },
      {
        domain: 'mcap_tracker' as const,
        strategy_id: 'mcap_enter_at_80',
        name: 'Mcap',
        trades: Array.from({ length: 8 }, (_, i) =>
          outcome({
            id: `m${i}`,
            strategy_id: 'mcap_enter_at_80',
            domain: 'mcap_tracker',
            pnl_pct: 100 - i,
            token_address: longAddr + String(i),
          }),
        ),
      },
    ]
    const fitted = fitPnlLeaderboardSections(
      sections,
      new Date('2026-07-14T00:00:00.000Z'),
      900,
    )
    expect(fitted.sections.some((s) => s.strategy_id === 'att')).toBe(false)
    expect(fitted.sections[0]?.strategy_id).toBe('mcap_enter_at_80')
    expect(fitted.html.length).toBeLessThanOrEqual(900)
    expect(fitted.sections[0]!.trades.length).toBeLessThan(8)
  })
})
