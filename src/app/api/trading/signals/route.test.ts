import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

vi.mock('@/utils/unified-logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@/strategies/signals-pipeline', () => ({
  fetchAndScoreSignals: vi.fn(),
}))

vi.mock('@/strategies/load-mcap-tracker', () => ({
  getMergedMcapTrackerRegistry: vi.fn(),
}))

vi.mock('@/strategies/load-signals', () => ({
  getMergedSignalsRegistry: vi.fn(),
}))

vi.mock('@/strategies/signals-early-ml-gate', () => ({
  isEarlyEnterMlSoftGateEnabled: () => false,
}))

vi.mock('@/strategies/early-enter-noul-shadow', () => ({
  isEarlyEnterNoulShadowEnabled: () => false,
}))

vi.mock('@/strategies/signals-early-closed-loop', () => ({
  attachClosedLoopScoresToSignals: vi.fn(async (rows: unknown) => rows),
}))

vi.mock('@/strategies/signals-early-pattern-cache', () => ({
  getCachedStage1PatternScore: vi.fn(),
  scoreStage1PatternBatch: vi.fn(async () => new Map()),
}))

vi.mock('@/strategies/signals-early-alerts', () => ({
  attachPatternShadowToAlert: vi.fn(),
  emitSignalsEarlyAlertsFromScoredAsync: vi.fn(async () => []),
  shouldEmitSignalsEarlyAlert: (signal: {
    decision?: string
    mcap_growth_percent?: number
  }) => signal.decision === 'enter' && (signal.mcap_growth_percent ?? 0) < 100,
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/trading/signals/route'
import { getMergedMcapTrackerRegistry } from '@/strategies/load-mcap-tracker'
import { getMergedSignalsRegistry } from '@/strategies/load-signals'
import { emitSignalsEarlyAlertsFromScoredAsync } from '@/strategies/signals-early-alerts'
import { fetchAndScoreSignals } from '@/strategies/signals-pipeline'
import { buildSignalScoringItem } from '@/strategies/signals-scoring'
import type { ScoredSignal } from '@/strategies/signals-pipeline'
import { MCAP_TRACKER_STRATEGIES, SIGNALS_STRATEGIES } from '@/strategies/registry'
import type { SignalsStrategy } from '@/strategies/types'

function scored(
  overrides: Partial<ScoredSignal> & { token_address: string; mcap_growth_percent: number },
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
      overrides.first_seen_at ?? new Date(Date.now() - 20 * 60_000).toISOString(),
    last_updated_at: overrides.last_updated_at ?? new Date().toISOString(),
    when_reach_80pct:
      overrides.when_reach_80pct === undefined
        ? new Date(Date.now() - 10 * 60_000).toISOString()
        : overrides.when_reach_80pct,
    label: overrides.label ?? null,
    is_tracking_stuck: false,
    in_tracking_range: true,
  })
  return {
    ...item,
    score: 1,
    decision: 'skip',
    rationale: '',
  }
}

function chainRegistry<T extends { chain?: 'sol' | 'robinhood' }>(
  table: Record<string, T>,
  chain: 'sol' | 'robinhood',
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(table).filter(([, strategy]) => (strategy.chain ?? 'sol') === chain),
  )
}

beforeEach(() => {
  vi.mocked(fetchAndScoreSignals).mockReset()
  vi.mocked(emitSignalsEarlyAlertsFromScoredAsync).mockReset()
  vi.mocked(emitSignalsEarlyAlertsFromScoredAsync).mockResolvedValue([])
  vi.mocked(getMergedMcapTrackerRegistry).mockImplementation(async (chain = 'sol') =>
    chainRegistry(MCAP_TRACKER_STRATEGIES, chain),
  )
  vi.mocked(getMergedSignalsRegistry).mockImplementation(async (chain = 'sol') =>
    chainRegistry(SIGNALS_STRATEGIES, chain) as Record<string, SignalsStrategy>,
  )
})

function request(query: string) {
  return GET(new NextRequest(`http://localhost/api/trading/signals?${query}`))
}

describe('GET /api/trading/signals strategy list', () => {
  it('returns 400 for an unknown strategy before scoring', async () => {
    const response = await request('strategy=not_a_strategy')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ success: false })
    expect(fetchAndScoreSignals).not.toHaveBeenCalled()
  })

  it('treats strategy=default as signals_default', async () => {
    vi.mocked(fetchAndScoreSignals).mockResolvedValue([])
    const response = await request('strategy=default&chain=sol')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.params.strategy).toBe('signals_default')
    // Stub picker: all n=0 → strategy_id asc (PnL stats live on /strategies).
    expect(body.strategies.map((row: { strategyId: string }) => row.strategyId)).toEqual([
      'mcap_enter_at_80',
      'mcap_enter_first_seen',
      'signals_default',
      'signals_sell_over_100',
    ])
    expect(body.strategies.every((row: { n: number }) => row.n === 0)).toBe(true)
    expect(fetchAndScoreSignals).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'default', enterScoreFloor: 50 }),
      expect.objectContaining({ chain: 'sol', keepCandidatePool: true }),
    )
  })

  it('rejects sell over 100% on Robinhood and omits that option', async () => {
    const rejected = await request('strategy=signals_sell_over_100&chain=robinhood')
    expect(rejected.status).toBe(400)

    vi.mocked(fetchAndScoreSignals).mockResolvedValue([])
    const response = await request('strategy=signals_default_rh&chain=robinhood')
    const body = await response.json()
    const ids = body.strategies.map((row: { strategyId: string }) => row.strategyId)
    expect(ids).not.toContain('signals_sell_over_100')
    expect(ids).toEqual([
      'mcap_enter_at_80_rh',
      'mcap_enter_first_seen_rh',
      'signals_default_rh',
    ])
  })

  it('returns one mint with badges and does not let outcomes invent rows', async () => {
    const member = scored({ token_address: 'mint-member', mcap_growth_percent: 90 })
    const outsider = scored({
      token_address: 'mint-outsider',
      mcap_growth_percent: 4,
      first_mcap: 5_000,
      current_mcap: 5_200,
      when_reach_80pct: null,
    })
    vi.mocked(fetchAndScoreSignals).mockResolvedValue([member, outsider])

    const response = await request('strategy=signals_default&limit=30')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.signals).toHaveLength(1)
    expect(body.signals[0].token_address).toBe('mint-member')
    expect(body.signals[0].alsoMatches.map((badge: { strategyId: string }) => badge.strategyId)).not.toContain(
      'signals_default',
    )
    expect(
      body.signals[0].alsoMatches.map((badge: { name: string }) => badge.name),
    ).toEqual(expect.arrayContaining(['Enter at 80% milestone', 'Enter at first seen']))
    expect(body.signals.map((row: { token_address: string }) => row.token_address)).not.toContain(
      'mint-outsider',
    )

    const emitArg = vi.mocked(emitSignalsEarlyAlertsFromScoredAsync).mock.calls[0]?.[0] as
      | ScoredSignal[]
      | undefined
    expect(emitArg?.map((row) => row.token_address)).toEqual(['mint-member', 'mint-outsider'])
  })

  it('does not emit Early Enter when the selected strategy is mcap', async () => {
    vi.mocked(fetchAndScoreSignals).mockResolvedValue([
      scored({ token_address: 'mint-mcap', mcap_growth_percent: 90 }),
    ])
    const response = await request('strategy=mcap_enter_at_80')
    const body = await response.json()
    expect(body.signals).toHaveLength(1)
    expect(emitSignalsEarlyAlertsFromScoredAsync).not.toHaveBeenCalled()
    expect(body.strategies[0].strategyId).toBe('mcap_enter_at_80')
  })
})
