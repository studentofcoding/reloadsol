import { describe, expect, it } from 'vitest'
import { buildGmgnTokenSnapshot } from '@/strategies/gmgn-token-snapshot'

describe('buildGmgnTokenSnapshot', () => {
  it('maps rates and renounced auth to Yes/No semantics', () => {
    const snap = buildGmgnTokenSnapshot(
      {
        stat: { top_10_holder_rate: 0.1315, creator_hold_rate: 0 },
        wallet_tags_stat: { sniper_wallets: 0 },
        dev: { dexscr_boost_fee: 1, dexscr_boost_ts: Date.now() / 1000 - 5 * 3600 },
      },
      {
        renounced_freeze_account: true,
        renounced_mint: true,
        suspected_insider_hold_rate: 0,
        bundler_trader_amount_rate: 0.0063,
      },
    )
    expect(snap.top10HoldPct).toBeCloseTo(13.15, 1)
    expect(snap.devHoldPct).toBe(0)
    expect(snap.freezeAuthActive).toBe(false)
    expect(snap.mintAuthActive).toBe(false)
    expect(snap.bundlersHoldPct).toBeCloseTo(0.63, 1)
    expect(snap.dexBoostLabel).toMatch(/^Boost/)
  })
})
