import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn(async () => ({ rows: [] })) }))
vi.mock('@/utils/unified-logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/strategies/ohlc-rug-shadow', () => ({ attachOhlcRugShadow: vi.fn() }))
vi.mock('@/strategies/ml-entry-shadow', () => ({
  attachMlEntryShadow: vi.fn(async (features: Record<string, unknown>) => ({ features, pBad: null, pWinner: null })),
}))
vi.mock('@/strategies/target-machine-cl-score', () => ({
  loadTargetMachineClScore: vi.fn(async () => ({ mlScore: 1, modelVersion: 'test' })),
}))

import { attachOhlcRugShadow } from '@/strategies/ohlc-rug-shadow'
import { query } from '@/utils/db'
import { prepareTargetMachinePaperOpen } from './prepare-target-machine-paper-open'

const base = {
  mint: 'Mint1',
  chain: 'sol' as const,
  features: { entry_mcap: 1000 },
  baseSol: 0.02,
  baseExit: { takeProfitPct: 50, stopLossPct: -25, maxHoldHours: 12 },
}
const okOhlc = { features: {}, reject: false, reason: null, trip: false, evalResult: null, bars: [], source: 'own' } as never

describe('prepareTargetMachinePaperOpen — OPEN_RETRY_POLICY', () => {
  beforeEach(() => {
    vi.mocked(attachOhlcRugShadow).mockReset()
    vi.mocked(query).mockClear()
    process.env.OPEN_RETRY_DELAY_MS = '0'
  })
  afterEach(() => {
    delete process.env.OPEN_RETRY_POLICY
    delete process.env.OPEN_RETRY_DELAY_MS
  })

  it('off (default): a single try, a throw propagates, nothing recorded', async () => {
    vi.mocked(attachOhlcRugShadow).mockRejectedValue(new Error('boom'))
    await expect(prepareTargetMachinePaperOpen({ ...base, priceUsd: 1 })).rejects.toThrow('boom')
    expect(attachOhlcRugShadow).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled()
  })

  it('on: retries a transient throw and opens with the refetched price', async () => {
    process.env.OPEN_RETRY_POLICY = '1'
    vi.mocked(attachOhlcRugShadow).mockRejectedValueOnce(new Error('blip')).mockResolvedValue(okOhlc)
    const res = await prepareTargetMachinePaperOpen({ ...base, priceUsd: 1, refetchPriceUsd: async () => 1.01 })
    expect(res.ok).toBe(true)
    expect(attachOhlcRugShadow).toHaveBeenCalledTimes(2)
  })

  it('on: price moved >5% since the failed try -> skip with reason, no second attempt', async () => {
    process.env.OPEN_RETRY_POLICY = '1'
    vi.mocked(attachOhlcRugShadow).mockRejectedValue(new Error('blip'))
    const res = await prepareTargetMachinePaperOpen({ ...base, priceUsd: 1, refetchPriceUsd: async () => 0.8 })
    expect(res).toEqual({ ok: false, stage: 'price', reason: 'price_moved_gt_5pct' })
    expect(attachOhlcRugShadow).toHaveBeenCalledTimes(1)
  })

  it('on: a rug trip is a decision and is never retried', async () => {
    process.env.OPEN_RETRY_POLICY = '1'
    vi.mocked(attachOhlcRugShadow).mockResolvedValue({ ...(okOhlc as object), reject: true, reason: 'dump_10m' } as never)
    const res = await prepareTargetMachinePaperOpen({ ...base, priceUsd: 1 })
    expect(res).toMatchObject({ ok: false, stage: 'rug' })
    expect(attachOhlcRugShadow).toHaveBeenCalledTimes(1)
  })
})
