import { describe, expect, it } from 'vitest'
import { computeSocialScoreBoost, DEFAULT_SOCIAL_SCORING_WEIGHTS } from '@/strategies/social-scoring'
import { EMPTY_SOCIAL_SNAPSHOT } from '@/strategies/social/types'
import { fomoWalletEdge, shapeDemandRow } from './fomo-demand'

describe('fomo-demand', () => {
  it('shapes a demand row into organic buy / toxic ratio', () => {
    const d = shapeDemandRow({ buy_usd: '3000', buyers: '7', sell_usd: '1000' })
    expect(d.organicBuyUsd).toBe(3000)
    expect(d.uniqueBuyers).toBe(7)
    expect(d.toxicRatio).toBeCloseTo(0.25)
    expect(shapeDemandRow({ buy_usd: null, buyers: null, sell_usd: null }).toxicRatio).toBe(0)
  })

  it('wallet edge: neutral below sample floor, scales with win rate and pnl sign', () => {
    expect(fomoWalletEdge(null)).toBe(1)
    expect(fomoWalletEdge({ closed_trades: 2, win_rate: 1 })).toBe(1)
    expect(fomoWalletEdge({ closed_trades: 20, win_rate: 0.75, realized_pnl: 500 })).toBe(1.7)
    expect(fomoWalletEdge({ closed_trades: 20, win_rate: 25, realized_pnl: -50 })).toBe(0.3)
  })

  it('social boost weights fomo buys by edge instead of the flat smart-wallet bonus', () => {
    const w = DEFAULT_SOCIAL_SCORING_WEIGHTS
    const sharp = computeSocialScoreBoost({ ...EMPTY_SOCIAL_SNAPSHOT, fomo_buy_count_1h: 2, fomo_edge_1h: 1.5 }, w)
    const dull = computeSocialScoreBoost({ ...EMPTY_SOCIAL_SNAPSHOT, fomo_buy_count_1h: 2, fomo_edge_1h: 0.4 }, w)
    const none = computeSocialScoreBoost(EMPTY_SOCIAL_SNAPSHOT, w)
    expect(sharp.boost).toBe(Math.round(w.smartWalletBuyBonus * 1.5))
    expect(dull.boost).toBe(Math.round(w.smartWalletBuyBonus * 0.4))
    expect(none.boost).toBe(0)
  })
})
