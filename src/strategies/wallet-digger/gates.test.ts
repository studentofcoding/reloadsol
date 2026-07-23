import { describe, expect, it } from 'vitest'
import { isEvmTokenAddress, isGmgnTokenAddress } from '@/utils/gmgn-cli'
import {
  DEFAULT_ROBINHOOD_BANDS,
  DEFAULT_ROSTER_CONFIG,
  DEFAULT_SOL_BANDS,
  passAgeMcapBand,
} from './defaults'
import {
  passesSoldAboveBoughtMc,
  readAvgMcEdge,
  readPortfolioBars,
} from './portfolio-edge'

describe('passAgeMcapBand sol', () => {
  const cfg = DEFAULT_SOL_BANDS

  it('accepts new-band in range', () => {
    expect(passAgeMcapBand(12, 100_000, cfg)).toEqual({ ok: true, band: 'new' })
  })

  it('accepts old-band in range', () => {
    expect(passAgeMcapBand(48, 2_000_000, cfg)).toEqual({ ok: true, band: 'old' })
  })

  it('rejects new-band dead zone mcap', () => {
    expect(passAgeMcapBand(12, 800_000, cfg).ok).toBe(false)
  })

  it('rejects old-band low mcap', () => {
    expect(passAgeMcapBand(48, 200_000, cfg).ok).toBe(false)
  })

  it('rejects age > 7d', () => {
    expect(passAgeMcapBand(200, 2_000_000, cfg).ok).toBe(false)
  })

  it('fails closed on null age or mcap', () => {
    expect(passAgeMcapBand(null, 100_000, cfg).ok).toBe(false)
    expect(passAgeMcapBand(12, null, cfg).ok).toBe(false)
  })
})

describe('passAgeMcapBand robinhood', () => {
  const cfg = DEFAULT_ROBINHOOD_BANDS

  it('accepts RH new-band', () => {
    expect(passAgeMcapBand(6, 250_000, cfg)).toEqual({ ok: true, band: 'new' })
  })

  it('rejects RH new below $100k', () => {
    expect(passAgeMcapBand(6, 50_000, cfg).ok).toBe(false)
  })

  it('accepts RH old-band up to $5M', () => {
    expect(passAgeMcapBand(48, 4_500_000, cfg)).toEqual({ ok: true, band: 'old' })
  })

  it('rejects RH old above $5M', () => {
    expect(passAgeMcapBand(48, 6_000_000, cfg).ok).toBe(false)
  })
})

describe('roster chains default', () => {
  it('includes sol and robinhood', () => {
    expect(DEFAULT_ROSTER_CONFIG.chains).toEqual(['sol', 'robinhood'])
  })
})

describe('EVM / gmgn token address helpers', () => {
  it('accepts EVM token addresses', () => {
    expect(isEvmTokenAddress('0x2170Ed0880ac9A755fd29B2688956BD959F933F8')).toBe(true)
    expect(isGmgnTokenAddress('robinhood', '0x2170Ed0880ac9A755fd29B2688956BD959F933F8')).toBe(
      true,
    )
  })

  it('rejects zero / short / sol on robinhood', () => {
    expect(isEvmTokenAddress('0x0000000000000000000000000000000000000000')).toBe(false)
    expect(isEvmTokenAddress('0xabc')).toBe(false)
    expect(
      isGmgnTokenAddress('robinhood', 'So11111111111111111111111111111111111111112'),
    ).toBe(false)
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
