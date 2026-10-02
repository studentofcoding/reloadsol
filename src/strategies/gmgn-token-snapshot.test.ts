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

describe('buildGmgnTokenSnapshot — ledger quality', () => {
  it('insiders: OpenAPI suspected_insider_hold_rate wins when present', () => {
    const snap = buildGmgnTokenSnapshot({}, { suspected_insider_hold_rate: 0.07, rat_trader_amount_rate: 0.5 })
    expect(snap.insidersHoldPct).toBeCloseTo(7, 5)
  })

  it('insiders: falls back to the rat-trader share (web payload carries only that)', () => {
    expect(buildGmgnTokenSnapshot({}, { rat_trader_amount_rate: 0.12 }).insidersHoldPct).toBeCloseTo(12, 5)
    expect(
      buildGmgnTokenSnapshot({ stat: { top_rat_trader_percentage: 0.03 } }, {}).insidersHoldPct,
    ).toBeCloseTo(3, 5)
  })

  it('insiders: stays null when no source exists (never invented)', () => {
    expect(buildGmgnTokenSnapshot({}, {}).insidersHoldPct).toBeNull()
  })

  it('dev hold: no source key → null, not 0', () => {
    expect(buildGmgnTokenSnapshot({}, {}).devHoldPct).toBeNull()
    expect(buildGmgnTokenSnapshot({}, { creator_balance_rate: null }).devHoldPct).toBeNull()
    expect(buildGmgnTokenSnapshot({}, { creator_balance_rate: '' }).devHoldPct).toBeNull()
  })

  it('dev hold: a real 0 is kept, but a 0 that contradicts creator_hold is unknown', () => {
    expect(buildGmgnTokenSnapshot({}, { creator_balance_rate: 0 }).devHoldPct).toBe(0)
    expect(
      buildGmgnTokenSnapshot({}, { creator_balance_rate: 0, creator_token_status: 'creator_close' }).devHoldPct,
    ).toBe(0)
    expect(
      buildGmgnTokenSnapshot({}, { creator_balance_rate: 0, creator_token_status: 'creator_hold' }).devHoldPct,
    ).toBeNull()
    expect(
      buildGmgnTokenSnapshot({}, { creator_balance_rate: 0.04, creator_token_status: 'creator_hold' }).devHoldPct,
    ).toBeCloseTo(4, 5)
  })
})
