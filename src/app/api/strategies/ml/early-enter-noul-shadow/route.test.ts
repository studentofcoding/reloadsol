import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('next/server')>()
  return { ...original, connection: vi.fn(async () => {}) }
})

vi.mock('@/strategies/early-enter-noul-shadow-db', () => ({
  loadEarlyEnterNoulCompareStats: vi.fn(async () => []),
  loadEarlyEnterNoulFlipReadiness: vi.fn(async () => ({ overall: { total: 0 } })),
  loadEarlyEnterNoulShadowRows: vi.fn(async () => ({
    rows: [],
    total: 0,
    limit: 100,
    offset: 0,
  })),
  loadEarlyEnterNoulShadowTokenPeaks: vi.fn(async () => ({
    uniqueMints: 2,
    withPeak: 1,
    medianPeakPercent: 40,
    avgPeakPercent: 40,
    hit100: 0,
    hit100Rate: 0,
    at80AvgPeakPercent: null,
    at80WithPeak: 0,
    at80Mints: 0,
    byFirstBand: [],
    byFirstArm: [],
    mints: [
      {
        tokenAddress: '82ezhRLKdKwkSC9jkM3js1yf93VbmvLXNMPkBmompump',
        peakGrowthPercent: 40,
      },
    ],
    total: 2,
    limit: 50,
    offset: 50,
    sort: 'peak_asc',
  })),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/strategies/ml/early-enter-noul-shadow/route'
import { loadEarlyEnterNoulShadowTokenPeaks } from '@/strategies/early-enter-noul-shadow-db'

const peaksMock = vi.mocked(loadEarlyEnterNoulShadowTokenPeaks)

describe('GET /api/strategies/ml/early-enter-noul-shadow token peaks', () => {
  const previousSoft = process.env.EARLY_ENTER_NOUL_SOFT_ACTIVE

  afterEach(() => {
    if (previousSoft === undefined) delete process.env.EARLY_ENTER_NOUL_SOFT_ACTIVE
    else process.env.EARLY_ENTER_NOUL_SOFT_ACTIVE = previousSoft
  })

  it('returns the peak payload and keeps soft-active off', async () => {
    delete process.env.EARLY_ENTER_NOUL_SOFT_ACTIVE
    const response = await GET(
      new NextRequest(
        'http://localhost/api/strategies/ml/early-enter-noul-shadow?token_limit=50&token_offset=50&token_sort=peak_asc',
      ),
    )
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.softActive).toBe(false)
    expect(body.tokenPeaks.total).toBe(2)
    expect(body.tokenPeaks.mints[0].tokenAddress).toBe(
      '82ezhRLKdKwkSC9jkM3js1yf93VbmvLXNMPkBmompump',
    )
    expect(peaksMock).toHaveBeenCalledWith({
      limit: 50,
      offset: 50,
      sort: 'peak_asc',
    })
  })

  it('falls back to peak desc when the sort param is unknown', async () => {
    delete process.env.EARLY_ENTER_NOUL_SOFT_ACTIVE
    await GET(
      new NextRequest(
        'http://localhost/api/strategies/ml/early-enter-noul-shadow?token_sort=not-a-sort',
      ),
    )
    expect(peaksMock).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'peak_desc' }),
    )
  })
})
