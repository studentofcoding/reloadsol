import type { TrendingBotStrategy } from './types'

export function assignTokenToStrategy(
  token: {
    token_symbol?: string
    market_cap?: number
    organic_score?: number
  },
  strategies: string[],
  allocation: Record<string, number>,
  registry: Record<string, TrendingBotStrategy>,
): string {
  const marketCap = token.market_cap || 0
  const organicScore = token.organic_score || 0

  for (const strategyId of strategies) {
    const strategy = registry[strategyId]
    if (!strategy?.conditions) continue

    let meetsConditions = true
    const c = strategy.conditions

    if (c.min_market_cap && marketCap < c.min_market_cap) {
      meetsConditions = false
    }
    if (c.max_market_cap && marketCap > c.max_market_cap) {
      meetsConditions = false
    }
    if (c.min_organic_score && organicScore < c.min_organic_score) {
      meetsConditions = false
    }

    if (meetsConditions) {
      return strategyId
    }
  }

  const random = Math.random()
  let cumulativeWeight = 0

  for (const strategyId of strategies) {
    cumulativeWeight += allocation[strategyId] ?? 0
    if (random <= cumulativeWeight) {
      return strategyId
    }
  }

  return strategies[0]
}
