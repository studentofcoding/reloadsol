import { describe, expect, it } from 'vitest'
import type { GmgnMarketRankRow } from '@/utils/gmgn-api'
import {
  filterAndSortGmgnTrending,
  gmgnOrganicScoreProxy,
  mapGmgnRankToFilteredToken,
  normalizePriceChangeToFraction,
  passesGmgnFilteredCriteria,
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
