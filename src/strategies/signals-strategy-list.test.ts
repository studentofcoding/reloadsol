import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { getMcapSimOpenSkipReason } from '@/utils/mcap-sim-track'
import {
  SOL_SIGNALS_LIST_STRATEGY_IDS,
  RH_SIGNALS_LIST_STRATEGY_IDS,
} from '@/utils/signals-strategy-id'
import { qualifyBestStrategies } from './best-strategies-rank'
import { MCAP_TRACKER_STRATEGIES } from './registry'
import { buildSignalScoringItem } from './signals-scoring'
import type { ScoredSignal } from './signals-pipeline'
import {
  buildSignalsListStrategyConfig,
  projectSignalsStrategyList,
  rankSignalsListStrategies,
  resolveSignalsListQueryStrategy,
  signalsListUniverse,
  type SignalsListPnlRow,
} from './signals-strategy-list'
import type { StrategyReportBreakdown } from './types'

const scoreConfig = buildSignalsListStrategyConfig('default', {
  limit: 30,
  recencyMinutes: 240,
  minGrowth: 0,
  holdGrowthFloor: 10,
  includeStuck: false,
  maxAgeMinutes: 2880,
})

function pnl(
  strategyId: string,
  domain: 'signals' | 'mcap_tracker',
  avg: number,
  n: number,
  total = avg * n,
  isSimulated = true,
): SignalsListPnlRow {
  return {
    strategy_id: strategyId,
    domain,
    is_simulated: isSimulated,
    trade_count: n,
    avg_pnl_pct: avg,
    total_pnl_pct: total,
  }
}

function candidate(
  overrides: Partial<ScoredSignal> & {
    token_address: string
    mcap_growth_percent: number
  },
): ScoredSignal {
  const growth = overrides.mcap_growth_percent
  const first = overrides.first_mcap ?? 100_000
  const item = buildSignalScoringItem({
    token_address: overrides.token_address,
    token_symbol: overrides.token_symbol ?? 'TEST',
    first_mcap: first,
    current_mcap: overrides.current_mcap ?? first * (1 + growth / 100),
    mcap_growth_percent: growth,
    first_seen_at:
      overrides.first_seen_at ?? new Date(Date.now() - 30 * 60_000).toISOString(),
    last_updated_at: overrides.last_updated_at ?? new Date().toISOString(),
    when_reach_80pct: overrides.when_reach_80pct ?? null,
    when_reach_120pct: overrides.when_reach_120pct ?? null,
    when_reach_200pct: overrides.when_reach_200pct ?? null,
    when_drop_40pct: overrides.when_drop_40pct ?? null,
    when_drop_80pct: overrides.when_drop_80pct ?? null,
    label: overrides.label ?? null,
    is_tracking_stuck: overrides.is_tracking_stuck ?? false,
    in_tracking_range: overrides.in_tracking_range ?? true,
  })
  return {
    ...item,
    score: overrides.score ?? 0,
    decision: overrides.decision ?? 'skip',
    rationale: overrides.rationale ?? '',
    organic_score: overrides.organic_score,
    top_holders_pct: overrides.top_holders_pct,
  }
}

function project(
  partial: Partial<Parameters<typeof projectSignalsStrategyList>[0]> & {
    selectedId: string
    pool: ScoredSignal[]
  },
) {
  return projectSignalsStrategyList({
    chain: 'sol',
    limit: 30,
    scoreConfig,
    mcapById: MCAP_TRACKER_STRATEGIES,
    breakdown: [],
    ...partial,
  })
}

const recent80 = new Date(Date.now() - 20 * 60_000).toISOString()
const stale80 = new Date(Date.now() - 13 * 60 * 60_000).toISOString()

function hotMint(address = 'mint-hot'): ScoredSignal {
  return candidate({
    token_address: address,
    mcap_growth_percent: 120,
    when_reach_80pct: recent80,
  })
}

describe('rankSignalsListStrategies', () => {
  it('orders the sol universe by raw avg, then sum, and keeps n=0 ids', () => {
    const ranked = rankSignalsListStrategies('sol', [
      pnl('signals_sell_over_100', 'signals', 359, 38),
      pnl('mcap_enter_at_80', 'mcap_tracker', 18, 40),
      pnl('mcap_enter_first_seen', 'mcap_tracker', 16, 35),
      pnl('signals_default', 'signals', 0, 0),
    ])
    expect(ranked.map((row) => row.strategyId)).toEqual([
      'signals_sell_over_100',
      'mcap_enter_at_80',
      'mcap_enter_first_seen',
      'signals_default',
    ])
    expect(ranked[0]).toMatchObject({ avgPnlPct: 359, totalPnlPct: 359 * 38, n: 38 })
    expect(ranked[3]).toMatchObject({ avgPnlPct: null, totalPnlPct: null, n: 0 })
    expect(ranked.map((row) => row.name)).toEqual([
      'Sell over 100%',
      'Enter at 80% milestone',
      'Enter at first seen',
      'Default momentum',
    ])
  })

  it('puts tiny-n Sell over 100% first and leaves qualifyBestStrategies floored', () => {
    const breakdown = [
      pnl('signals_sell_over_100', 'signals', 500, 6),
      pnl('mcap_enter_at_80', 'mcap_tracker', 18, 40),
      pnl('mcap_enter_first_seen', 'mcap_tracker', 16, 35),
    ]
    const ranked = rankSignalsListStrategies('sol', breakdown)
    expect(ranked[0]?.strategyId).toBe('signals_sell_over_100')
    expect(ranked.map((row) => row.strategyId)).not.toContain('signals_sell_over_100_rh')

    const board = qualifyBestStrategies({
      allTime: breakdown.map(
        (row): StrategyReportBreakdown => ({
          strategy_id: row.strategy_id,
          domain: row.domain === 'mcap_tracker' ? 'mcap_tracker' : 'signals',
          is_simulated: true,
          trade_count: row.trade_count,
          win_count: row.trade_count,
          loss_count: 0,
          win_rate: 1,
          avg_pnl_pct: row.avg_pnl_pct,
          median_pnl_pct: row.avg_pnl_pct,
          total_pnl_pct: row.total_pnl_pct,
          last_exit_at: null,
        }),
      ),
      week: [],
      topN: 5,
    })
    expect(board.ranked.map((row) => row.strategy_id)).not.toContain('signals_sell_over_100')
    expect(
      board.hypothesis.some((row) => row.strategy_id === 'signals_sell_over_100'),
    ).toBe(true)
  })

  it('breaks avg ties by sum, then strategy id', () => {
    const bySum = rankSignalsListStrategies('sol', [
      pnl('signals_default', 'signals', 10, 4, 100),
      pnl('signals_sell_over_100', 'signals', 10, 4, 400),
      pnl('mcap_enter_at_80', 'mcap_tracker', 10, 4, 400),
      pnl('mcap_enter_first_seen', 'mcap_tracker', 10, 4, 100),
    ])
    expect(bySum.map((row) => row.strategyId)).toEqual([
      'mcap_enter_at_80',
      'signals_sell_over_100',
      'mcap_enter_first_seen',
      'signals_default',
    ])

    const byId = rankSignalsListStrategies('sol', [
      pnl('signals_sell_over_100', 'signals', 5, 3, 15),
      pnl('signals_default', 'signals', 5, 3, 15),
      pnl('mcap_enter_first_seen', 'mcap_tracker', 5, 3, 15),
      pnl('mcap_enter_at_80', 'mcap_tracker', 5, 3, 15),
    ])
    expect(byId.map((row) => row.strategyId)).toEqual([
      'mcap_enter_at_80',
      'mcap_enter_first_seen',
      'signals_default',
      'signals_sell_over_100',
    ])
  })

  it('ranks a negative sample ahead of a zero-fill 0%', () => {
    const ranked = rankSignalsListStrategies('sol', [
      pnl('signals_default', 'signals', 0, 0),
      pnl('mcap_enter_at_80', 'mcap_tracker', -5, 10, -50),
    ])
    expect(ranked[0]).toMatchObject({
      strategyId: 'mcap_enter_at_80',
      avgPnlPct: -5,
      n: 10,
    })
    expect(ranked.find((row) => row.strategyId === 'signals_default')).toMatchObject({
      avgPnlPct: null,
      n: 0,
    })
  })

  it('ignores live rows and a sell-over-100 id on Robinhood', () => {
    const ranked = rankSignalsListStrategies('robinhood', [
      pnl('signals_sell_over_100', 'signals', 999, 40),
      pnl('signals_default_rh', 'signals', 9999, 4, 39996, false),
      pnl('mcap_enter_at_80_rh', 'mcap_tracker', 3, 2),
    ])
    expect(ranked.map((row) => row.strategyId)).toEqual([
      'mcap_enter_at_80_rh',
      'mcap_enter_first_seen_rh',
      'signals_default_rh',
    ])
    expect(ranked.map((row) => row.strategyId)).not.toContain('signals_sell_over_100')
    expect(ranked.find((row) => row.strategyId === 'signals_default_rh')?.n).toBe(0)
  })

  it('matches the closed id sets', () => {
    expect(signalsListUniverse('sol').map((entry) => entry.strategyId)).toEqual([
      ...SOL_SIGNALS_LIST_STRATEGY_IDS,
    ])
    expect(signalsListUniverse('robinhood').map((entry) => entry.strategyId)).toEqual([
      ...RH_SIGNALS_LIST_STRATEGY_IDS,
    ])
  })
})

describe('resolveSignalsListQueryStrategy', () => {
  it('maps legacy templates and rejects unknown ids', () => {
    expect(resolveSignalsListQueryStrategy('default', 'sol')).toEqual({
      ok: true,
      strategyId: 'signals_default',
    })
    expect(resolveSignalsListQueryStrategy('sell_over_100', 'sol')).toEqual({
      ok: true,
      strategyId: 'signals_sell_over_100',
    })
    expect(resolveSignalsListQueryStrategy(null, 'sol')).toEqual({
      ok: true,
      strategyId: 'signals_default',
    })
    expect(resolveSignalsListQueryStrategy('not_a_strategy', 'sol').ok).toBe(false)
    expect(resolveSignalsListQueryStrategy('sell_over_100', 'robinhood').ok).toBe(false)
    expect(resolveSignalsListQueryStrategy('signals_sell_over_100', 'robinhood').ok).toBe(false)
    expect(resolveSignalsListQueryStrategy('signals_default_rh', 'robinhood')).toEqual({
      ok: true,
      strategyId: 'signals_default_rh',
    })
  })
})

describe('projectSignalsStrategyList', () => {
  const orderBreakdown = [
    pnl('mcap_enter_at_80', 'mcap_tracker', 18, 40),
    pnl('mcap_enter_first_seen', 'mcap_tracker', 16, 35),
    pnl('signals_default', 'signals', 4, 12),
  ]

  it('omits a 120% mint from Sell over 100% and badges the other matches once', () => {
    const absent = project({
      selectedId: 'signals_sell_over_100',
      pool: [hotMint()],
      breakdown: orderBreakdown,
    })
    expect(absent.signals).toEqual([])

    const onDefault = project({
      selectedId: 'signals_default',
      pool: [hotMint(), hotMint()],
      breakdown: orderBreakdown,
    })
    expect(onDefault.signals).toHaveLength(1)
    expect(onDefault.signals[0]?.alsoMatches.map((badge) => badge.name)).toEqual([
      'Enter at 80% milestone',
      'Enter at first seen',
    ])
    expect(onDefault.signals[0]?.alsoMatches.map((badge) => badge.strategyId)).not.toContain(
      'signals_default',
    )
    expect(onDefault.signals[0]?.alsoMatches.map((badge) => badge.strategyId)).not.toContain(
      'signals_sell_over_100',
    )

    const onAt80 = project({
      selectedId: 'mcap_enter_at_80',
      pool: [hotMint()],
      breakdown: orderBreakdown,
    })
    expect(onAt80.signals).toHaveLength(1)
    expect(onAt80.signals[0]?.alsoMatches.map((badge) => badge.name)).toEqual([
      'Enter at first seen',
      'Default momentum',
    ])
    expect(onAt80.signals[0]?.token_address).toBe('mint-hot')
  })

  it('badges Default and first seen when at_80 misses a fresh 90% mint', () => {
    const row = candidate({
      token_address: 'mint-90',
      mcap_growth_percent: 90,
      when_reach_80pct: stale80,
    })
    const listed = project({
      selectedId: 'signals_sell_over_100',
      pool: [row],
      breakdown: [
        pnl('signals_default', 'signals', 20, 10),
        pnl('mcap_enter_first_seen', 'mcap_tracker', 16, 35),
      ],
    })
    expect(listed.signals).toHaveLength(1)
    expect(listed.signals[0]?.alsoMatches.map((badge) => badge.name)).toEqual([
      'Default momentum',
      'Enter at first seen',
    ])
    expect(listed.signals[0]?.alsoMatches.map((badge) => badge.strategyId)).not.toContain(
      'mcap_enter_at_80',
    )
    expect(listed.signals[0]?.alsoMatches.map((badge) => badge.strategyId)).not.toContain(
      'signals_sell_over_100',
    )
  })

  it('drops a Default skip when nothing else matches', () => {
    // As-built scorer holds growth 40 at minGrowth 0 (hold floor 10). Skip is below that floor.
    const row = candidate({
      token_address: 'mint-skip',
      mcap_growth_percent: 4,
      first_mcap: 5_000,
      current_mcap: 5_200,
    })
    const listed = project({ selectedId: 'signals_default', pool: [row] })
    expect(listed.signals).toEqual([])
  })

  it('keeps a first-seen mint when paper would say already_closed', () => {
    const row = candidate({
      token_address: 'mint-closed',
      mcap_growth_percent: 20,
      when_reach_80pct: null,
    })
    const strategy = MCAP_TRACKER_STRATEGIES.mcap_enter_first_seen
    expect(
      getMcapSimOpenSkipReason(strategy, {
        token_address: row.token_address,
        token_symbol: row.token_symbol,
        first_mcap: row.first_mcap,
        current_mcap: row.current_mcap,
        first_seen_at: row.first_seen_at,
        last_updated_at: row.last_updated_at,
        mcap_growth_percent: row.mcap_growth_percent,
      }, new Set(), new Set([row.token_address])),
    ).toBe('already_closed')

    const listed = project({
      selectedId: 'mcap_enter_first_seen',
      pool: [row],
    })
    expect(listed.signals.map((signal) => signal.token_address)).toEqual(['mint-closed'])
  })

  it('drops a rugged mint from first seen', () => {
    const listed = project({
      selectedId: 'mcap_enter_first_seen',
      pool: [
        candidate({
          token_address: 'mint-rug',
          mcap_growth_percent: 20,
          label: 'rugged',
        }),
      ],
    })
    expect(listed.signals).toEqual([])
  })

  it('does not list a mint just because the strategy has closed pnl', () => {
    const listed = project({
      selectedId: 'signals_default',
      pool: [],
      breakdown: [pnl('signals_default', 'signals', 500, 6)],
    })
    expect(listed.signals).toEqual([])
    expect(listed.strategies[0]?.strategyId).toBe('signals_default')
  })

  it('sorts mcap members by growth then address and does not let display score remove them', () => {
    const low = candidate({
      token_address: 'mint-b',
      mcap_growth_percent: 4,
      token_symbol: 'LOW',
    })
    const high = candidate({
      token_address: 'mint-a',
      mcap_growth_percent: 12,
      token_symbol: 'HIGH',
    })
    const listed = project({
      selectedId: 'mcap_enter_first_seen',
      pool: [low, high],
      limit: 10,
    })
    expect(listed.signals.map((signal) => signal.token_address)).toEqual(['mint-a', 'mint-b'])
    expect(listed.signals[1]?.decision).toBe('skip')
  })

  it('applies limit to members', () => {
    const listed = project({
      selectedId: 'mcap_enter_first_seen',
      limit: 1,
      pool: [
        candidate({ token_address: 'mint-z', mcap_growth_percent: 15 }),
        candidate({ token_address: 'mint-a', mcap_growth_percent: 40 }),
      ],
    })
    expect(listed.signals.map((signal) => signal.token_address)).toEqual(['mint-a'])
  })
})

describe('signals strategy list guards', () => {
  const helperSrc = readFileSync(
    path.join(process.cwd(), 'src/strategies/signals-strategy-list.ts'),
    'utf8',
  )
  const tabSrc = readFileSync(
    path.join(process.cwd(), 'src/components/signals/SignalsTab.tsx'),
    'utf8',
  )
  const noulSrc = readFileSync(
    path.join(process.cwd(), 'src/strategies/early-enter-noul-shadow.ts'),
    'utf8',
  )

  it('does not import floors, soft gate, or Noul', () => {
    expect(helperSrc).not.toMatch(/best-strategies-rank/)
    expect(helperSrc).not.toMatch(/qualifyBestStrategies/)
    expect(helperSrc).not.toMatch(/passesEarlyEnterMlSoftGate/)
    expect(helperSrc).not.toMatch(/early-enter-noul-shadow/)
    expect(helperSrc).not.toMatch(/isEarlyEnterNoulSoftActiveEnabled/)
  })

  it('leaves floating-chart Buy, RowTradePanel, and soft-active default off', () => {
    expect(tabSrc).toContain('rowMarketSwap')
    expect(tabSrc).toContain('RowTradePanel')
    expect(tabSrc).toContain('floatingChartSolBuyLeg')
    expect(tabSrc).toContain('readSignalsListStrategyId')
    expect(tabSrc).toContain('writeSignalsListStrategyId')
    expect(tabSrc).toContain('alsoMatches')
    expect(tabSrc).not.toContain('qualifyBestStrategies')
    expect(tabSrc).not.toContain('algo-tester')
    expect(tabSrc).not.toContain('signals_active_strategy')
    expect(tabSrc).not.toContain('readSignalsStrategyTemplate')
    expect(noulSrc).toMatch(/parseOnOffEnv\(env\.EARLY_ENTER_NOUL_SOFT_ACTIVE,\s*false\)/)
  })
})
