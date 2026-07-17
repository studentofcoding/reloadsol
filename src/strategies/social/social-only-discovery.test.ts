import { describe, expect, it } from 'vitest'
import { PATTERN_TOP_SOURCE_GMGN_FOMO } from './pattern-features'
import {
  filterSocialOnlyCandidates,
  passesSocialOnlyRollupGate,
} from './social-only-discovery'
import type { SocialTokenRollupRow } from './types'
import { SOCIAL_STRATEGIES } from '@/strategies/registry'
import { mergeSocialStrategy } from '@/strategies/merge-social'

const entry = SOCIAL_STRATEGIES.social_only_fomo_gt7.config.entry

function rollup(
  partial: Partial<SocialTokenRollupRow> & { token_address: string },
): SocialTokenRollupRow {
  return {
    first_seen_at: null,
    first_source: null,
    first_channel: null,
    mention_count_5m: 0,
    mention_count_30m: 8,
    mention_count_24h: 8,
    unique_channel_count_30m: 1,
    smart_wallet_buy_count_1h: 0,
    smart_wallet_buy_sol_1h: 0,
    top_source: PATTERN_TOP_SOURCE_GMGN_FOMO,
    last_event_at: null,
    updated_at: new Date().toISOString(),
    ...partial,
  }
}

describe('social-only-discovery', () => {
  it('registry seeds social_only_fomo_gt7', () => {
    const s = SOCIAL_STRATEGIES.social_only_fomo_gt7
    expect(s.id).toBe('social_only_fomo_gt7')
    expect(s.is_active).toBe(true)
    expect(s.config.entry.minMentions30m).toBe(7)
    expect(s.config.entry.topSource).toBe(PATTERN_TOP_SOURCE_GMGN_FOMO)
    expect(s.config.entry.requireMentionSources).toEqual(['TRENDINGSSOL'])
    expect(s.config.entry.listenChannelPeers).toEqual({
      TRENDINGSSOL: '@trendingssol',
    })
  })

  it('mergeSocialStrategy overlays notify and entry', () => {
    const merged = mergeSocialStrategy(
      SOCIAL_STRATEGIES.social_only_fomo_gt7,
      {
        entry: {
          minMentions30m: 10,
          listenChannelPeers: { TRENDINGSSOL: '@customchannel' },
        },
        notify: { telegram: false, ui: true },
      },
      true,
    )
    expect(merged.config.entry.minMentions30m).toBe(10)
    expect(merged.config.entry.listenChannelPeers).toEqual({
      TRENDINGSSOL: '@customchannel',
    })
    expect(merged.config.notify).toEqual({ telegram: false, ui: true })
    expect(merged.is_active).toBe(true)
  })

  it('passes FOMO gt7 gate', () => {
    expect(
      passesSocialOnlyRollupGate(
        { mention_count_30m: 8, top_source: PATTERN_TOP_SOURCE_GMGN_FOMO },
        entry,
      ),
    ).toBeNull()
  })

  it('rejects low mentions and wrong source', () => {
    expect(
      passesSocialOnlyRollupGate(
        { mention_count_30m: 7, top_source: PATTERN_TOP_SOURCE_GMGN_FOMO },
        entry,
      ),
    ).toBe('low_mentions')
    expect(
      passesSocialOnlyRollupGate(
        { mention_count_30m: 20, top_source: 'other' },
        entry,
      ),
    ).toBe('wrong_source')
  })

  it('filters only-social candidates', () => {
    const mintOk = 'MintOk111'
    const mintElsewhere = 'MintElse222'
    const mintClosed = 'MintClosed333'
    const { eligible, skipped } = filterSocialOnlyCandidates({
      rollups: [
        rollup({ token_address: mintOk, mention_count_30m: 12 }),
        rollup({ token_address: mintElsewhere, mention_count_30m: 15 }),
        rollup({ token_address: mintClosed, mention_count_30m: 9 }),
        rollup({
          token_address: 'MintLow',
          mention_count_30m: 3,
        }),
      ],
      entry,
      presentElsewhere: new Set([mintElsewhere]),
      openMints: new Set(),
      closedMints: new Set([mintClosed]),
      requiredMentionMints: new Set([mintOk, mintElsewhere, mintClosed]),
    })

    expect(eligible.map((c) => c.tokenAddress)).toEqual([mintOk])
    expect(skipped.some((s) => s.includes('present_elsewhere'))).toBe(true)
    expect(skipped.some((s) => s.includes('already_closed'))).toBe(true)
    expect(skipped.some((s) => s.includes('low_mentions'))).toBe(true)
  })

  it('skips FOMO-ok mint without required secondary source', () => {
    const mintMissing = 'MintMissing999'
    const mintOk = 'MintWithTrend888'
    const { eligible, skipped } = filterSocialOnlyCandidates({
      rollups: [
        rollup({ token_address: mintMissing, mention_count_30m: 20 }),
        rollup({ token_address: mintOk, mention_count_30m: 12 }),
      ],
      entry,
      presentElsewhere: new Set(),
      openMints: new Set(),
      closedMints: new Set(),
      requiredMentionMints: new Set([mintOk]),
    })

    expect(eligible.map((c) => c.tokenAddress)).toEqual([mintOk])
    expect(skipped.some((s) => s.includes('missing_required_source'))).toBe(true)
  })
})
