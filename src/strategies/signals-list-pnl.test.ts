import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({
  query: vi.fn(),
}))

import { query } from '@/utils/db'
import { aggregateSignalsListPnl } from '@/strategies/signals-list-pnl'
import { seedSignalsListPickerOptions } from '@/utils/signals-strategy-id'
import { seedSignalsListStrategies } from '@/strategies/signals-strategy-list'

beforeEach(() => {
  vi.mocked(query).mockReset()
})

describe('seedSignalsListPickerOptions', () => {
  it('seeds 4 sol and 3 robinhood options with n=0', () => {
    const sol = seedSignalsListPickerOptions('sol')
    expect(sol).toHaveLength(4)
    expect(sol.every((o) => o.n === 0)).toBe(true)
    expect(sol.map((o) => o.strategyId)).toEqual([
      'signals_default',
      'signals_sell_over_100',
      'mcap_enter_first_seen',
      'mcap_enter_at_80',
    ])

    const rh = seedSignalsListPickerOptions('robinhood')
    expect(rh).toHaveLength(3)
    expect(rh.map((o) => o.strategyId)).not.toContain('signals_sell_over_100')
  })
})

describe('seedSignalsListStrategies', () => {
  it('matches rank with empty breakdown', () => {
    const seeded = seedSignalsListStrategies('sol')
    expect(seeded).toHaveLength(4)
    expect(seeded.every((o) => o.n === 0)).toBe(true)
  })
})

describe('aggregateSignalsListPnl', () => {
  it('maps GROUP BY rows to list PnL shape', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        {
          strategy_id: 'mcap_enter_first_seen',
          domain: 'mcap_tracker',
          trade_count: 3,
          avg_pnl_pct: '12.5',
          total_pnl_pct: '37.5',
        },
      ],
      rowCount: 1,
    } as never)

    const rows = await aggregateSignalsListPnl('sol')
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('GROUP BY strategy_id, domain'),
      ['sol', expect.arrayContaining(['mcap_enter_first_seen'])],
    )
    expect(rows).toEqual([
      {
        strategy_id: 'mcap_enter_first_seen',
        domain: 'mcap_tracker',
        is_simulated: true,
        trade_count: 3,
        avg_pnl_pct: 12.5,
        total_pnl_pct: 37.5,
      },
    ])
  })
})
