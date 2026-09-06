import { describe, expect, it } from 'vitest'
import {
  rhIndexerConfidence,
  rhPoolRowToLpPool,
  rhPoolsToCatalog,
  rhPoolsUrl,
  type RhPoolsRow,
} from './rh-pools-indexer'

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const row: RhPoolsRow = {
  id: '0x9BB2FE34E260D010C3FC174138F1008E59EA75FDAE8487F3F252EE5AE29E7E02',
  protocol: 'v4',
  token0: { address: USDG, symbol: 'USDG', decimals: 6 },
  token1: { address: '0x7DF5daaf80e65dfcc7a1435d9b52bcf2b5753fbe', symbol: 'UNIPCS', decimals: 18 },
  fee_ppm: 40961,
  tvl_usd: null,
  active_tvl_usd: null,
  observed_active_tvl_usd: 12345,
  volume_usd: 5_590_666.93,
  fees_usd: 232_082.83,
  swaps: 13463,
  adds: 2791,
  removes: 2414,
  lp_count: 290,
  price_change_pct: -31.06,
  risks: ['singleton pool; manager balance is not TVL'],
}

describe('rh-pools-indexer', () => {
  it('maps a v4 row, lowercases ids, flags approx TVL and keeps indexer fees', () => {
    const m = rhPoolRowToLpPool(row)!
    expect(m.pool.proto).toBe('univ4')
    expect(m.pool.address).toBe(row.id.toLowerCase())
    expect(m.pool.token1).toBe('0x7df5daaf80e65dfcc7a1435d9b52bcf2b5753fbe')
    expect(m.pool.tvlApprox).toBe(true)
    expect(m.pool.tvlUsd).toBe(12345)
    expect(m.pool.fees24hUsd).toBeCloseTo(232_082.83)
    expect(m.pool.lpCount).toBe(290)
    expect(m.pool.risks).toEqual(['singleton pool; manager balance is not TVL'])
    expect(m.tokens[USDG]?.decimals).toBe(6)
  })

  it('drops rows without protocol or tokens, counts totals from server total', () => {
    const cat = rhPoolsToCatalog({
      rows: [row, { id: '0x1', protocol: 'v9' }, { ...row, id: '0x2', protocol: 'v2' }],
      total: 34240,
    })
    expect(cat.pools).toHaveLength(2)
    expect(cat.totals).toEqual({ univ2: 1, univ3: 0, univ4: 1 })
    expect(cat.count).toBe(34240)
  })

  it('builds the upstream URL with server sort/protocol names and page cap', () => {
    const u = new URL(
      rhPoolsUrl('https://x', { sort: 'vol', limit: 500, offset: 0, q: 'PEZ', proto: 'univ4' }),
    )
    expect(u.pathname).toBe('/api/lp/pools')
    expect(u.searchParams.get('sort')).toBe('volume')
    expect(u.searchParams.get('limit')).toBe('150')
    expect(u.searchParams.get('protocol')).toBe('v4')
    expect(u.searchParams.get('q')).toBe('PEZ')
  })

  it('confidence: fresh index ≈ 1, degraded index → noTrade', () => {
    const now = 1_788_710_000
    const fresh = rhIndexerConfidence({ lag_s: 30 }, now)
    expect(fresh.score).toBeGreaterThan(0.9)
    expect(fresh.noTrade).toBe(false)

    const degraded = rhIndexerConfidence(
      {
        lag_s: 8790,
        enrichment_deferred: true,
        reorg: { at: now - 600 },
        errors: { activity_feed: 'stale' },
      },
      now,
    )
    expect(degraded.score).toBe(0)
    expect(degraded.noTrade).toBe(true)
    expect(degraded.reasons).toEqual(
      expect.arrayContaining(['trace enrichment deferred', 'recent reorg']),
    )
    expect(rhIndexerConfidence(null).noTrade).toBe(true)
  })
})
