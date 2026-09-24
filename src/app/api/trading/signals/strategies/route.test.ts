import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

vi.mock('@/strategies/signals-list-pnl', () => ({
  aggregateSignalsListPnl: vi.fn(),
}))

vi.mock('@/strategies/load-mcap-tracker', () => ({
  getMergedMcapTrackerRegistry: vi.fn(async () => ({})),
}))

vi.mock('@/strategies/load-signals', () => ({
  getMergedSignalsRegistry: vi.fn(async () => ({})),
}))

vi.mock('@/utils/redis-cache', () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => {}),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/trading/signals/strategies/route'
import { aggregateSignalsListPnl } from '@/strategies/signals-list-pnl'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

beforeEach(() => {
  vi.mocked(aggregateSignalsListPnl).mockReset()
  vi.mocked(cacheGet).mockResolvedValue(null)
  vi.mocked(cacheSet).mockClear()
})

describe('GET /api/trading/signals/strategies', () => {
  it('returns ranked picker options from lean PnL', async () => {
    vi.mocked(aggregateSignalsListPnl).mockResolvedValue([
      {
        strategy_id: 'signals_sell_over_100',
        domain: 'signals',
        is_simulated: true,
        trade_count: 10,
        avg_pnl_pct: 100,
        total_pnl_pct: 1000,
      },
      {
        strategy_id: 'mcap_enter_first_seen',
        domain: 'mcap_tracker',
        is_simulated: true,
        trade_count: 5,
        avg_pnl_pct: 50,
        total_pnl_pct: 250,
      },
    ])

    const res = await GET(
      new NextRequest('http://localhost/api/trading/signals/strategies?chain=sol'),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.strategies[0]).toMatchObject({
      strategyId: 'signals_sell_over_100',
      n: 10,
      avgPnlPct: 100,
    })
    expect(body.strategies.some((s: { strategyId: string }) => s.strategyId === 'signals_default')).toBe(
      true,
    )
    expect(cacheSet).toHaveBeenCalled()
  })

  it('serves Redis cache when warm', async () => {
    vi.mocked(cacheGet).mockResolvedValue({
      success: true,
      strategies: [
        {
          strategyId: 'signals_default',
          name: 'Default momentum',
          domain: 'signals',
          avgPnlPct: null,
          totalPnlPct: null,
          n: 0,
        },
      ],
    })
    const res = await GET(
      new NextRequest('http://localhost/api/trading/signals/strategies?chain=sol'),
    )
    expect(await res.json()).toMatchObject({ success: true })
    expect(aggregateSignalsListPnl).not.toHaveBeenCalled()
  })
})
