import { describe, expect, it } from 'vitest'
import type { GmgnMarketRankRow } from '@/utils/gmgn-api'
import {
  applyRobinhoodLpFilters,
  communityCue,
  fomoCue,
  isFlapLaunchpad,
  ROBINHOOD_LP_DEFAULTS,
} from './robinhood-screen'

function row(partial: Partial<GmgnMarketRankRow> & { address: string }): GmgnMarketRankRow {
  return {
    symbol: 'TEST',
    name: 'Test Token',
    market_cap: 600_000,
    volume: 1_500_000,
    liquidity: 100_000,
    holder_count: 500,
    launchpad: 'noxa',
    launchpad_platform: 'noxa',
    website: 'https://example.com',
    twitter_username: 'https://x.com/test',
    telegram: 'https://t.me/test',
    price_change_percent: 10,
    hot_level: 1,
    smart_degen_count: 5,
    renowned_count: 5,
    visiting_count: 50,
    ...partial,
  }
}

describe('robinhood-screen', () => {
  it('defaults match LP playbook hard gates', () => {
    expect(ROBINHOOD_LP_DEFAULTS.minMcap).toBe(500_000)
    expect(ROBINHOOD_LP_DEFAULTS.minVolume).toBe(1_000_000)
    expect(ROBINHOOD_LP_DEFAULTS.interval).toBe('24h')
    expect(ROBINHOOD_LP_DEFAULTS.chain).toBe('robinhood')
  })

  it('detects flap launchpads and websites', () => {
    expect(isFlapLaunchpad({ launchpad: 'flap' })).toBe(true)
    expect(isFlapLaunchpad({ launchpad_platform: 'flap_stocks' })).toBe(true)
    expect(isFlapLaunchpad({ website: 'https://flap.fun/x' })).toBe(true)
    expect(isFlapLaunchpad({ launchpad: 'noxa' })).toBe(false)
  })

  it('communityCue prefers twitter + telegram/website', () => {
    expect(
      communityCue({
        twitter_username: '@a',
        telegram: 'https://t.me/a',
        website: '',
      }),
    ).toBe('komun_ok')
    expect(
      communityCue({
        twitter_username: '@a',
        telegram: '',
        website: 'https://a.com',
      }),
    ).toBe('komun_ok')
    expect(
      communityCue({
        twitter_username: '',
        telegram: 'https://t.me/a',
        website: 'https://a.com',
      }),
    ).toBe('komun_thin')
  })

  it('fomoCue flags hot activity', () => {
    expect(fomoCue({ hot_level: 3 })).toBe('fomo_hot')
    expect(fomoCue({ price_change_percent: 40 })).toBe('fomo_hot')
    expect(
      fomoCue({
        hot_level: 0,
        price_change_percent: 5,
        smart_degen_count: 2,
        renowned_count: 2,
        visiting_count: 10,
      }),
    ).toBe('fomo_quiet')
  })

  it('applyRobinhoodLpFilters enforces mcap/vol and drops flap', () => {
    const tokens = applyRobinhoodLpFilters([
      row({ address: '0xok', market_cap: 600_000, volume: 2_000_000 }),
      row({ address: '0xlowmcap', market_cap: 400_000, volume: 2_000_000 }),
      row({ address: '0xlowvol', market_cap: 600_000, volume: 900_000 }),
      row({
        address: '0xflap',
        market_cap: 2_000_000,
        volume: 3_000_000,
        launchpad: 'flap',
        launchpad_platform: 'flap_stocks',
      }),
      row({ address: '0xboundary', market_cap: 500_000, volume: 1_000_000 }),
    ])

    expect(tokens.map((t) => t.address)).toEqual(['0xok'])
    expect(tokens[0]?.communityCue).toBe('komun_ok')
  })
})
