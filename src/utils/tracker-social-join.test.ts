import { describe, expect, it } from 'vitest'
import { mapGmgnRankToFilteredToken } from '@/utils/gmgn-trending-filtered'
import { socialUrl } from '@/utils/social-url'
import {
  buildTrackerSocialJoinMap,
  mapTrackerSocialFromTrending,
  mergeTrackerSocialSources,
} from '@/utils/tracker-social-join'

describe('mapTrackerSocialFromTrending', () => {
  it('maps twitter/telegram/website from a GMGN filtered row', () => {
    const mapped = mapGmgnRankToFilteredToken({
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOC',
      market_cap: 600_000,
      volume: 100_000,
      price_change_percent: 10,
      twitter_username: '@soc',
      telegram: 'https://t.me/soc',
      website: 'soc.xyz',
      logo: 'https://example.com/soc.png',
      hot_level: 3,
    })
    expect(mapped).not.toBeNull()
    const join = mapTrackerSocialFromTrending(mapped!)
    expect(join.social).toEqual({
      twitter: '@soc',
      telegram: 'https://t.me/soc',
      website: 'soc.xyz',
    })
    expect(join.logo_url).toBe('https://example.com/soc.png')
    expect(join.organic_score).toBeGreaterThan(0)
    expect(socialUrl(join.social?.twitter, 'twitter')).toBe('https://x.com/soc')
    expect(socialUrl(join.social?.telegram, 'telegram')).toBe('https://t.me/soc')
    expect(socialUrl(join.social?.website, 'website')).toBe('https://soc.xyz')
  })

  it('omits empty socials', () => {
    const join = mapTrackerSocialFromTrending({
      token_address: 'a',
      twitter: '  ',
      organic_score: Number.NaN,
    })
    expect(join.social).toBeUndefined()
    expect(join.organic_score).toBeNull()
    expect(join.logo_url).toBeNull()
  })
})

describe('mergeTrackerSocialSources', () => {
  it('prefers GMGN socials and Jupiter organic/logo', () => {
    const merged = mergeTrackerSocialSources(
      {
        token_address: 'mint',
        twitter: '@gmgn',
        telegram: 'gmgnchat',
        organic_score: 40,
        logo_url: 'https://gmgn.example/a.png',
      },
      {
        token_address: 'mint',
        twitter: '@jup',
        website: 'https://jup.example',
        organic_score: 88,
        logo_url: 'https://jup.example/a.png',
      },
    )
    expect(merged.social).toEqual({
      twitter: '@gmgn',
      telegram: 'gmgnchat',
      website: 'https://jup.example',
    })
    expect(merged.organic_score).toBe(88)
    expect(merged.logo_url).toBe('https://jup.example/a.png')
  })
})

describe('buildTrackerSocialJoinMap', () => {
  it('joins by mint without N+1', () => {
    const map = buildTrackerSocialJoinMap(
      [{ token_address: 'mintA', twitter: '@a' }],
      [{ token_address: 'mintB', website: 'b.io', organic_score: 71 }],
    )
    expect(map.get('mintA')?.social?.twitter).toBe('@a')
    expect(map.get('mintB')?.social?.website).toBe('b.io')
    expect(map.get('mintB')?.organic_score).toBe(71)
    expect(map.has('mintC')).toBe(false)
  })
})
