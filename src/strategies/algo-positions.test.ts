import { describe, expect, it } from 'vitest'
import {
  mapDlmmPositionToAlgoPosition,
  mapMcapOpenToAlgoPosition,
  mapOutcomeToAlgoPosition,
  mapTrackerRowToAlgoPosition,
  mapWalletOpenToAlgoPosition,
  type TrackerOpenRow,
} from '@/strategies/algo-positions'
import type { DlmmPosition } from '@/types/dlmm'
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

  it('maps mcap_tracker closed outcome with entry/exit mcap not price', () => {
    const row: StrategyOutcomeRow = {
      id: 'o3',
      strategy_id: 'mcap_enter_at_80',
      domain: 'mcap_tracker',
      token_address: 'Mint333',
      entry_at: '2026-07-01T00:00:00.000Z',
      exit_at: '2026-07-01T02:00:00.000Z',
      pnl_pct: 25,
      status: 'won',
      is_simulated: true,
      features: {
        token_symbol: 'PEPE',
        entry_mcap: 50000,
        exit_mcap: 62500,
      },
      created_at: '2026-07-01T02:00:00.000Z',
    }

    const pos = mapOutcomeToAlgoPosition(row, names)
    expect(pos.domain).toBe('mcap_tracker')
    expect(pos.entryMcap).toBe(50000)
    expect(pos.exitMcap).toBe(62500)
    expect(pos.entryPriceUsd).toBeNull()
    expect(pos.exitPriceUsd).toBeNull()
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

describe('mapMcapOpenToAlgoPosition', () => {
  it('uses entryMcap from sim position, not initial_price_usd', () => {
    const pos = mapMcapOpenToAlgoPosition(
      {
        mintAddress: 'Mint444',
        symbol: 'BONK',
        entryAt: '2026-07-03T00:00:00.000Z',
        entryMcap: 84000,
        entryTemplate: 'first_seen',
        entryFeatures: {},
        effectiveExit: null,
      },
      'mcap_first_seen',
      new Map([['mcap_first_seen', 'Enter at first seen']]),
    )

    expect(pos.domain).toBe('mcap_tracker')
    expect(pos.entryMcap).toBe(84000)
    expect(pos.entryPriceUsd).toBeNull()
    expect(pos.strategyName).toBe('Enter at first seen')
  })
})

describe('mapWalletOpenToAlgoPosition', () => {
  it('maps signals/gmgn/social open with entry price and domain', () => {
    const names = new Map([['signals_alpha', 'Signals Alpha']])
    const pos = mapWalletOpenToAlgoPosition(
      {
        mintAddress: 'Mint555',
        symbol: 'SIG',
        entryAt: '2026-07-04T00:00:00.000Z',
        entryPriceUsd: 0.00012,
      },
      'signals_alpha',
      'signals',
      names,
    )
    expect(pos.domain).toBe('signals')
    expect(pos.status).toBe('open')
    expect(pos.isSimulated).toBe(true)
    expect(pos.entryPriceUsd).toBeCloseTo(0.00012)
    expect(pos.entryAt).toBe('2026-07-04T00:00:00.000Z')
    expect(pos.strategyName).toBe('Signals Alpha')
  })
})

describe('mapDlmmPositionToAlgoPosition', () => {
  it('maps open dlmm position from created_at and pool name', () => {
    const p = {
      id: 'd1',
      pool_address: 'Pool111',
      pool_name: 'SOL/USDC',
      position_pubkey: null,
      token_x_symbol: 'SOL',
      token_y_symbol: 'USDC',
      amount_sol: 1,
      min_bin_id: null,
      max_bin_id: null,
      entry_value_usd: 150,
      current_value_usd: 160,
      fees_earned_usd: 1,
      pnl_pct: 6.6,
      status: 'open',
      is_muted: false,
      oor_since: null,
      take_profit_pct: 50,
      stop_loss_pct: -20,
      oor_timeout_min: 30,
      last_decision: null,
      last_decision_reason: null,
      last_decision_at: null,
      tx_signature: null,
      created_at: '2026-07-05T00:00:00.000Z',
      updated_at: '2026-07-05T00:00:00.000Z',
      closed_at: null,
    } as DlmmPosition

    const pos = mapDlmmPositionToAlgoPosition(
      p,
      new Map([['dlmm_default', 'DLMM Default']]),
    )
    expect(pos).not.toBeNull()
    expect(pos!.domain).toBe('dlmm')
    expect(pos!.strategyId).toBe('dlmm_default')
    expect(pos!.tokenSymbol).toBe('SOL/USDC')
    expect(pos!.entryPriceUsd).toBe(150)
    expect(pos!.entryAt).toBe('2026-07-05T00:00:00.000Z')
    expect(pos!.pnlPct).toBeCloseTo(6.6)
  })

  it('returns null for closed dlmm rows', () => {
    const p = {
      id: 'd2',
      status: 'closed',
      pool_name: 'X',
      token_x_symbol: 'X',
      token_y_symbol: 'Y',
      entry_value_usd: 0,
      pnl_pct: 0,
      created_at: '2026-07-05T00:00:00.000Z',
    } as DlmmPosition
    expect(mapDlmmPositionToAlgoPosition(p, new Map())).toBeNull()
  })
})
