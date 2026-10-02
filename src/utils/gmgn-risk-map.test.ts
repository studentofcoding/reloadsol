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

  // GMGN returns `insidersHoldPct: null` for real Sol mints (measured on two live candidates),
  // and RiskAnalysis renders these with `.toFixed(1)`. Before Sol was repointed off Axiom, a null
  // here would have thrown during render — the mapper's pct() is what makes the field safe.
  it('coerces GMGN nulls to finite numbers, so the risk panel cannot throw on render', () => {
    const { axiomData } = mapGmgnSnapshotToRisk({
      snapshot: {
        top10HoldPct: 23.36,
        insidersHoldPct: null,
        bundlersHoldPct: 20.59,
        snipersHoldPct: 7.4,
        holders: 1548,
        isHoneypot: false,
      },
      marketCap: 307_200,
    })

    for (const field of [
      'insidersHoldPercent',
      'bundlersHoldPercent',
      'snipersHoldPercent',
      'top10HoldersPercent',
      'numHolders',
      'totalPairFeesPaid',
    ] as const) {
      expect(Number.isFinite(axiomData[field]), `${field} must be finite`).toBe(true)
    }
    expect(axiomData.insidersHoldPercent).toBe(0)
    // The literal render path from RiskAnalysis.
    expect(`${axiomData.insidersHoldPercent.toFixed(1)}%`).toBe('0.0%')
  })
})
