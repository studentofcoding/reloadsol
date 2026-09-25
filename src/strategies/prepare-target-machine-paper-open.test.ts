import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/strategies/ohlc-rug-shadow', () => ({
  attachOhlcRugShadow: vi.fn(),
}))
vi.mock('@/strategies/ml-entry-shadow', () => ({
  attachMlEntryShadow: vi.fn(async (features: Record<string, unknown>) => ({
    features,
    pBad: null,
    pWinner: null,
  })),
}))
vi.mock('@/strategies/target-machine-cl-score', () => ({
  loadTargetMachineClScore: vi.fn(async () => ({
    mlScore: 1,
    modelVersion: 'test',
  })),
}))

import { attachOhlcRugShadow } from '@/strategies/ohlc-rug-shadow'
import { prepareTargetMachinePaperOpen } from './prepare-target-machine-paper-open'
import { pushSpineDecision, type SpineDecision } from './spine-tick-log'

const base = {
  mint: 'Mint1',
  chain: 'sol' as const,
  features: { entry_mcap: 1000 },
  baseSol: 0.02,
  baseExit: { takeProfitPct: 50, stopLossPct: -25, maxHoldHours: 12 },
}

describe('prepareTargetMachinePaperOpen', () => {
  beforeEach(() => {
    vi.mocked(attachOhlcRugShadow).mockReset()
  })

  it('skips a rug trip and does not invent a price', async () => {
    vi.mocked(attachOhlcRugShadow).mockResolvedValue({
      features: {},
      reject: true,
      reason: 'dump_10m',
      trip: true,
      evalResult: null,
    })
    const missing = await prepareTargetMachinePaperOpen({
      ...base,
      priceUsd: null,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.stage).toBe('price')

    const rug = await prepareTargetMachinePaperOpen({
      ...base,
      priceUsd: 0.01,
    })
    expect(rug.ok).toBe(false)
    if (!rug.ok) {
      expect(rug.stage).toBe('rug')
      expect(rug.reason).toContain('ohlc_rug')
    }
  })

  it('passes with closed-loop size and TP/SL', async () => {
    vi.mocked(attachOhlcRugShadow).mockResolvedValue({
      features: { entry_mcap: 1000 },
      reject: false,
      reason: null,
      trip: false,
      evalResult: null,
    })
    const pass = await prepareTargetMachinePaperOpen({
      ...base,
      priceUsd: 0.01,
    })
    expect(pass.ok).toBe(true)
    if (pass.ok) {
      expect(pass.p).toBe(1)
      expect(pass.solAmount).toBeGreaterThan(0)
      expect(pass.effectiveExit.takeProfitPct).toBeGreaterThan(0)
      expect(pass.effectiveExit.stopLossPct).toBeLessThan(0)
      expect(pass.features.initial_price_usd).toBe(0.01)
    }
  })
})

describe('pushSpineDecision', () => {
  it('keeps a rug skip and a pass, capped', () => {
    const skip: SpineDecision = {
      workerId: 'social_sim_track',
      mint: 'a',
      stage: 'rug',
      reason: 'ohlc_rug',
      passed: false,
      p: null,
      solAmount: null,
      takeProfitPct: null,
      stopLossPct: null,
      at: 't0',
    }
    const pass: SpineDecision = {
      ...skip,
      mint: 'b',
      stage: 'pass',
      reason: null,
      passed: true,
      p: 0.5,
      solAmount: 0.02,
      takeProfitPct: 40,
      stopLossPct: -20,
    }
    const rows = pushSpineDecision(pushSpineDecision([], skip), pass)
    expect(rows.map((r) => r.stage)).toEqual(['rug', 'pass'])
    const overflow = Array.from({ length: 60 }, (_, i) => ({
      ...skip,
      mint: String(i),
    }))
    const capped = overflow.reduce(
      (acc, row) => pushSpineDecision(acc, row),
      [] as SpineDecision[],
    )
    expect(capped).toHaveLength(50)
    expect(capped[0]!.mint).toBe('10')
  })
})
