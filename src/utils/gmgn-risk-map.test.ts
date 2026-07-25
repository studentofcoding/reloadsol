import { describe, expect, it } from 'vitest'
import { mapGmgnSnapshotToRisk } from '@/utils/gmgn-risk-map'

describe('mapGmgnSnapshotToRisk', () => {
  it('marks honeypot as overall HIGH', () => {
    const { risk } = mapGmgnSnapshotToRisk({
      snapshot: {
        top10HoldPct: 10,
        insidersHoldPct: 1,
        bundlersHoldPct: 0,
        snipersHoldPct: 0,
        isHoneypot: true,
      },
      marketCap: 500_000,
    })
    expect(risk.overallRisk).toBe('HIGH')
  })

  it('flags high top10 concentration', () => {
    const { risk, axiomData } = mapGmgnSnapshotToRisk({
      snapshot: {
        top10HoldPct: 65,
        insidersHoldPct: 1,
        bundlersHoldPct: 0,
        snipersHoldPct: 0,
        holders: 1200,
        isHoneypot: false,
      },
      marketCap: 500_000,
    })
    expect(axiomData.top10HoldersPercent).toBe(65)
    expect(axiomData.numHolders).toBe(1200)
    expect(risk.concentrationRisk).toBe('HIGH')
  })
})
