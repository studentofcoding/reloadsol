import { describe, expect, it } from 'vitest'
import {
  computeGmgnActivityScore,
  extractGmgnScoreFieldsFromSocialEvents,
  scoreGmgnActivity,
} from './gmgn-activity-score'
import type { NormalizedGmgnTradeRow } from './gmgn-activity-score'

function row(
  partial: Partial<NormalizedGmgnTradeRow> & Pick<NormalizedGmgnTradeRow, 'tokenAddress' | 'source'>,
): NormalizedGmgnTradeRow {
  return {
    symbol: 'TEST',
    walletAddress: 'wallet1',
    tradeUsd: 100,
    tradeAt: new Date('2026-07-10T12:00:00.000Z'),
    walletTags: [],
    ...partial,
  }
}

describe('computeGmgnActivityScore', () => {
  it('rewards SM+KOL overlap and cluster size', () => {
    const score = computeGmgnActivityScore({
      smWalletCount: 12,
      kolWalletCount: 7,
      smBuyUsd: 500_000,
      kolBuyUsd: 200_000,
      latestTradeAgeMin: 10,
    })
    expect(score).toBeGreaterThan(100)
  })
})

describe('scoreGmgnActivity', () => {
  it('aggregates per token and sorts by score desc', () => {
    const now = new Date('2026-07-10T12:30:00.000Z')
    const results = scoreGmgnActivity(
      [
        row({
          tokenAddress: 'mintA',
          source: 'smartmoney',
          walletAddress: 'sm1',
          tradeAt: new Date('2026-07-10T12:20:00.000Z'),
        }),
        row({
          tokenAddress: 'mintA',
          source: 'smartmoney',
          walletAddress: 'sm2',
          tradeAt: new Date('2026-07-10T12:25:00.000Z'),
        }),
        row({
          tokenAddress: 'mintA',
          source: 'kol',
          walletAddress: 'kol1',
          tradeAt: new Date('2026-07-10T12:28:00.000Z'),
        }),
        row({
          tokenAddress: 'mintB',
          source: 'kol',
          walletAddress: 'kol2',
          tradeAt: new Date('2026-07-10T12:10:00.000Z'),
        }),
      ],
      { now, windowMinutes: 60 },
    )

    expect(results).toHaveLength(2)
    expect(results[0].tokenAddress).toBe('mintA')
    expect(results[0].metrics.has_sm_kol_overlap).toBe(true)
    expect(results[0].discoverySources).toEqual(['smartmoney', 'kol'])
  })
})

describe('extractGmgnScoreFieldsFromSocialEvents', () => {
  it('reads max score from gmgn_hot events in window', () => {
    const fields = extractGmgnScoreFieldsFromSocialEvents(
      [
        {
          source: 'gmgn_hot',
          event_type: 'wallet_buy',
          occurred_at: '2026-07-10T12:00:00.000Z',
          raw_metadata: {
            gmgn_activity_score: 85,
            sm_wallet_count_60m: 12,
            kol_wallet_count_60m: 7,
            sm_buy_usd_60m: 1000,
            kol_buy_usd_60m: 500,
            discovery_sources: ['smartmoney', 'kol'],
          },
        },
      ],
      new Date('2026-07-10T12:30:00.000Z'),
    )

    expect(fields.gmgn_activity_score).toBe(85)
    expect(fields.has_gmgn_hot_signal).toBe(1)
    expect(fields.sm_wallet_count_60m).toBe(12)
  })
})
