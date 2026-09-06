import { describe, expect, it } from 'vitest'
import { computeFitnessByStrategy, computeStrategyFitness } from './strategy-fitness'

const now = new Date('2026-09-07T00:00:00Z')
const day = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
const mk = (pnls: number[], startDay = 1, strategy_id = 's') =>
  pnls.map((p, i) => ({ strategy_id, pnl_pct: p, exit_at: day(startDay + i) }))

describe('computeStrategyFitness', () => {
  it('passes with positive expectancy, enough closes and no drawdown week', () => {
    const f = computeStrategyFitness(mk(Array(20).fill(5)), {}, now)
    expect(f.passes).toBe(true)
    expect(f.closes).toBe(20)
    expect(f.expectancyPct).toBe(5)
    expect(f.winRate).toBe(1)
  })

  it('fails on too few closes and ignores outcomes outside the window', () => {
    const f = computeStrategyFitness([...mk(Array(10).fill(5)), ...mk(Array(20).fill(5), 40)], {}, now)
    expect(f.closes).toBe(10)
    expect(f.passes).toBe(false)
    expect(f.reasons[0]).toMatch(/closes 10 < 20/)
  })

  it('fails on a drawdown week even when expectancy is positive', () => {
    // 3 losses of -20 on consecutive days → same ISO week, total -60
    const bad = mk([-20, -20, -20], 1)
    const good = mk(Array(20).fill(10), 8)
    const f = computeStrategyFitness([...bad, ...good], {}, now)
    expect(f.expectancyPct).toBeGreaterThan(0)
    expect(f.drawdownWeeks).toHaveLength(1)
    expect(f.passes).toBe(false)
    expect(f.worstWeekPnlPct).toBe(-60)
  })

  it('fails on non-positive expectancy', () => {
    const f = computeStrategyFitness(mk(Array(20).fill(-1)), {}, now)
    expect(f.passes).toBe(false)
    expect(f.reasons.some((r) => r.startsWith('expectancy'))).toBe(true)
  })

  it('groups by strategy id', () => {
    const m = computeFitnessByStrategy([...mk(Array(20).fill(5), 1, 'a'), ...mk(Array(5).fill(5), 1, 'b')], {}, now)
    expect(m.get('a')?.passes).toBe(true)
    expect(m.get('b')?.passes).toBe(false)
  })
})
