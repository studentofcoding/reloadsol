import { describe, expect, it } from 'vitest'
import { gmgnTokenToJupiterPool, trendingFeedIsGmgn } from './gmgn-discovery'
import { mapPoolToTrackedToken } from './mappers'
import type { GmgnFilteredTrendingToken } from '@/utils/gmgn-trending-filtered'

const row: GmgnFilteredTrendingToken = {
  token_symbol: 'WEN',
  token_address: 'Mint1',
  price: 0.0025,
  change_1h: 0.4,
  change_5m: -0.1,
  volume_1h: 12_345,
  mcap: 90_000,
  organic_score: 77,
  logo_url: 'https://example.test/wen.png',
  first_seen_at: '2026-09-25T10:00:00.000Z',
}

describe('gmgnTokenToJupiterPool', () => {
  it('maps the row into the pool shape the cycle consumes', () => {
    const pool = gmgnTokenToJupiterPool(row)
    expect(pool.baseAsset.id).toBe('Mint1')
    expect(pool.baseAsset.symbol).toBe('WEN')
    expect(pool.baseAsset.usdPrice).toBe(0.0025)
    expect(pool.baseAsset.mcap).toBe(90_000)
    expect(pool.baseAsset.organicScore).toBe(77)
    // fraction -> percent, because mapPoolToTrackedToken divides back by 100
    expect(pool.baseAsset.stats1h.priceChange).toBeCloseTo(40)
    expect(pool.baseAsset.stats5m.priceChange).toBeCloseTo(-10)
  })

  it('survives the existing pool -> tracked-token mapper', () => {
    const mapped = mapPoolToTrackedToken(gmgnTokenToJupiterPool(row))
    expect(mapped.token_address).toBe('Mint1')
    expect(mapped.token_symbol).toBe('WEN')
    expect(mapped.current_price).toBe(0.0025)
    expect(mapped.market_cap).toBe(90_000)
    expect(mapped.organic_score).toBe(77)
    expect(mapped.change_1h).toBeCloseTo(0.4)
    expect(mapped.change_5m).toBeCloseTo(-0.1)
    expect(mapped.volume_1h).toBe(12_345)
  })
})

describe('trendingFeedIsGmgn', () => {
  const original = process.env.TRENDING_FEED
  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.TRENDING_FEED
    else process.env.TRENDING_FEED = v
  }

  it('defaults to the Jupiter list', () => {
    set(undefined)
    expect(trendingFeedIsGmgn()).toBe(false)
    set(original)
  })

  it('selects GMGN when TRENDING_FEED=gmgn (case/space tolerant)', () => {
    set(' GMGN ')
    expect(trendingFeedIsGmgn()).toBe(true)
    set(original)
  })
})
