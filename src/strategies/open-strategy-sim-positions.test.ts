import { describe, expect, it } from 'vitest'
import {
  getOpenStrategySimPositions,
  shouldClosePriceSimPosition,
  shouldCloseSignalsClExit,
} from './open-strategy-sim-positions'
import type { TrackingRecord } from '@/utils/trading-tracker'

const exit = { stopLossPct: -30, takeProfitPct: 60, maxHoldHours: 24 }
const t0 = Date.parse('2026-09-01T00:00:00Z')

describe('shouldClosePriceSimPosition', () => {
  it('holds while inside SL/TP and under max hold', () => {
    const d = shouldClosePriceSimPosition({
      entryPriceUsd: 1,
      currentPriceUsd: 1.2,
      entryAt: new Date(t0).toISOString(),
      exit,
      nowMs: t0 + 60 * 60 * 1000,
    })
    expect(d.close).toBe(false)
    expect(d.reason).toBe('hold')
    expect(d.pnlPct).toBeCloseTo(20, 6)
  })

  it('closes on stop loss, take profit and max hold', () => {
    const base = { entryPriceUsd: 1, entryAt: new Date(t0).toISOString(), exit }
    expect(shouldClosePriceSimPosition({ ...base, currentPriceUsd: 0.6, nowMs: t0 }).reason).toBe('stop_loss')
    expect(shouldClosePriceSimPosition({ ...base, currentPriceUsd: 1.7, nowMs: t0 }).reason).toBe('take_profit')
    expect(
      shouldClosePriceSimPosition({ ...base, currentPriceUsd: 1.1, nowMs: t0 + 25 * 60 * 60 * 1000 }).reason,
    ).toBe('max_hold')
  })

  it('never closes on a missing price', () => {
    const d = shouldClosePriceSimPosition({ entryPriceUsd: 1, currentPriceUsd: 0, entryAt: null, exit })
    expect(d).toEqual({ close: false, reason: 'missing_price', pnlPct: null })
  })
})

describe('shouldCloseSignalsClExit', () => {
  const base = {
    exit,
    entryAt: new Date(t0).toISOString(),
    entryPriceUsd: 1,
    currentPriceUsd: 1.1,
    nowMs: t0 + 60 * 60 * 1000,
  }

  it('prefers mcap growth for TP/SL/maxHold', () => {
    expect(
      shouldCloseSignalsClExit({
        ...base,
        entryMcap: 100,
        currentMcap: 65,
      }).reason,
    ).toBe('stop_loss')
    expect(
      shouldCloseSignalsClExit({
        ...base,
        entryMcap: 100,
        currentMcap: 170,
      }).reason,
    ).toBe('take_profit')
    expect(
      shouldCloseSignalsClExit({
        ...base,
        entryMcap: 100,
        currentMcap: 110,
        nowMs: t0 + 25 * 60 * 60 * 1000,
      }).reason,
    ).toBe('max_hold')
  })

  it('holds when mcap growth is inside thresholds', () => {
    const d = shouldCloseSignalsClExit({
      ...base,
      entryMcap: 100,
      currentMcap: 120,
    })
    expect(d.close).toBe(false)
    expect(d.reason).toBe('hold')
    expect(d.pnlPct).toBeCloseTo(20, 6)
  })

  it('falls back to price PnL when mcap missing', () => {
    expect(
      shouldCloseSignalsClExit({
        ...base,
        entryMcap: null,
        currentMcap: null,
        currentPriceUsd: 0.6,
      }).reason,
    ).toBe('stop_loss')
    expect(
      shouldCloseSignalsClExit({
        ...base,
        entryMcap: 100,
        currentMcap: null,
        currentPriceUsd: 1.7,
      }).reason,
    ).toBe('take_profit')
  })
})

describe('getOpenStrategySimPositions', () => {
  it('falls back to entry_features.initial_price_usd when entry_price_usd is absent', () => {
    const buy = {
      id: 'b1',
      walletAddress: 'w',
      operationType: 'buy',
      timestamp: t0,
      successCount: 1,
      failureCount: 0,
      totalTokens: 1,
      solAmount: 1,
      is_simulation: true,
      simulation_type: 'strategy',
      bot_strategy: 's1',
      tokens: [{ mintAddress: 'M', symbol: 'M', tokenAmount: 10, solAmount: 1, priceUsd: 0.5, solPrice: 100 }],
      trading_simulation: {
        entry_at: new Date(t0).toISOString(),
        entry_features: { initial_price_usd: 0.42 },
        effective_exit: { stopLossPct: -40, takeProfitPct: 80, maxHoldHours: 12 },
      },
    } as unknown as TrackingRecord
    const open = getOpenStrategySimPositions([buy], 's1')
    expect(open).toHaveLength(1)
    expect(open[0].entryPriceUsd).toBe(0.42)
    expect(open[0].effectiveExit).toEqual({
      stopLossPct: -40,
      takeProfitPct: 80,
      maxHoldHours: 12,
    })
    expect(getOpenStrategySimPositions([buy], 'other')).toHaveLength(0)
  })
})
