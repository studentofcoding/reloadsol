import { describe, expect, it } from 'vitest'
import {
  buildDailyRows,
  buildRegimeBuckets,
  resolveBudgetHeadroom,
  buildSizingBuckets,
  capacityForBudget,
  pnlSolFor,
  resolveBasePositionSizeSol,
  resolveDailyBudgetSol,
  summarizeDailyPnl,
  type DailyPnlRow,
} from './pnl-dashboard'

const BASE = 0.005
const BUDGET = 0.5

function rawDay(over: Record<string, unknown> = {}) {
  return {
    day: '2026-09-29',
    trades: 10,
    won: 6,
    lost: 4,
    sum_pnl_pct: '100',
    sum_pnl_pct_weighted: '50', // the system's median multiplier halved the stake
    median_size_mult: '0.5',
    with_size_mult: 10,
    avg_pnl_pct: '10',
    median_pnl_pct: '2',
    with_exec: 0,
    exec_pnl_quote: null,
    ...over,
  }
}

function dayRow(over: Partial<DailyPnlRow> = {}): DailyPnlRow {
  return {
    day: '2026-09-29',
    regimeTag: null,
    trades: 10,
    won: 6,
    lost: 4,
    sumPnlPct: 100,
    sumPnlPctWeighted: 50,
    avgPnlPct: 10,
    medianPnlPct: 2,
    pnlSolFlat: 0.005,
    pnlSolSized: 0.0025,
    medianSizeMult: 0.5,
    withSizeMult: 10,
    withExec: 0,
    execPnlSol: null,
    peakConcurrent: 64,
    capitalSol: 0.32,
    budgetUsedPct: 64,
    capacity: 100,
    sizedCapacity: 200,
    velocityMaxSol: 0.32,
    velocityMaxPct: 64,
    optimalBudgetSol: 0.4,
    meanSizeMult: 0.5,
    winRatePct: 60,
    avgRiskSol: 0.0025,
    avgRewardSol: 0.004,
    winLossRatio: 1.6,
    profitFactor: 2.4,
    grossWinPct: 120,
    grossLossPct: -50,
    avgWinPct: 20,
    avgLossPct: -12.5,
    bestPnlPct: 40,
    worstPnlPct: -20,
    ...over,
  }
}

describe('config', () => {
  it('defaults the budget and the base stake, and refuses junk', () => {
    expect(resolveDailyBudgetSol({})).toBe(0.5)
    expect(resolveBasePositionSizeSol({})).toBe(0.005)
    for (const raw of ['', 'abc', '0', '-1']) {
      expect(resolveDailyBudgetSol({ SIM_DAILY_BUDGET_SOL: raw })).toBe(0.5)
      expect(resolveBasePositionSizeSol({ SIM_BASE_POSITION_SOL: raw })).toBe(0.005)
    }
  })

  it('capacity is how many positions the budget carries, and sizing changes it', () => {
    expect(capacityForBudget(BUDGET, 0.005)).toBe(100)
    expect(capacityForBudget(BUDGET, 0.01)).toBe(50)
    expect(capacityForBudget(BUDGET, 0)).toBe(0)
  })
})

describe('pnlSolFor', () => {
  it('applies the stake to the summed percentage', () => {
    expect(pnlSolFor(26676, 0.005)).toBeCloseTo(1.3338, 6)
    expect(pnlSolFor(-100, 0.01)).toBeCloseTo(-0.01, 8)
  })
})

describe('buildDailyRows with the stamped sizing', () => {
  it('reports the flat stake and the sized stake side by side', () => {
    const rows = buildDailyRows({
      daily: [rawDay()],
      peaks: [{ day: '2026-09-29', peak_open: 64 }],
      basePositionSizeSol: BASE,
      budgetSol: BUDGET,
    })
    expect(rows[0].pnlSolFlat).toBeCloseTo(0.005, 8) // 100% of 0.005
    expect(rows[0].pnlSolSized).toBeCloseTo(0.0025, 8) // 50% of 0.005 — the half-size stake
    expect(rows[0].medianSizeMult).toBe(0.5)
    expect(rows[0].withSizeMult).toBe(10)
  })

  it('scales capacity by the applied sizing', () => {
    const rows = buildDailyRows({
      daily: [rawDay()],
      peaks: [],
      basePositionSizeSol: BASE,
      budgetSol: BUDGET,
    })
    expect(rows[0].capacity).toBe(100)
    expect(rows[0].sizedCapacity).toBe(200) // half the stake, twice the positions
  })

  it('falls back to the flat figure when a day has no stamped multiplier', () => {
    const rows = buildDailyRows({
      daily: [rawDay({ sum_pnl_pct_weighted: null, median_size_mult: null, with_size_mult: 0 })],
      peaks: [],
      basePositionSizeSol: BASE,
      budgetSol: BUDGET,
    })
    expect(rows[0].pnlSolSized).toBeCloseTo(rows[0].pnlSolFlat, 10)
    expect(rows[0].medianSizeMult).toBeNull()
    expect(rows[0].sizedCapacity).toBe(100)
  })

  it('treats junk as zero rather than NaN', () => {
    const rows = buildDailyRows({
      daily: [rawDay({ sum_pnl_pct: 'abc', avg_pnl_pct: null, median_pnl_pct: '' })],
      peaks: [],
      basePositionSizeSol: BASE,
      budgetSol: BUDGET,
    })
    expect(rows[0].sumPnlPct).toBe(0)
    expect(rows[0].avgPnlPct).toBe(0)
  })
})

describe('buildSizingBuckets', () => {
  it('prices each multiplier bucket at its own stake', () => {
    const buckets = buildSizingBuckets({
      bySizeMult: [
        { regime: '0.500', trades: 20, won: 12, lost: 8, sum_pnl_pct: '50' },
        { regime: '1.000', trades: 100, won: 50, lost: 50, sum_pnl_pct: '80' },
      ],
      basePositionSizeSol: BASE,
    })
    expect(buckets[0].sizeMult).toBe(0.5)
    expect(buckets[0].pnlSolSized).toBeCloseTo(0.00125, 8) // 50% × 0.5 × 0.005
    expect(buckets[1].sizeMult).toBe(1)
    expect(buckets[1].pnlSolSized).toBeCloseTo(0.004, 8)
  })

  it('treats a missing multiplier as the base stake', () => {
    const buckets = buildSizingBuckets({
      bySizeMult: [{ regime: null, trades: 1, won: 1, lost: 0, sum_pnl_pct: '100' }],
      basePositionSizeSol: BASE,
    })
    expect(buckets[0].sizeMult).toBe(1)
  })
})

describe('summarizeDailyPnl', () => {
  const rows: DailyPnlRow[] = [
    dayRow({ day: '2026-09-28', pnlSolFlat: 0.005, pnlSolSized: 0.005, medianSizeMult: 1 }),
    dayRow({
      day: '2026-09-29',
      sumPnlPct: -40,
      sumPnlPctWeighted: -20,
      pnlSolFlat: -0.002,
      pnlSolSized: -0.001,
      medianSizeMult: 0.5,
      trades: 14,
      won: 9,
      lost: 5,
      withExec: 4,
      execPnlSol: -0.004,
      peakConcurrent: 64,
    }),
  ]

  it('totals both figures and reports the sizing effect', () => {
    const s = summarizeDailyPnl({ rows, budgetSol: BUDGET, basePositionSizeSol: BASE })
    expect(s.pnlSolFlat).toBeCloseTo(0.003, 8)
    expect(s.pnlSolSized).toBeCloseTo(0.004, 8)
    expect(s.sizingEffectPct).toBeCloseTo((0.001 / 0.003) * 100, 6)
    expect(s.medianSizeMult).toBeCloseTo(0.75, 8)
  })

  it('reports capacity at the base stake and the peak against the budget', () => {
    const s = summarizeDailyPnl({ rows, budgetSol: BUDGET, basePositionSizeSol: BASE })
    expect(s.capacity).toBe(100)
    expect(s.peakConcurrent).toBe(64)
    expect(s.peakCapitalSol).toBeCloseTo(0.32, 8)
    expect(s.peakBudgetUsedPct).toBeCloseTo(64, 6)
  })

  it('carries the exec total only when records exist', () => {
    const s = summarizeDailyPnl({ rows, budgetSol: BUDGET, basePositionSizeSol: BASE })
    expect(s.tradesWithExec).toBe(4)
    expect(s.execPnlSol).toBeCloseTo(-0.004, 8)
  })

  it('names best and worst by the sized figure', () => {
    const s = summarizeDailyPnl({ rows, budgetSol: BUDGET, basePositionSizeSol: BASE })
    expect(s.bestDay?.day).toBe('2026-09-28')
    expect(s.worstDay?.day).toBe('2026-09-29')
  })

  it('survives an empty range', () => {
    const s = summarizeDailyPnl({ rows: [], budgetSol: BUDGET, basePositionSizeSol: BASE })
    expect(s.days).toBe(0)
    expect(s.sizingEffectPct).toBe(0)
    expect(s.medianSizeMult).toBeNull()
    expect(s.bestDay).toBeNull()
  })
})

describe('velocity and the optimal daily budget', () => {
  it('headroom is env-tunable with a 1.25 default', () => {
    expect(resolveBudgetHeadroom({})).toBe(1.25)
    expect(resolveBudgetHeadroom({ SIM_BUDGET_HEADROOM: '2' })).toBe(2)
    for (const raw of ['', 'abc', '0', '-1']) {
      expect(resolveBudgetHeadroom({ SIM_BUDGET_HEADROOM: raw })).toBe(1.25)
    }
  })

  it('velocity is the peak simultaneous capital, and the optimal budget adds headroom', () => {
    const rows = buildDailyRows({
      daily: [rawDay()],
      peaks: [{ day: '2026-09-29', peak_open: 64 }],
      basePositionSizeSol: BASE,
      budgetSol: BUDGET,
      budgetHeadroom: 1.25,
    })
    expect(rows[0].velocityMaxSol).toBeCloseTo(0.32, 8) // 64 × 0.005
    expect(rows[0].velocityMaxPct).toBeCloseTo(64, 6)
    expect(rows[0].optimalBudgetSol).toBeCloseTo(0.4, 8) // 0.32 × 1.25
  })

  it('the range suggests the largest day, and says whether the budget covers it', () => {
    const rows = [
      dayRow({ day: 'a', velocityMaxSol: 0.32, optimalBudgetSol: 0.4 }),
      dayRow({ day: 'b', velocityMaxSol: 0.45, optimalBudgetSol: 0.5625 }),
    ]
    const tight = summarizeDailyPnl({ rows, budgetSol: 0.5, basePositionSizeSol: BASE, budgetHeadroom: 1.25 })
    expect(tight.suggestedDailyBudgetSol).toBeCloseTo(0.5625, 8)
    expect(tight.budgetAdequate).toBe(false) // 0.5 does not cover a 0.5625 need

    const roomy = summarizeDailyPnl({ rows, budgetSol: 0.6, basePositionSizeSol: BASE, budgetHeadroom: 1.25 })
    expect(roomy.budgetAdequate).toBe(true)
  })
})

describe('buildRegimeBuckets', () => {
  it('groups PnL by the stamped regime tag, and keeps untagged visible', () => {
    const buckets = buildRegimeBuckets({
      byRegimeTag: [
        { regime: 'Hype', trades: 40, won: 24, lost: 16, sum_pnl_pct: '120' },
        { regime: null, trades: 10, won: 4, lost: 6, sum_pnl_pct: '-30' },
      ],
      basePositionSizeSol: BASE,
    })
    expect(buckets[0].regimeTag).toBe('Hype')
    expect(buckets[0].pnlSolFlat).toBeCloseTo(0.006, 8) // 120% of 0.005
    expect(buckets[1].regimeTag).toBeNull()
    expect(buckets[1].pnlSolFlat).toBeCloseTo(-0.0015, 8)
  })
})

describe('per-day risk and reward', () => {
  it('computes WR, average risk, average reward, the ratio and profit factor', () => {
    const rows = buildDailyRows({
      daily: [
        rawDay({
          trades: 10,
          won: 6,
          lost: 4,
          gross_win_pct: '120',
          gross_loss_pct: '-50',
          avg_win_pct: '20',
          avg_loss_pct: '-12.5',
          mean_size_mult: '0.5',
        }),
      ],
      peaks: [],
      basePositionSizeSol: BASE,
      budgetSol: BUDGET,
    })
    const d = rows[0]
    expect(d.winRatePct).toBeCloseTo(60, 6)
    expect(d.avgRiskSol).toBeCloseTo(0.0025, 8) // 0.005 base × 0.5 mean sizing
    expect(d.avgRewardSol).toBeCloseTo(0.0005, 8) // 0.0025 risked × 20% average win
    expect(d.winLossRatio).toBeCloseTo(20 / 12.5, 6)
    expect(d.profitFactor).toBeCloseTo(120 / 50, 6)
    expect(d.bestPnlPct).toBe(0)
  })

  it('reports a null ratio and factor rather than Infinity on a day with no losses', () => {
    const rows = buildDailyRows({
      daily: [rawDay({ lost: 0, gross_loss_pct: '0', avg_loss_pct: '0' })],
      peaks: [],
      basePositionSizeSol: BASE,
      budgetSol: BUDGET,
    })
    expect(rows[0].winLossRatio).toBeNull()
    expect(rows[0].profitFactor).toBeNull()
  })

  it('survives a day with no trades at all', () => {
    const rows = buildDailyRows({
      daily: [rawDay({ trades: 0, won: 0, lost: 0, gross_win_pct: null, gross_loss_pct: null })],
      peaks: [],
      basePositionSizeSol: BASE,
      budgetSol: BUDGET,
    })
    expect(rows[0].winRatePct).toBe(0)
    expect(Number.isFinite(rows[0].avgRiskSol)).toBe(true)
  })

  it('rolls the range metrics up weighted by trades', () => {
    const rows = [
      dayRow({ day: 'a', won: 10, lost: 0, avgWinPct: 30, avgLossPct: 0, grossWinPct: 300, grossLossPct: 0, avgRiskSol: 0.005, avgRewardSol: 0.0015 }),
      dayRow({ day: 'b', won: 0, lost: 10, avgWinPct: 0, avgLossPct: -10, grossWinPct: 0, grossLossPct: -100, avgRiskSol: 0.005, avgRewardSol: 0 }),
    ]
    const s = summarizeDailyPnl({ rows, budgetSol: BUDGET, basePositionSizeSol: BASE })
    expect(s.avgWinPct).toBeCloseTo(30, 6)
    expect(s.avgLossPct).toBeCloseTo(-10, 6)
    expect(s.winLossRatio).toBeCloseTo(3, 6)
    expect(s.profitFactor).toBeCloseTo(3, 6)
    expect(s.avgRiskSol).toBeCloseTo(0.005, 8)
  })
})
