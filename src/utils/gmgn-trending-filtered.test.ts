import { describe, expect, it } from 'vitest'
import type { GmgnMarketRankRow } from '@/utils/gmgn-api'
import {
  criteriaForChain,
  filterAndSortGmgnTrending,
  GMGN_FILTERED_CRITERIA,
  gmgnOrganicScoreProxy,
  mapGmgnRankToFilteredToken,
  normalizePriceChangeToFraction,
  passesGmgnFilteredCriteria,
  ROBINHOOD_FILTERED_CRITERIA,
} from '@/utils/gmgn-trending-filtered'

describe('normalizePriceChangeToFraction', () => {
  it('divides percent-looking values', () => {
    expect(normalizePriceChangeToFraction(13.5)).toBeCloseTo(0.135)
    expect(normalizePriceChangeToFraction(-40)).toBeCloseTo(-0.4)
  })

  it('keeps fractional values', () => {
    expect(normalizePriceChangeToFraction(0.135)).toBeCloseTo(0.135)
    expect(normalizePriceChangeToFraction(-0.39)).toBeCloseTo(-0.39)
  })
})

describe('gmgnOrganicScoreProxy', () => {
  it('scores hot + social signals', () => {
    expect(
      gmgnOrganicScoreProxy({
        hot_level: 3,
        smart_degen_count: 2,
        renowned_count: 1,
      }),
    ).toBe(90)
  })
})

describe('filterAndSortGmgnTrending', () => {
  const base: GmgnMarketRankRow = {
    address: '0x1111111111111111111111111111111111111111',
    symbol: 'GOOD',
    market_cap: 500_000,
    volume: 100_000,
    price_change_percent: 10,
    hot_level: 3,
    smart_degen_count: 2,
    renowned_count: 0,
  }

  it('keeps in-band rows and drops out-of-band', () => {
    const rows: GmgnMarketRankRow[] = [
      base,
      {
        ...base,
        address: '0x2222222222222222222222222222222222222222',
        symbol: 'LOWORG',
        hot_level: 1,
        smart_degen_count: 0,
        renowned_count: 0,
      },
      {
        ...base,
        address: '0x3333333333333333333333333333333333333333',
        symbol: 'DUMP',
        price_change_percent: -50,
      },
      {
        ...base,
        address: '0x4444444444444444444444444444444444444444',
        symbol: 'BIG',
        market_cap: 3_000_000,
      },
    ]
    const { tokens, total_before_filter, total_after_filter } =
      filterAndSortGmgnTrending(rows)
    expect(total_before_filter).toBe(4)
    expect(total_after_filter).toBe(1)
    expect(tokens[0]?.token_symbol).toBe('GOOD')
  })

  it('maps logo and change fields', () => {
    const mapped = mapGmgnRankToFilteredToken({
      ...base,
      logo: 'https://example.com/a.png',
      price_change_percent: 20,
    })
    expect(mapped).not.toBeNull()
    expect(mapped!.logo_url).toBe('https://example.com/a.png')
    expect(mapped!.change_1h).toBeCloseTo(0.2)
    expect(mapped!.change_5m).toBeCloseTo(0.2)
    expect(passesGmgnFilteredCriteria(mapped!)).toBe(true)
  })

  it('uses the real 5m field when GMGN sends it', () => {
    const mapped = mapGmgnRankToFilteredToken({
      ...base,
      price_change_percent: 55.2,
      price_change_percent5m: 9.3,
    })
    expect(mapped!.change_1h).toBeCloseTo(0.552)
    expect(mapped!.change_5m).toBeCloseTo(0.093)
  })

  it('drops a row whose real 5m change is a hard dump even when 1h looks green', () => {
    const mapped = mapGmgnRankToFilteredToken({
      ...base,
      price_change_percent: 929.5,
      price_change_percent5m: -62.1,
    })
    expect(passesGmgnFilteredCriteria(mapped!)).toBe(false)
  })

  it('sorts by organic then abs change', () => {
    const rows: GmgnMarketRankRow[] = [
      {
        ...base,
        address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        symbol: 'A',
        hot_level: 3,
        smart_degen_count: 0,
        renowned_count: 0,
        price_change_percent: 5,
      },
      {
        ...base,
        address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        symbol: 'B',
        hot_level: 3,
        smart_degen_count: 0,
        renowned_count: 0,
        price_change_percent: 40,
      },
    ]
    const { tokens } = filterAndSortGmgnTrending(rows)
    expect(tokens.map((t) => t.token_symbol)).toEqual(['B', 'A'])
  })
})

describe('criteriaForChain', () => {
  it('returns the sol band for sol', () => {
    expect(criteriaForChain('sol')).toBe(GMGN_FILTERED_CRITERIA)
  })

  it('returns the robinhood band for robinhood', () => {
    expect(criteriaForChain('robinhood')).toBe(ROBINHOOD_FILTERED_CRITERIA)
  })

  it('uses a wider mcap band on Robinhood', () => {
    expect(ROBINHOOD_FILTERED_CRITERIA.min_mcap).toBeLessThan(GMGN_FILTERED_CRITERIA.min_mcap)
    expect(ROBINHOOD_FILTERED_CRITERIA.max_mcap).toBeGreaterThan(
      GMGN_FILTERED_CRITERIA.max_mcap,
    )
  })
})

describe('passesGmgnFilteredCriteria with chain arg', () => {
  it('accepts a 50K-mcap token on Robinhood but rejects on the default (sol) band', () => {
    const mapped = mapGmgnRankToFilteredToken({
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      symbol: 'SMOL',
      market_cap: 50_000,
      price_change_percent: 0,
      price_change_percent5m: 0,
      hot_level: 2,
    })
    expect(mapped).not.toBeNull()
    expect(passesGmgnFilteredCriteria(mapped!)).toBe(false)
    expect(passesGmgnFilteredCriteria(mapped!, 'robinhood')).toBe(true)
  })

  it('accepts a 1.5M-mcap token on both chains', () => {
    const mapped = mapGmgnRankToFilteredToken({
      address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      symbol: 'MID',
      market_cap: 1_500_000,
      price_change_percent: 0,
      price_change_percent5m: 0,
      hot_level: 3,
      smart_degen_count: 1,
      renowned_count: 1,
    })
    expect(passesGmgnFilteredCriteria(mapped!)).toBe(true)
    expect(passesGmgnFilteredCriteria(mapped!, 'robinhood')).toBe(true)
  })

  it('accepts a 5M-mcap token on robinhood but rejects it on the sol band', () => {
    const mapped = mapGmgnRankToFilteredToken({
      address: '0xdddddddddddddddddddddddddddddddddddddddd',
      symbol: 'BIG',
      market_cap: 5_000_000,
      price_change_percent: 0,
      price_change_percent5m: 0,
      hot_level: 3,
      smart_degen_count: 1,
      renowned_count: 1,
    })
    expect(passesGmgnFilteredCriteria(mapped!)).toBe(false)
    expect(passesGmgnFilteredCriteria(mapped!, 'robinhood')).toBe(true)
  })

  it('still rejects tokens below the change_5m floor on either chain', () => {
    const mapped = mapGmgnRankToFilteredToken({
      address: '0xcccccccccccccccccccccccccccccccccccccccc',
      symbol: 'DUMP',
      market_cap: 1_000_000,
      price_change_percent: -50,
      price_change_percent5m: -50,
      hot_level: 3,
      smart_degen_count: 1,
      renowned_count: 1,
    })
    expect(passesGmgnFilteredCriteria(mapped!, 'robinhood')).toBe(false)
  })
})

describe('filterAndSortGmgnTrending with chain arg', () => {
  it('keeps small-mcap rows on robinhood that the sol band drops', () => {
    const baseRow: GmgnMarketRankRow = {
      address: '0x1111111111111111111111111111111111111111',
      symbol: 'TKN',
      market_cap: 50_000,
      price_change_percent: 0,
      price_change_percent5m: 0,
      hot_level: 2,
    }
    const solResult = filterAndSortGmgnTrending([baseRow])
    const rhResult = filterAndSortGmgnTrending([baseRow], 'robinhood')
    expect(solResult.tokens).toHaveLength(0)
    expect(rhResult.tokens).toHaveLength(1)
  })
})
