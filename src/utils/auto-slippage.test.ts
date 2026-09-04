import { describe, expect, it } from 'vitest'
import {
  AUTO_SLIPPAGE_BPS,
  AUTO_SLIPPAGE_CAP_BPS,
  AUTO_SLIPPAGE_FLOOR_BPS,
  prefetchSlippageBps,
  rawImpactToPct,
  resolveAutoSlippageBps,
  resolveTradeSlippageBps,
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
    expect(resolveAutoSlippageBps(1.4)).toEqual({
      ok: true,
      bps: AUTO_SLIPPAGE_CAP_BPS,
    })
  })

  it('refuses when quoted impact is already above the cap', () => {
    const r = resolveAutoSlippageBps(2)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/above the auto cap/)
  })
})

describe('resolveTradeSlippageBps', () => {
  it('passes manual bps through', () => {
    expect(resolveTradeSlippageBps(100, 9)).toBe(100)
  })

  it('resolves the auto sentinel', () => {
    expect(resolveTradeSlippageBps(AUTO_SLIPPAGE_BPS, 0.5)).toBe(70)
  })

  it('throws when auto is blocked by the cap', () => {
    expect(() => resolveTradeSlippageBps(AUTO_SLIPPAGE_BPS, 2)).toThrow(
      /above the auto cap/,
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
