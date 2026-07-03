import { describe, expect, it } from 'vitest'
import {
  mapOutcomeToAlgoPosition,
  mapTrackerRowToAlgoPosition,
  type TrackerOpenRow,
} from '@/strategies/algo-positions'
import type { StrategyOutcomeRow } from '@/strategies/types'

const names = new Map([['att', 'Aggressive Trending']])

describe('mapOutcomeToAlgoPosition', () => {
  it('maps a closed outcome with strategy name, sim flag, prices', () => {
    const row: StrategyOutcomeRow = {
      id: 'o1',
      strategy_id: 'att',
      domain: 'trending_bot',
      token_address: 'Mint111',
      entry_at: '2026-07-01T00:00:00.000Z',
      exit_at: '2026-07-01T01:00:00.000Z',
      pnl_pct: 12.5,
      status: 'won',
      is_simulated: true,
      features: {
        token_symbol: 'RTM',
        initial_price_usd: 0.002404,
        exit_price_usd: 0.0027,
      },
      created_at: '2026-07-01T01:00:00.000Z',
    }

    const pos = mapOutcomeToAlgoPosition(row, names)
    expect(pos.status).toBe('closed')
    expect(pos.strategyName).toBe('Aggressive Trending')
    expect(pos.isSimulated).toBe(true)
    expect(pos.outcome).toBe('won')
    expect(pos.tokenSymbol).toBe('RTM')
    expect(pos.entryPriceUsd).toBeCloseTo(0.002404)
    expect(pos.exitPriceUsd).toBeCloseTo(0.0027)
    expect(pos.pnlPct).toBe(12.5)
  })

  it('falls back to strategy id when name unknown and handles missing features', () => {
    const row: StrategyOutcomeRow = {
      id: 'o2',
      strategy_id: 'mystery',
      domain: 'signals',
      token_address: null,
      entry_at: null,
      exit_at: null,
      pnl_pct: null,
      status: null,
      is_simulated: false,
      features: null,
      created_at: '2026-07-01T00:00:00.000Z',
    }

    const pos = mapOutcomeToAlgoPosition(row, names)
    expect(pos.strategyName).toBe('mystery')
    expect(pos.isSimulated).toBe(false)
    expect(pos.entryPriceUsd).toBeNull()
    expect(pos.tokenSymbol).toBeNull()
  })
})

describe('mapTrackerRowToAlgoPosition', () => {
  const baseRow: TrackerOpenRow = {
    id: 't1',
    token_address: 'Mint222',
    token_symbol: 'DOG',
    token_name: 'Dog Token',
    logo_url: 'https://img/dog.png',
    initial_price_usd: '0.001',
    current_gain_percentage: '4.2',
    status: 'tracking',
    tracking_started_at: '2026-07-02T00:00:00.000Z',
    trading_simulation: {
      current_status: 'holding',
      is_simulated: true,
      remaining_token_amount: '100',
      initial_token_amount: '100',
      buy_operation: { bot_strategy: 'att' },
    },
  }

  it('maps an open tracker position with token details', () => {
    const pos = mapTrackerRowToAlgoPosition(baseRow, names)
    expect(pos).not.toBeNull()
    expect(pos!.status).toBe('open')
    expect(pos!.strategyId).toBe('att')
    expect(pos!.strategyName).toBe('Aggressive Trending')
    expect(pos!.isSimulated).toBe(true)
    expect(pos!.tokenSymbol).toBe('DOG')
    expect(pos!.logoUrl).toBe('https://img/dog.png')
    expect(pos!.entryPriceUsd).toBeCloseTo(0.001)
    expect(pos!.pnlPct).toBeCloseTo(4.2)
  })

  it('returns null for non-holding rows', () => {
    const closedRow: TrackerOpenRow = {
      ...baseRow,
      trading_simulation: {
        ...baseRow.trading_simulation!,
        current_status: 'sold',
      },
    }
    expect(mapTrackerRowToAlgoPosition(closedRow, names)).toBeNull()
  })
})
