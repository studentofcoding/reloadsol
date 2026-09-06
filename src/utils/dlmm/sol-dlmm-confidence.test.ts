import { describe, expect, it } from 'vitest'
import { applySolDlmmConfidence, solDlmmConfidence } from './sol-dlmm-confidence'

const t0 = Date.parse('2026-09-07T00:00:00Z')

describe('solDlmmConfidence', () => {
  it('is 1 when the screen just succeeded', () => {
    const c = solDlmmConfidence({ lastOkAtMs: t0, nowMs: t0 })
    expect(c.score).toBe(1)
    expect(c.noTrade).toBe(false)
    expect(c.lagS).toBe(0)
  })

  it('decays with lag and noTrades past the floor', () => {
    const mid = solDlmmConfidence({ lastOkAtMs: t0, nowMs: t0 + 450_000 })
    expect(mid.score).toBeCloseTo(0.5, 2)
    expect(mid.noTrade).toBe(false)
    const stale = solDlmmConfidence({ lastOkAtMs: t0, nowMs: t0 + 900_000 })
    expect(stale.score).toBe(0)
    expect(stale.noTrade).toBe(true)
  })

  it('cuts ×0.9 on fetch error and zeros without a snapshot', () => {
    const err = solDlmmConfidence({ lastOkAtMs: t0, fetchError: true, nowMs: t0 })
    expect(err.score).toBe(0.9)
    expect(err.reasons).toContain('meteora fetch error')
    expect(solDlmmConfidence({ lastOkAtMs: null }).noTrade).toBe(true)
  })
})

describe('applySolDlmmConfidence', () => {
  it('multiplies raw scores', () => {
    const out = applySolDlmmConfidence([{ score: 40 }, { score: 10 }], 0.5)
    expect(out.map((r) => r.score)).toEqual([20, 5])
    expect(out[0].confidence).toBe(0.5)
  })
})
