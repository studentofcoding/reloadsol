/**
 * Shapes verified against the live public gmgn.ai web multi endpoints (2026-09-28).
 *
 * The real `/mrwapi/v1/multi_token_full_info` row has NO `stat` object and no
 * `dev` block — the hold rates are top-level, and the sniper rate is spelled
 * `top70_sniper_hold_rate`. There is no insider hold rate at all (only an
 * `insider_count` on the holder-stat endpoint).
 */

export function sampleGmgnWebFullInfo(address: string): Record<string, unknown> {
  return {
    address,
    symbol: 'TILE',
    name: 'Tile',
    holder_count: 88,
    liquidity: '4100',
    top_10_holder_rate: 0.1315,
    creator_hold_rate: 0.02,
    dev_team_hold_rate: 0.01,
    top70_sniper_hold_rate: 0.05,
    top_bundler_trader_percentage: 0.0063,
    bot_degen_rate: 0.11,
    security: {
      top_10_holder_rate: 0.1315,
      renounced_mint: true,
      renounced_freeze_account: false,
      burn_status: 'burn',
      is_honeypot: '',
    },
  }
}

export function sampleGmgnWebWindow(address: string, boostTs: number): Record<string, unknown> {
  return {
    address,
    holder_count: 88,
    price: { price: '0.00012', price_1m: '0.0001' },
    dev: {
      dexscr_boost_fee: 1,
      dexscr_boost_ts: boostTs,
    },
  }
}

export const sampleGmgnWebHolderStat: Record<string, unknown> = {
  sniper_count: 7,
  insider_count: 3,
  bundler_count: 4,
}
