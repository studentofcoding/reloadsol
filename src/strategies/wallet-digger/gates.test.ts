import { describe, expect, it } from 'vitest'
import { DEFAULT_ROSTER_CONFIG, passAgeMcapBand } from './defaults'
import {
  passesSoldAboveBoughtMc,
  readAvgMcEdge,
  readPortfolioBars,
} from './portfolio-edge'

const cfg = DEFAULT_ROSTER_CONFIG

describe('passAgeMcapBand', () => {
  it('accepts new-band in range', () => {
    expect(passAgeMcapBand(12, 100_000, cfg)).toEqual({ ok: true, band: 'new' })
  })

  it('accepts old-band in range', () => {
    expect(passAgeMcapBand(48, 2_000_000, cfg)).toEqual({ ok: true, band: 'old' })
  })

  it('rejects new-band dead zone mcap', () => {
    const r = passAgeMcapBand(12, 800_000, cfg)
    expect(r.ok).toBe(false)
  })

  it('rejects old-band low mcap', () => {
    const r = passAgeMcapBand(48, 200_000, cfg)
    expect(r.ok).toBe(false)
  })

  it('rejects age > 7d', () => {
    const r = passAgeMcapBand(200, 2_000_000, cfg)
    expect(r.ok).toBe(false)
  })

  it('fails closed on null age or mcap', () => {
    expect(passAgeMcapBand(null, 100_000, cfg).ok).toBe(false)
    expect(passAgeMcapBand(12, null, cfg).ok).toBe(false)
  })
})

describe('portfolio-edge', () => {
  it('reads sold>bought mc aliases', () => {
    expect(
      passesSoldAboveBoughtMc({ bought_avg_mc: 50_000, sold_avg_mc: 120_000 }),
    ).toBe(true)
    expect(
      passesSoldAboveBoughtMc({ boughtAvgMc: 200_000, soldAvgMc: 100_000 }),
    ).toBe(false)
  })

  it('fails closed when mc avg fields missing', () => {
    expect(
      passesSoldAboveBoughtMc({
        buy: 20,
        sold_income: '1',
        bought_cost: '2',
        pnl_stat: { winrate: 0.5 },
      }),
    ).toBe(false)
    expect(readAvgMcEdge({ bought_cost: '1' })).toEqual({
      boughtAvgMc: null,
      soldAvgMc: null,
    })
  })

  it('reads live wallet_stats bar aliases', () => {
    expect(
      readPortfolioBars({
        buy: 15,
        realized_profit_pnl: 1.2,
        pnl_stat: { winrate: 0.55 },
      }),
    ).toEqual({ winrate: 0.55, buyCount: 15, pnl: 1.2 })
  })
})
