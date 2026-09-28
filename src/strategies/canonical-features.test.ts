import { describe, expect, it } from 'vitest'
import {
  FEATURE_SCHEMA_VERSION,
  resolveDlmmMintFromPoolTokens,
  toCanonicalEntryFeatures,
} from './canonical-features'
import { extractMlFeatureVectorV1 } from './ml-training-features'

const SOL = 'So11111111111111111111111111111111111111112'
const MINT = 'Mint1111111111111111111111111111111111111'

describe('toCanonicalEntryFeatures', () => {
  it('stamps schema v1 and dual-writes social aliases', () => {
    const out = toCanonicalEntryFeatures(
      {
        first_mcap: 80_000,
        telegram_mention_count_30m: 4,
        telegram_unique_channels_30m: 2,
        minutes_since_first_mention: 12,
        organic_score: 70,
        top_holders_pct: 10,
        token_age_hours: 1,
        volume_5m: 1000,
        entry_template: 'first_seen',
        entry_mcap_band: '51-100k',
        custom_flag: true,
      },
      'mcap_tracker',
      { mintAddress: MINT },
    )
    expect(out.feature_schema_version).toBe(FEATURE_SCHEMA_VERSION)
    expect(out.mint_address).toBe(MINT)
    expect(out.entry_mcap).toBe(80_000)
    expect(out.first_mcap).toBe(80_000)
    expect(out.mention_count_30m).toBe(4)
    expect(out.telegram_mention_count_30m).toBe(4)
    expect(out.minutes_to_first_mention).toBe(12)
    expect(out.minutes_since_first_mention).toBe(12)
    expect((out.domain_features as Record<string, unknown>).custom_flag).toBe(true)
  })

  it('derives token_age_hours when missing', () => {
    const out = toCanonicalEntryFeatures(
      {
        entry_mcap: 50_000,
        first_seen_at: '2026-01-01T00:00:00Z',
      },
      'mcap_tracker',
      { entryAt: '2026-01-01T03:00:00Z' },
    )
    expect(out.token_age_hours).toBe(3)
  })

  it('keeps ml_* at top level', () => {
    const out = toCanonicalEntryFeatures(
      { ml_gate_p_bad: 0.2, entry_mcap: 1 },
      'signals',
      { mintAddress: MINT },
    )
    expect(out.ml_gate_p_bad).toBe(0.2)
  })

  it('keeps OHLC rug features at top level, not buried in domain_features', () => {
    const out = toCanonicalEntryFeatures(
      {
        entry_mcap: 1000,
        ohlc_rug_n: 10,
        ohlc_rug_dump_pct: 0.5,
        ohlc_rug_trip: 1,
        ohlc_rug_skipped: 'no_bars_or_error',
        ohlc_source: 'own-1m',
        other_flag: true,
      },
      'social',
      { mintAddress: MINT },
    )
    expect(out.ohlc_rug_n).toBe(10)
    expect(out.ohlc_rug_dump_pct).toBe(0.5)
    expect(out.ohlc_rug_trip).toBe(1)
    expect(out.ohlc_rug_skipped).toBe('no_bars_or_error')
    expect(out.ohlc_source).toBe('own-1m')
    const bag = out.domain_features as Record<string, unknown>
    expect(bag.ohlc_rug_n).toBeUndefined()
    expect(bag.other_flag).toBe(true)
  })

  it('moves DLMM pool volume into domain_features.dlmm', () => {
    const out = toCanonicalEntryFeatures(
      {
        pool_volume: 50_000,
        fee_tvl_ratio_24h: 0.2,
        volume_at_entry: 50_000,
        instrument: 'dlmm_lp',
      },
      'dlmm',
      { mintAddress: MINT, poolAddress: 'PoolAddr' },
    )
    expect(out.pool_address).toBe('PoolAddr')
    expect(out.instrument).toBe('dlmm_lp')
    const dlmm = (out.domain_features as { dlmm?: { pool_volume_24h?: number } }).dlmm
    expect(dlmm?.pool_volume_24h).toBe(50_000)
    expect(out.volume_at_entry).toBeNull()
  })
})

describe('resolveDlmmMintFromPoolTokens', () => {
  it('prefers non-SOL mint', () => {
    expect(
      resolveDlmmMintFromPoolTokens(
        { address: SOL, symbol: 'SOL' },
        { address: MINT, symbol: 'PEPE' },
      ),
    ).toBe(MINT)
    expect(
      resolveDlmmMintFromPoolTokens(
        { address: MINT, symbol: 'PEPE' },
        { address: SOL, symbol: 'WSOL' },
      ),
    ).toBe(MINT)
  })
})

describe('ML extractor aliases', () => {
  it('accepts first_mcap via canonical path', () => {
    const vector = extractMlFeatureVectorV1({
      first_mcap: 100_000,
      entry_mcap_band: '51-100k',
      organic_score: 70,
      top_holders_pct: 12,
      token_age_hours: 1.5,
      volume_at_entry: 5000,
      entry_template: 'first_seen',
    })
    expect(vector).not.toBeNull()
    expect(vector!.log_entry_mcap).toBeCloseTo(Math.log1p(100_000), 5)
  })
})
