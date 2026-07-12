import { describe, expect, it } from 'vitest'
import type { StrategyOutcomeRow } from './types'
import {
  buildDefaultMcapSearchGrid,
  inferFirstMcap,
  replayMcapOutcome,
  walkForwardSearch,
} from './mcap-exit-replay'

function outcome(
  partial: Partial<StrategyOutcomeRow> & {
    features?: Record<string, unknown>
  },
): StrategyOutcomeRow {
  return {
    id: partial.id ?? '1',
    strategy_id: partial.strategy_id ?? 'mcap_enter_first_seen',
    domain: 'mcap_tracker',
    token_address: 'mint',
    entry_at: partial.entry_at ?? '2026-06-01T00:00:00.000Z',
    exit_at: partial.exit_at ?? '2026-06-10T00:00:00.000Z',
    pnl_pct: partial.pnl_pct ?? 50,
    status: partial.status ?? 'won',
    is_simulated: true,
    features: partial.features ?? {
      entry_mcap: 100_000,
      exit_mcap: 150_000,
      entry_template: 'first_seen',
      when_reach_200pct: '2026-06-05T00:00:00.000Z',
    },
    created_at: partial.created_at ?? '2026-06-10T00:00:00.000Z',
  }
}

describe('mcap-exit-replay', () => {
  it('infers first mcap from milestone_80 entry', () => {
    expect(inferFirstMcap(180_000, 'milestone_80')).toBeCloseTo(100_000)
  })

  it('exits early on take profit via milestones', () => {
    const row = outcome({
      features: {
        entry_mcap: 100_000,
        exit_mcap: 400_000,
        entry_template: 'first_seen',
        when_reach_200pct: '2026-06-03T00:00:00.000Z',
      },
    })
    const replayed = replayMcapOutcome(row, {
      stopLossPct: -50,
      takeProfitPct: 200,
      maxHoldHours: 96,
    })
    expect(replayed).not.toBeNull()
    expect(replayed!.exitReason).toBe('take_profit')
    expect(replayed!.pnlPct).toBeGreaterThanOrEqual(200)
    expect(replayed!.exitAt).toBe('2026-06-03T00:00:00.000Z')
  })

  it('walk-forward ranks configs that beat sparse baseline', () => {
    const rows: StrategyOutcomeRow[] = []
    // Spread across 6 weeks so holdout of 4 still has train
    for (let w = 0; w < 6; w++) {
      const day = 1 + w * 7
      const month = day > 28 ? 7 : 6
      const d = day > 28 ? day - 28 : day
      for (let i = 0; i < 3; i++) {
        rows.push(
          outcome({
            id: `r-${w}-${i}`,
            entry_at: `2026-0${month}-${String(d).padStart(2, '0')}T00:00:00.000Z`,
            exit_at: `2026-0${month}-${String(d).padStart(2, '0')}T12:00:00.000Z`,
            pnl_pct: 10,
            features: {
              entry_mcap: 100_000,
              exit_mcap: 110_000,
              entry_template: 'first_seen',
              when_reach_120pct: `2026-0${month}-${String(d).padStart(2, '0')}T06:00:00.000Z`,
            },
          }),
        )
      }
    }
    const grid = buildDefaultMcapSearchGrid().filter((c) =>
      c.id.startsWith('first_seen_'),
    )
    const result = walkForwardSearch({
      rows,
      configs: grid.slice(0, 8),
      holdoutWeeks: 2,
      minTradesHoldout: 2,
    })
    expect(result.ranked.length).toBeGreaterThan(0)
    expect(result.holdoutWeeks.length).toBeGreaterThan(0)
  })
})
