import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/gmgn-api', () => ({
  tokenKline: vi.fn(),
}))
vi.mock('@/utils/solanatracker-ohlc-limit', () => ({
  acquireSolanaTrackerOhlcSlot: vi.fn(async () => undefined),
}))
vi.mock('@/strategies/db', () => ({
  listStrategyOutcomes: vi.fn(),
}))
vi.mock('@/strategies/token-map-activity', () => ({
  fetchTokenMapActivity: vi.fn(),
}))
vi.mock('@/strategies/detect-snapshots', () => ({
  getLatestDetectSnapshot: vi.fn(async () => null),
}))
vi.mock('@/utils/redis-cache', () => ({
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => {}),
}))
vi.mock('@/strategies/sim-monitor-snapshots', () => ({
  fetchTrackerTokenMetrics: vi.fn(async () => null),
  fetchOutcomeMonitorPriceHistory: vi.fn(async () => []),
}))

import { listStrategyOutcomes } from '@/strategies/db'
import { fetchTokenMapActivity } from '@/strategies/token-map-activity'
import { tokenKline } from '@/utils/gmgn-api'
import { loadTokenMapChart } from '@/strategies/token-map-chart'
import { NEW_CHART_SPAN_SEC } from '@/strategies/token-map-chart-window'

const mint = 'ChartWin1111111111111111111111111111111'

beforeEach(() => {
  vi.stubEnv('MARKET_BRAIN_TOKEN', '')
  vi.stubEnv('MARKET_BRAIN_OHLC', '0')
  vi.stubEnv('SOLANATRACKER_DATA_API_BASE', '')
  vi.stubEnv('SOLANATRACKER_CHART_BASE', '')
  vi.mocked(listStrategyOutcomes).mockResolvedValue({
    rows: [],
    total: 0,
  } as never)
  vi.mocked(fetchTokenMapActivity).mockResolvedValue([])
  vi.mocked(tokenKline).mockReset()
})

describe('loadTokenMapChart window=auto', () => {
  it('short new window calls tokenKline once and skips 24h cache fill', async () => {
    const now = Math.floor(Date.now() / 1000)
    vi.mocked(fetchTokenMapActivity).mockResolvedValue([
      {
        id: 'social:1',
        domain: 'social',
        kind: 'mention',
        title: 'FOMO',
        detail: 'x',
        occurredAt: new Date((now - 120) * 1000).toISOString(),
        source: 'test',
      },
    ])
    vi.mocked(tokenKline).mockImplementation(async (params) => {
      const fromSec = Math.floor(Number(params.from) / 1000)
      const toSec = Math.floor(Number(params.to) / 1000)
      const span = toSec - fromSec
      expect(span).toBeLessThanOrEqual(NEW_CHART_SPAN_SEC + 5)
      expect(span).toBeGreaterThanOrEqual(NEW_CHART_SPAN_SEC - 5)
      return {
        list: [
          {
            time: (fromSec + 30) * 1000,
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
          },
        ],
      }
    })

    const result = await loadTokenMapChart({
      tokenAddress: mint,
      window: 'auto',
      chain: 'sol',
    })

    expect(result.chartWindow?.mode).toBe('new')
    expect(tokenKline).toHaveBeenCalledTimes(1)
    expect(result.candles.length).toBeGreaterThanOrEqual(1)
    expect(result.hours).toBeCloseTo(10 / 60, 2)
  })

  it('old window uses anchor span and may page beyond one kline call', async () => {
    const now = Math.floor(Date.now() / 1000)
    const anchor = now - 3 * 3600
    vi.mocked(listStrategyOutcomes).mockResolvedValue({
      rows: [
        {
          id: 'o1',
          domain: 'signals',
          strategy_id: 'signals_default',
          entry_at: new Date(anchor * 1000).toISOString(),
          exit_at: null,
          status: 'open',
          pnl_pct: null,
          is_simulated: true,
        },
      ],
      total: 1,
    } as never)
    vi.mocked(tokenKline).mockImplementation(async (params) => {
      const fromSec = Math.floor(Number(params.from) / 1000)
      return {
        list: Array.from({ length: 5 }, (_, i) => ({
          time: (fromSec + i * 60) * 1000,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
        })),
      }
    })

    const result = await loadTokenMapChart({
      tokenAddress: mint,
      window: 'auto',
      chain: 'sol',
    })

    expect(result.chartWindow?.mode).toBe('old')
    expect(result.chartWindow?.timeFrom).toBe(anchor)
    expect(result.hours).toBeCloseTo(3, 1)
  })
})
