import { describe, expect, it } from 'vitest'
import { resolveJupiterMaxRps } from './jupiter-rps'

describe('resolveJupiterMaxRps', () => {
  it('defaults to the measured-clean rate, not a hopeful one', () => {
    // 0.5 rps paced was measured 10/10 clean (p50 260ms) while sharing the key with live traffic;
    // ~6 rps bursts and any concurrency are rejected outright. A missing env var must not change that.
    expect(resolveJupiterMaxRps({})).toBe(0.5)
  })

  it('takes an explicit rate, including one below the quota', () => {
    expect(resolveJupiterMaxRps({ JUPITER_MAX_RPS: '0.3' })).toBe(0.3)
    expect(resolveJupiterMaxRps({ JUPITER_MAX_RPS: '1' })).toBe(1)
  })

  it('refuses junk and non-positive values rather than disabling the gate', () => {
    for (const raw of ['', 'abc', '0', '-2', 'NaN', 'Infinity']) {
      expect(resolveJupiterMaxRps({ JUPITER_MAX_RPS: raw })).toBe(0.5)
    }
  })
})
