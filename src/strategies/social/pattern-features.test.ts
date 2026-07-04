import { describe, expect, it } from 'vitest'
import {
  extractPatternFeaturesFromSnapshot,
  patternClassFromCohort,
  PATTERN_FEATURE_KEYS,
} from './pattern-features'
import type { CombinedInternalExport } from './combined-pattern'

describe('patternClassFromCohort', () => {
  it('maps winner/loser to 1/0', () => {
    expect(patternClassFromCohort('winner')).toBe(1)
    expect(patternClassFromCohort('loser')).toBe(0)
    expect(patternClassFromCohort('neutral')).toBeNull()
  })
})

describe('extractPatternFeaturesFromSnapshot', () => {
  it('does not include leaky outcome fields in feature keys', () => {
    const snapshot: CombinedInternalExport = {
      tokenAddress: 'mint1',
      exportedAt: '2026-07-04T18:00:00.000Z',
      mcapTracker: {
        first_mcap: 188574,
        current_mcap: 1030484,
        mcap_growth_percent: 446,
        first_seen_at: '2026-07-04T17:30:00.746Z',
      },
      socialEvents: [
        {
          event_type: 'mention',
          source: 'GMGN_Smart_Money_FOMO',
          channel_id: '-1001',
          occurred_at: '2026-07-04T17:32:33.000Z',
        },
        {
          event_type: 'wallet_buy',
          occurred_at: '2026-07-04T17:35:00.000Z',
        },
      ],
    }

    const vector = extractPatternFeaturesFromSnapshot(snapshot)
    expect(vector).not.toBeNull()
    expect(Object.keys(vector!)).toEqual([...PATTERN_FEATURE_KEYS])
    expect(vector!.log_first_mcap).toBeGreaterThan(0)
    expect(vector!.log_mention_count_30m).toBeGreaterThan(0)
    expect(vector!.source_gmgn_smart_money_fomo).toBe(1)
    expect(vector!.has_smart_wallet_buy).toBe(1)
    expect(vector).not.toHaveProperty('mcap_growth_percent')
  })
})
