import { describe, expect, it } from 'vitest'
import { scoreDevReputation, topDevTokens } from '@/strategies/dev-reputation'

describe('scoreDevReputation', () => {
  it('bans a serial launcher with near-zero graduation (live sample)', () => {
    // GdTf8Wxu… — 3558 created, 29 graduated
    const r = scoreDevReputation({ innerCount: 3529, openCount: 29 })
    expect(r.sample).toBe(3558)
    expect(r.graduationRatio).toBeCloseTo(0.00815, 4)
    expect(r.verdict).toBe('ban')
  })

  it('bans another serial launcher (live sample)', () => {
    // CZutgB7w… — 3597 created, 19 graduated
    const r = scoreDevReputation({ innerCount: 3578, openCount: 19 })
    expect(r.verdict).toBe('ban')
  })

  it('bans a small-but-sufficient sample with zero graduation', () => {
    // J41ykDF2… — 9 created, 0 graduated (sample 9 ≥ default floor 5)
    const r = scoreDevReputation({ innerCount: 9, openCount: 0 })
    expect(r.sample).toBe(9)
    expect(r.verdict).toBe('ban')
  })

  it('never bans a too-small sample', () => {
    // DzFyn5xB… — 1 created, 0 graduated
    const r = scoreDevReputation({ innerCount: 1, openCount: 0 })
    expect(r.verdict).toBe('inconclusive')
    expect(r.reasons.join(' ')).toContain('sample 1')
  })

  it('marks a proven creator as good', () => {
    const r = scoreDevReputation({
      innerCount: 5,
      openCount: 5,
      athMc: 5_000_000,
    })
    expect(r.graduationRatio).toBe(0.5)
    expect(r.verdict).toBe('good')
  })

  it('falls back to the best per-coin ATH when the aggregate is missing', () => {
    const r = scoreDevReputation({
      innerCount: 5,
      openCount: 5,
      athMc: null,
      tokenAthMcs: [1000, 3_000_000, 50_000],
    })
    expect(r.athMc).toBe(3_000_000)
    expect(r.verdict).toBe('good')
  })

  it('uses Jupiter devMints as the sample when GMGN aggregates are absent', () => {
    const r = scoreDevReputation({ innerCount: 0, openCount: 0, mintedCount: 40 })
    expect(r.sample).toBe(40)
    // zero graduated out of 40 → ban
    expect(r.verdict).toBe('ban')
  })

  it('stays inconclusive between the ban and good bands', () => {
    const r = scoreDevReputation({ innerCount: 90, openCount: 10, athMc: 200_000 })
    expect(r.graduationRatio).toBeCloseTo(0.1, 4)
    expect(r.verdict).toBe('inconclusive')
  })
})

describe('topDevTokens', () => {
  it('maps rows, sorts by ATH desc, and skips rows without an address', () => {
    const out = topDevTokens(
      [
        {
          token_address: 'A',
          symbol: 'AAA',
          token_ath_mc: '500',
          market_cap: '10',
          pool_liquidity: '5',
          holders: 3,
          is_open: false,
          launchpad_platform: 'Pump.fun',
          create_timestamp: 1,
        },
        { token_address: 'B', symbol: 'BBB', token_ath_mc: '9000', is_open: true },
        { symbol: 'skip-me' },
      ],
      10,
    )
    expect(out.map((t) => t.address)).toEqual(['B', 'A'])
    expect(out[0]).toMatchObject({ symbol: 'BBB', graduated: true, athMc: 9000 })
    expect(out[1]).toMatchObject({
      athMc: 500,
      holders: 3,
      launchpad: 'Pump.fun',
    })
  })

  it('caps the list at the requested size', () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      token_address: `T${i}`,
      token_ath_mc: String(i),
    }))
    const out = topDevTokens(rows)
    expect(out).toHaveLength(10)
    expect(out[0].address).toBe('T14')
  })
})
