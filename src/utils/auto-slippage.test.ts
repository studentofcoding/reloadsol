import { describe, expect, it } from 'vitest'
import {
  AUTO_SLIPPAGE_BPS,
  AUTO_SLIPPAGE_CAP_BPS,
  AUTO_SLIPPAGE_FLOOR_BPS,
  prefetchSlippageBps,
  rawImpactToPct,
  resolveAutoSlippageBps,
  resolveTradeSlippageBps,
  quoteIsVolatile,
  worstImpactPct,
} from '@/utils/auto-slippage'

describe('resolveAutoSlippageBps', () => {
  it('uses floor when impact is missing or tiny', () => {
    expect(resolveAutoSlippageBps(null)).toEqual({
      ok: true,
      bps: AUTO_SLIPPAGE_FLOOR_BPS,
    })
    expect(resolveAutoSlippageBps(0)).toEqual({
      ok: true,
      bps: AUTO_SLIPPAGE_FLOOR_BPS,
    })
    expect(resolveAutoSlippageBps(0.05)).toEqual({ ok: true, bps: 25 })
  })

  it('adds buffer and never exceeds cap', () => {
    expect(resolveAutoSlippageBps(0.5)).toEqual({ ok: true, bps: 70 })
    expect(resolveAutoSlippageBps(1.2)).toEqual({ ok: true, bps: 140 })
    expect(resolveAutoSlippageBps(1.4)).toEqual({ ok: true, bps: 160 })
    expect(resolveAutoSlippageBps(9)).toEqual({
      ok: true,
      bps: AUTO_SLIPPAGE_CAP_BPS,
    })
  })
})

describe('resolveTradeSlippageBps', () => {
  it('passes manual bps through', () => {
    expect(resolveTradeSlippageBps(100, 9)).toBe(100)
  })

  it('resolves the auto sentinel', () => {
    expect(resolveTradeSlippageBps(AUTO_SLIPPAGE_BPS, 0.5)).toBe(70)
  })

  it('clamps auto to the 8% cap', () => {
    expect(resolveTradeSlippageBps(AUTO_SLIPPAGE_BPS, 9)).toBe(
      AUTO_SLIPPAGE_CAP_BPS,
    )
  })
})

describe('worstImpactPct', () => {
  it('picks the largest finite abs impact', () => {
    expect(worstImpactPct([0.1, null, 0.8, undefined])).toBe(0.8)
    expect(worstImpactPct([null, undefined])).toBeNull()
  })
})

describe('rawImpactToPct', () => {
  it('treats values <= 1 as fractions', () => {
    expect(rawImpactToPct(0.012)).toBeCloseTo(1.2)
    expect(rawImpactToPct(1.2)).toBe(1.2)
  })
})

describe('prefetchSlippageBps', () => {
  it('replaces Auto with the floor', () => {
    expect(prefetchSlippageBps(AUTO_SLIPPAGE_BPS)).toBe(AUTO_SLIPPAGE_FLOOR_BPS)
    expect(prefetchSlippageBps(100)).toBe(100)
  })
})

describe('quoteIsVolatile', () => {
  it('is volatile only when impact is known and above 8%', () => {
    expect(quoteIsVolatile([])).toBe(false)
    expect(quoteIsVolatile([null])).toBe(false)
    expect(quoteIsVolatile([7.9])).toBe(false)
    expect(quoteIsVolatile([8.1])).toBe(true)
  })
})
