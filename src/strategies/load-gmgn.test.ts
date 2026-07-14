import { describe, expect, it } from 'vitest'
import { hasActiveGmgnRadarStrategy } from './load-gmgn'

describe('hasActiveGmgnRadarStrategy', () => {
  it('is false when all GMGN strategies are off', () => {
    expect(
      hasActiveGmgnRadarStrategy({
        gmgn_smartmoney_default: { is_active: false },
        gmgn_kol_momentum: { is_active: false },
        gmgn_sm_kol_combined: { is_active: false },
      }),
    ).toBe(false)
  })

  it('is true when any GMGN SM/KOL strategy is on', () => {
    expect(
      hasActiveGmgnRadarStrategy({
        gmgn_smartmoney_default: { is_active: false },
        gmgn_sm_kol_combined: { is_active: true },
      }),
    ).toBe(true)
  })
})
