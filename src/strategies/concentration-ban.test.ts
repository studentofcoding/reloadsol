import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateConcentrationBan } from '@/strategies/concentration-ban'

describe('evaluateConcentrationBan', () => {
  it('does not ban at or below 50%', () => {
    expect(
      evaluateConcentrationBan({
        top10HoldPct: 50,
        devHoldPct: 49,
        bundlersHoldPct: 50,
      }),
    ).toEqual({ ban: false, reasons: [] })
  })

  it('bans when Top 10 > 50%', () => {
    const r = evaluateConcentrationBan({
      top10HoldPct: 50.1,
      devHoldPct: 0,
      bundlersHoldPct: 0,
    })
    expect(r.ban).toBe(true)
    expect(r.reasons[0]).toMatch(/Top 10/)
  })

  it('bans when Dev > 50%', () => {
    const r = evaluateConcentrationBan({
      top10HoldPct: 10,
      devHoldPct: 51,
      bundlersHoldPct: null,
    })
    expect(r.ban).toBe(true)
    expect(r.reasons.some((x) => x.includes('Dev'))).toBe(true)
  })

  it('bans when Bundlers > 50%', () => {
    const r = evaluateConcentrationBan({
      top10HoldPct: null,
      devHoldPct: null,
      bundlersHoldPct: 60,
    })
    expect(r.ban).toBe(true)
    expect(r.reasons.some((x) => x.includes('Bundlers'))).toBe(true)
  })

  it('ignores missing metrics', () => {
    expect(
      evaluateConcentrationBan({
        top10HoldPct: null,
        devHoldPct: null,
        bundlersHoldPct: null,
      }),
    ).toEqual({ ban: false, reasons: [] })
  })
})

describe('banConcentrationIfNeeded', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('calls markTokenRug when thresholds trip', async () => {
    vi.resetModules()
    const markTokenRug = vi.fn().mockResolvedValue({})
    const closeOpenSimsForRadarDump = vi
      .fn()
      .mockResolvedValue({ closed: 0, errors: [] })
    vi.doMock('@/utils/rug-list/service', () => ({ markTokenRug }))
    vi.doMock('@/strategies/gmgn-radar-dump', () => ({
      closeOpenSimsForRadarDump,
    }))

    const { banConcentrationIfNeeded } = await import(
      '@/strategies/concentration-ban'
    )
    const result = await banConcentrationIfNeeded({
      tokenAddress: 'MintConc111',
      tokenSymbol: 'TEST',
      info: { stat: { top_10_holder_rate: 0.6, creator_hold_rate: 0 } },
      security: { bundler_trader_amount_rate: 0 },
    })
    expect(result.banned).toBe(true)
    expect(markTokenRug).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenAddress: 'MintConc111',
        source: 'concentration',
      }),
    )
  })
})
