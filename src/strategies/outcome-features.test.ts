import { describe, expect, it } from 'vitest'
import {
  formatMlExitOverlaySummary,
  readEntryMcap,
  readFirstSeenAt,
  readMlExitOverlayMode,
  readMlGatePBad,
  readMlPotentialTier,
  readVolumeAtEntry,
} from './outcome-features'
import { toCanonicalEntryFeatures } from './canonical-features'
import { extractMlFeatureVectorV1 } from './ml-training-features'

describe('outcome-features ML readers', () => {
  it('reads entry_mcap from first_mcap alias', () => {
    expect(readEntryMcap({ first_mcap: 80_000 })).toBe(80_000)
  })

  it('reads volume from volume_5m alias', () => {
    expect(readVolumeAtEntry({ volume_5m: 1200 })).toBe(1200)
  })

  it('reads first_seen_at', () => {
    expect(readFirstSeenAt({ first_seen_at: '2026-01-01T00:00:00Z' })).toBe(
      '2026-01-01T00:00:00Z',
    )
  })

  it('reads gate / potential / exit overlay fields', () => {
    const features = {
      ml_gate_p_bad: 0.22,
      ml_potential_tier: 3,
      ml_exit_overlay_mode: 'shadow',
      ml_exit_base_take_profit_pct: 200,
      ml_exit_effective_take_profit_pct: 250,
      ml_exit_base_stop_loss_pct: -50,
      ml_exit_effective_stop_loss_pct: -50,
    }
    expect(readMlGatePBad(features)).toBe(0.22)
    expect(readMlPotentialTier(features)).toBe(3)
    expect(readMlExitOverlayMode(features)).toBe('shadow')
    expect(formatMlExitOverlaySummary(features)).toBe(
      'TP 200→250 · SL -50→-50 shadow',
    )
  })

  it('returns null exit summary when overlay missing', () => {
    expect(formatMlExitOverlaySummary({})).toBeNull()
  })
})

describe('canonical age derive + first_mcap extract', () => {
  it('derives token_age_hours from first_seen_at + entryAt', () => {
    const out = toCanonicalEntryFeatures(
      {
        first_mcap: 100_000,
        first_seen_at: '2026-01-01T00:00:00Z',
        organic_score: 70,
        top_holders_pct: 12,
        volume_5m: 5000,
        entry_mcap_band: '51-100k',
        entry_template: 'first_seen',
      },
      'mcap_tracker',
      {
        mintAddress: 'Mint1111111111111111111111111111111111111',
        entryAt: '2026-01-01T02:00:00Z',
      },
    )
    expect(out.token_age_hours).toBe(2)
    expect(out.entry_mcap).toBe(100_000)
  })

  it('extractMlFeatureVectorV1 accepts first_mcap + derived age path', () => {
    const canon = toCanonicalEntryFeatures(
      {
        first_mcap: 100_000,
        first_seen_at: '2026-01-01T00:00:00Z',
        organic_score: 70,
        top_holders_pct: 12,
        volume_5m: 5000,
        entry_mcap_band: '51-100k',
        entry_template: 'first_seen',
      },
      'mcap_tracker',
      { entryAt: '2026-01-01T01:30:00Z' },
    )
    const vector = extractMlFeatureVectorV1(canon)
    expect(vector).not.toBeNull()
    expect(vector!.log_entry_mcap).toBeCloseTo(Math.log1p(100_000), 5)
    expect(vector!.token_age_hours).toBe(1.5)
  })
})
