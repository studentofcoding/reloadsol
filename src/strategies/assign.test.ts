import { describe, expect, it } from 'vitest'
import { assignTokenToStrategy } from './assign'
import { TRENDING_BOT_STRATEGIES } from './registry'
import { tokenMatchesTrendingBotStrategy } from './strategy-filters'

describe('tokenMatchesTrendingBotStrategy', () => {
  it('rejects sub-200k token for att', () => {
    expect(
      tokenMatchesTrendingBotStrategy(
        { market_cap: 45_000, organic_score: 70, top_holders_pct: 20 },
        TRENDING_BOT_STRATEGIES.att,
      ),
    ).toBe(false)
  })

  it('accepts 250k token for att', () => {
    expect(
      tokenMatchesTrendingBotStrategy(
        { market_cap: 250_000, organic_score: 70, top_holders_pct: 20 },
        TRENDING_BOT_STRATEGIES.att,
      ),
    ).toBe(true)
  })

  it('accepts 45k token for lowcap_moonbag', () => {
    expect(
      tokenMatchesTrendingBotStrategy(
        { market_cap: 45_000, organic_score: 50, top_holders_pct: 20 },
        TRENDING_BOT_STRATEGIES.lowcap_moonbag,
      ),
    ).toBe(true)
  })
})

describe('assignTokenToStrategy', () => {
  const strategies = ['att', 'lowcap_moonbag']
  const allocation = { att: 0.5, lowcap_moonbag: 0.5 }

  it('assigns lowcap_moonbag for 45k token when both active', () => {
    const result = assignTokenToStrategy(
      { market_cap: 45_000, organic_score: 50, top_holders_pct: 20 },
      strategies,
      allocation,
      TRENDING_BOT_STRATEGIES,
    )
    expect(result).toBe('lowcap_moonbag')
  })

  it('assigns att for 250k token when both active', () => {
    const result = assignTokenToStrategy(
      { market_cap: 250_000, organic_score: 70, top_holders_pct: 20 },
      strategies,
      allocation,
      TRENDING_BOT_STRATEGIES,
    )
    expect(result).toBe('att')
  })
})
