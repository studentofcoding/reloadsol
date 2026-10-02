import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn() }))

import { query } from '@/utils/db'
import { PATTERN_TOP_SOURCE_GMGN_FOMO } from './pattern-features'
import {
  filterSocialOnlyCandidates,
  loadFomoBurstCandidates,
  passesSocialOnlyRollupGate,
  socialBurstWindowMinutes,
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
  it('registry seeds social_only_fomo_gt7 FOMO-first (no TRENDINGSSOL co-req)', () => {
    const s = SOCIAL_STRATEGIES.social_only_fomo_gt7
    expect(s.id).toBe('social_only_fomo_gt7')
    expect(s.chain).toBe('sol')
    expect(s.is_active).toBe(true)
    expect(s.config.entry.minMentions30m).toBe(7)
    expect(s.config.entry.topSource).toBe(PATTERN_TOP_SOURCE_GMGN_FOMO)
    expect(s.config.entry.requireMentionSources).toEqual([])
    expect(s.config.entry.listenChannelPeers).toBeUndefined()
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

  it('filters candidates; empty requireMentionSources does not need secondary', () => {
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
    })

    expect(eligible.map((c) => c.tokenAddress)).toEqual([mintOk])
    expect(skipped.some((s) => s.includes('present_elsewhere'))).toBe(true)
    expect(skipped.some((s) => s.includes('already_closed'))).toBe(true)
    expect(skipped.some((s) => s.includes('low_mentions'))).toBe(true)
  })

  it('when requireMentionSources set, skips mint without secondary source', () => {
    const mintMissing = 'MintMissing999'
    const mintOk = 'MintWithTrend888'
    const entryWithTrend = {
      ...entry,
      requireMentionSources: ['TRENDINGSSOL'],
    }
    const { eligible, skipped } = filterSocialOnlyCandidates({
      rollups: [
        rollup({ token_address: mintMissing, mention_count_30m: 20 }),
        rollup({ token_address: mintOk, mention_count_30m: 12 }),
      ],
      entry: entryWithTrend,
      presentElsewhere: new Set(),
      openMints: new Set(),
      closedMints: new Set(),
      requiredMentionMints: new Set([mintOk]),
    })

    expect(eligible.map((c) => c.tokenAddress)).toEqual([mintOk])
    expect(skipped.some((s) => s.includes('missing_required_source'))).toBe(true)
  })
})

describe('loadFomoBurstCandidates', () => {
  it('window defaults to 30 min and is env-tunable', () => {
    expect(socialBurstWindowMinutes({})).toBe(30)
    expect(socialBurstWindowMinutes({ SOCIAL_BURST_WINDOW_MIN: '45' })).toBe(45)
    expect(socialBurstWindowMinutes({ SOCIAL_BURST_WINDOW_MIN: 'nope' })).toBe(30)
  })

  it('maps the event burst to rollup shape that passes the existing gate', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [
        {
          token_address: 'MintBurst111',
          mention_count: 9,
          first_seen_at: '2026-09-28T01:36:00.000Z',
          last_event_at: '2026-09-28T01:55:00.000Z',
          unique_channel_count_30m: 1,
          mention_count_24h: 12,
          fomo_buy_count_1h: 2,
          fomo_edge_1h: 1.4,
          mcap: 236_538,
          first_mcap: 31_992,
          mcap_growth_percent: 639,
          organic_score: 46,
          top_holders_pct: 21.5,
        },
      ],
    } as never)

    const rows = await loadFomoBurstCandidates(entry, { chain: 'sol' })
    expect(rows).toHaveLength(1)
    expect(rows[0].mention_count_30m).toBe(9)
    expect(rows[0].top_source).toBe(PATTERN_TOP_SOURCE_GMGN_FOMO)
    expect(rows[0].unique_channel_count_30m).toBe(1)
    expect(rows[0].mention_count_24h).toBe(12)
    expect(rows[0].mcap).toBe(236_538)
    // A burst still inside the window is eligible even though the sampled
    // rollup's own mention_count_30m had decayed to 0.
    expect(passesSocialOnlyRollupGate(rows[0], entry)).toBeNull()
  })

  it('returns nothing when there are no events in the window', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] } as never)
    expect(await loadFomoBurstCandidates(entry, { chain: 'sol' })).toEqual([])
  })
})
