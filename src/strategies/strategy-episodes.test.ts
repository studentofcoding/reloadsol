import { describe, expect, it, vi } from 'vitest'
import {
  computeEpisodeWindow,
  isIdempotentWindowEnd,
} from '@/strategies/strategy-episodes'

describe('computeEpisodeWindow', () => {
  const now = Date.parse('2026-07-20T12:00:00.000Z')

  it('uses earliest entry minus 2h and latest exit', () => {
    const w = computeEpisodeWindow(
      [
        {
          entry_at: '2026-07-20T08:00:00.000Z',
          exit_at: '2026-07-20T10:00:00.000Z',
        },
        {
          entry_at: '2026-07-20T09:00:00.000Z',
          exit_at: '2026-07-20T11:00:00.000Z',
        },
      ],
      now,
    )
    expect(w).not.toBeNull()
    expect(w!.windowEndIso).toBe('2026-07-20T11:00:00.000Z')
    expect(w!.windowStartIso).toBe('2026-07-20T06:00:00.000Z')
  })

  it('clamps span to 48h before window_end', () => {
    const w = computeEpisodeWindow(
      [
        {
          entry_at: '2026-07-17T00:00:00.000Z',
          exit_at: '2026-07-20T12:00:00.000Z',
        },
      ],
      now,
    )
    expect(w).not.toBeNull()
    expect(w!.windowEndIso).toBe('2026-07-20T12:00:00.000Z')
    expect(w!.windowStartIso).toBe('2026-07-18T12:00:00.000Z')
  })

  it('returns null when no recent outcomes', () => {
    const w = computeEpisodeWindow(
      [
        {
          entry_at: '2026-01-01T00:00:00.000Z',
          exit_at: '2026-01-02T00:00:00.000Z',
        },
      ],
      now,
    )
    expect(w).toBeNull()
  })
})

describe('isIdempotentWindowEnd', () => {
  it('is true within 60s', () => {
    expect(
      isIdempotentWindowEnd(
        '2026-07-20T12:00:00.000Z',
        '2026-07-20T12:00:30.000Z',
      ),
    ).toBe(true)
  })

  it('is false beyond 60s', () => {
    expect(
      isIdempotentWindowEnd(
        '2026-07-20T12:00:00.000Z',
        '2026-07-20T12:02:00.000Z',
      ),
    ).toBe(false)
  })
})

describe('finalizeStrategyEpisode skip-when-open', () => {
  it('returns skipped_open when a strategy sim cycle is open', async () => {
    vi.resetModules()
    vi.doMock('@/strategies/db', () => ({
      fetchTradingRecordsForWallet: vi.fn().mockResolvedValue([{}]),
    }))
    vi.doMock('@/utils/simulation-trades', () => ({
      computeOpenSimCycle: vi.fn().mockReturnValue({
        mintAddress: 'Mint111',
        remainingTokenAmount: 1,
        totalSolBought: 1,
        weightedBuyPriceUsd: 1,
        simulationType: 'strategy',
      }),
    }))
    vi.doMock('@/utils/db', () => ({
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }))
    vi.doMock('@/utils/trading-simulation', () => ({
      isOpenTrackerPosition: vi.fn().mockReturnValue(false),
    }))

    const { finalizeStrategyEpisode } = await import(
      '@/strategies/strategy-episodes'
    )
    const result = await finalizeStrategyEpisode('Mint111')
    expect(result.status).toBe('skipped_open')
  })
})
