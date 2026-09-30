import { describe, expect, it } from 'vitest'
import { mapRugcheckReport } from '@/strategies/rugcheck-features'

/** Trimmed fixtures captured from live RugCheck reports (see plan research). */
const TANGGI = {
  mint: 'AgdbByh1mVVbXdG7WAEKAYnbtb9dSZPa3ycnUVZhdvNG',
  score: 1,
  score_normalised: 1,
  creator: 'DzFyn5xBBjm4cS84ortUAx8hYzj9sbhAmEwzkCeHEjmk',
  creatorBalance: 0,
  risks: [],
  graphInsidersDetected: 0,
  rugged: false,
  deployPlatform: 'unknown',
  launchpad: { name: 'Pump.Fun', platform: 'pump_fun' },
  tokenMeta: { mutable: false, updateAuthority: '11111111111111111111111111111111' },
}

const FG = {
  mint: 'A6eYmWtVujcNJNmis2jqFgs8mWdUH9ZrWc1U3bpcpump',
  score: 4894,
  score_normalised: 40,
  creator: 'GdTf8WxuDisy3J2u1tnTSzMXZjScJRibRq5QFupL95Ws',
  creatorBalance: 1234,
  risks: [{ name: 'Single holder ownership', score: 4893 }],
  graphInsidersDetected: 0,
  rugged: false,
}

const SCRVAN = {
  mint: '7PyEfdBRzxPQJJZJ2x51ts4mitCzjjShF2H5CzKipump',
  score: 6007,
  score_normalised: 43,
  risks: [
    { name: 'Single holder ownership', score: 5006 },
    { name: 'High holder concentration', score: 1000 },
  ],
}

describe('mapRugcheckReport', () => {
  it('flags a non-report as unavailable', () => {
    expect(mapRugcheckReport(null).available).toBe(false)
    expect(mapRugcheckReport({}).available).toBe(false)
    expect(mapRugcheckReport('nope').available).toBe(false)
  })

  it('maps a clean token (empty risks stays available, not a bonus)', () => {
    const f = mapRugcheckReport(TANGGI)
    expect(f.available).toBe(true)
    expect(f.scoreNormalised).toBe(1)
    expect(f.riskNames).toEqual([])
    expect(f.riskPoints).toBe(0)
    expect(f.creator).toBe(
      'DzFyn5xBBjm4cS84ortUAx8hYzj9sbhAmEwzkCeHEjmk',
    )
    expect(f.mutableMetadata).toBe(false)
    expect(f.launchpad).toBe('Pump.Fun')
    expect(f.rugged).toBe(false)
  })

  it('maps named risks and their weights', () => {
    const f = mapRugcheckReport(FG)
    expect(f.scoreNormalised).toBe(40)
    expect(f.riskNames).toEqual(['Single holder ownership'])
    expect(f.riskPoints).toBe(4893)
    expect(f.creatorBalance).toBe(1234)
  })

  it('sums multiple risk points', () => {
    const f = mapRugcheckReport(SCRVAN)
    expect(f.riskNames).toEqual([
      'Single holder ownership',
      'High holder concentration',
    ])
    expect(f.riskPoints).toBe(6006)
  })

  it('reads lpLockedPct from the summary shape and nested lp', () => {
    expect(mapRugcheckReport({ mint: 'm', lpLockedPct: 88 }).lpLockedPct).toBe(88)
    expect(mapRugcheckReport({ mint: 'm', lp: { lpLockedPct: 42 } }).lpLockedPct).toBe(42)
  })

  it('reads the per-market lpLockedPct and takes the max (the real shape)', () => {
    // Live shape: the full report has NO top-level lpLockedPct — it is per market.
    const f = mapRugcheckReport({
      mint: 'm',
      markets: [
        { marketType: 'meteoraDlmm', lp: { lpLockedPct: 0 } },
        { marketType: 'raydium_cpmm', lp: { lpLockedPct: 97.06 } },
        { marketType: 'other', lp: {} },
      ],
    })
    expect(f.lpLockedPct).toBeCloseTo(97.06, 5)
  })

  it('leaves lpLockedPct null when no market carries it', () => {
    const f = mapRugcheckReport({ mint: 'm', markets: [{ marketType: 'x' }] })
    expect(f.lpLockedPct).toBeNull()
  })

  it('sums lockers[].usdcLocked into lpLockedUsd', () => {
    const f = mapRugcheckReport({
      mint: 'm',
      lockers: {
        a: { usdcLocked: 593.63, type: 'raydium_locker' },
        b: { usdcLocked: 925329.77, type: 'raydium_locker' },
        c: { type: 'raydium_locker' },
      },
    })
    expect(f.lpLockedUsd).toBeCloseTo(925923.4, 1)
    expect(mapRugcheckReport({ mint: 'm' }).lpLockedUsd).toBeNull()
  })
})
