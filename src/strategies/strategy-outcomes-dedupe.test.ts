import { describe, expect, it } from 'vitest'
import { dedupeStrategyOutcomeRows } from '@/strategies/outcome-dedupe'
import type { StrategyOutcomeRow } from '@/strategies/types'

function outcome(
  overrides: Partial<StrategyOutcomeRow> & Pick<StrategyOutcomeRow, 'id'>,
): StrategyOutcomeRow {
  return {
    strategy_id: 'mcap_enter_at_80',
    domain: 'mcap_tracker',
    token_address: 'mint1',
    entry_at: '2026-06-26T09:46:00.000Z',
    exit_at: '2026-06-27T03:16:07.000Z',
    pnl_pct: 114.23,
    status: 'won',
    is_simulated: true,
    features: null,
    created_at: '2026-06-27T03:16:07.000Z',
    ...overrides,
  }
}

describe('dedupeStrategyOutcomeRows', () => {
  it('keeps the row with the latest exit_at per trade key', () => {
    const rows = [
      outcome({
        id: '1',
        exit_at: '2026-06-27T03:16:07.000Z',
        pnl_pct: 114.23,
      }),
      outcome({
        id: '2',
        exit_at: '2026-06-27T03:18:07.000Z',
        pnl_pct: 114.23,
      }),
      outcome({
        id: '3',
        exit_at: '2026-06-27T03:20:07.000Z',
        pnl_pct: 114.23,
      }),
    ]

    const deduped = dedupeStrategyOutcomeRows(rows)
    expect(deduped).toHaveLength(1)
    expect(deduped[0].id).toBe('3')
  })

  it('preserves distinct trades with different entry_at', () => {
    const rows = [
      outcome({ id: '1', entry_at: '2026-06-26T09:46:00.000Z' }),
      outcome({ id: '2', entry_at: '2026-06-27T01:10:00.000Z' }),
    ]

    expect(dedupeStrategyOutcomeRows(rows)).toHaveLength(2)
  })
})
