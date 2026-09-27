/** Minimal shapes observed on the public gmgn.ai web multi endpoints (2026-09-27). */

export function sampleGmgnWebFullInfo(address: string): Record<string, unknown> {
  return {
    address,
    symbol: 'TILE',
    name: 'Tile',
    holder_count: 88,
    liquidity: '4100',
    stat: {
      holder_count: 88,
      top_10_holder_rate: 0.1315,
      creator_hold_rate: 0.02,
      dev_team_hold_rate: 0.01,
      sniper_hold_rate: 0.05,
      top_bundler_trader_percentage: 0.0063,
      bot_degen_rate: 0.11,
      suspected_insider_hold_rate: 0.04,
    },
    security: {
      renounced_mint: true,
      renounced_freeze_account: false,
      burn_status: 'burn',
      is_honeypot: '',
    },
    dev: {
      creator_address: 'Dev1111111111111111111111111111111111111',
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
