import { describe, expect, it } from 'vitest'
import type { LpTerminalPoolRaw } from './lp-terminal-pools'
import { paperLpPnlPct, rhLpScoreConfig, scoreRhPool } from './rh-lp-score'

const cfg = rhLpScoreConfig()

const healthy: LpTerminalPoolRaw = {
  proto: 'univ3',
  address: '0xpool',
  token0: '0xusdg',
  token1: '0xtok',
  feePpm: 3000,
  tvlUsd: 2_000_000,
  tvlApprox: false,
  vol24hUsd: 5_000_000,
  fees24hUsd: 15_000,
  adds24h: 40,
  removes24h: 30,
  lpCount: 120,
  priceChangePct: 4,
  risks: [],
}

describe('scoreRhPool', () => {
  it('scores a healthy verified pool and scales by confidence', () => {
    const full = scoreRhPool(healthy, { confidence: 1, cfg })
    const half = scoreRhPool(healthy, { confidence: 0.5, cfg })
    expect(full.score).toBeGreaterThan(20)
    expect(half.raw).toBe(full.raw)
    expect(half.score).toBeCloseTo(full.score / 2, 0)
    expect(full.features.feeEff).toBeCloseTo(0.003)
    expect(full.features.churn).toBeCloseTo(70 / 120)
  })

  it('zeroes singleton pools without verified TVL unless a secondary read rescues them', () => {
    const singleton: LpTerminalPoolRaw = {
      ...healthy,
      proto: 'univ4',
      tvlUsd: 0,
      tvlApprox: true,
      risks: ['singleton pool; manager balance is not TVL'],
    }
    expect(scoreRhPool(singleton, { confidence: 1, cfg }).score).toBe(0)
    expect(
      scoreRhPool(singleton, { confidence: 1, cfg, secondaryLiquidityUsd: 50_000 }).score,
    ).toBeGreaterThan(0)
  })

  it('hard floors: volume, lp_count, price move, churn, toxic flow, confidence', () => {
    expect(scoreRhPool({ ...healthy, vol24hUsd: 100 }, { confidence: 1, cfg }).score).toBe(0)
    expect(scoreRhPool({ ...healthy, lpCount: 1 }, { confidence: 1, cfg }).score).toBe(0)
    expect(scoreRhPool({ ...healthy, priceChangePct: 250 }, { confidence: 1, cfg }).score).toBe(0)
    expect(
      scoreRhPool({ ...healthy, adds24h: 3000, removes24h: 3000 }, { confidence: 1, cfg }).score,
    ).toBe(0)
    expect(
      scoreRhPool(healthy, {
        confidence: 1,
        cfg,
        demand: { organicBuyUsd: 100, uniqueBuyers: 1, sellUsd: 900, toxicRatio: 0.9 },
      }).score,
    ).toBe(0)
    expect(scoreRhPool(healthy, { confidence: 0, cfg }).score).toBe(0)
  })

  it('organic demand lifts the score; toxic ratio discounts it', () => {
    const base = scoreRhPool(healthy, { confidence: 1, cfg }).score
    const clean = scoreRhPool(healthy, {
      confidence: 1,
      cfg,
      demand: { organicBuyUsd: 50_000, uniqueBuyers: 12, sellUsd: 0, toxicRatio: 0 },
    }).score
    const mixed = scoreRhPool(healthy, {
      confidence: 1,
      cfg,
      demand: { organicBuyUsd: 50_000, uniqueBuyers: 12, sellUsd: 50_000, toxicRatio: 0.5 },
    }).score
    expect(clean).toBeGreaterThan(base)
    expect(mixed).toBeGreaterThan(base)
    expect(mixed).toBeLessThan(clean)
  })
})

describe('paperLpPnlPct', () => {
  it('earns fees in range and marks out of range beyond the width', () => {
    const inRange = paperLpPnlPct({
      entryPrice: 100,
      currentPrice: 101,
      rangePct: 15,
      fees24hUsd: 10_000,
      poolTvlUsd: 1_000_000,
      amountUsd: 1_000,
      hoursOpen: 24,
    })
    expect(inRange.inRange).toBe(true)
    expect(inRange.feesUsd).toBeGreaterThan(0)
    const oor = paperLpPnlPct({ ...{
      entryPrice: 100,
      currentPrice: 130,
      rangePct: 15,
      fees24hUsd: 10_000,
      poolTvlUsd: 1_000_000,
      amountUsd: 1_000,
      hoursOpen: 24,
    } })
    expect(oor.inRange).toBe(false)
    expect(oor.feesUsd).toBe(0)
    expect(oor.pnlPct).toBeLessThan(0)
  })
})
