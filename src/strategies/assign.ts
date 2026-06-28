import type { TrendingBotStrategy } from './types'
import {
  tokenMatchesTrendingBotStrategy,
  type StrategyMatchToken,
} from './strategy-filters'

export function assignTokenToStrategy(
  token: StrategyMatchToken & { token_symbol?: string },
  strategies: string[],
  allocation: Record<string, number>,
  registry: Record<string, TrendingBotStrategy>,
): string | null {
  const eligible = strategies.filter((strategyId) => {
    const strategy = registry[strategyId]
    return strategy && tokenMatchesTrendingBotStrategy(token, strategy)
  })

  if (eligible.length === 0) return null

  if (eligible.length === 1) return eligible[0]

  const random = Math.random()
  let cumulativeWeight = 0
  const eligibleWeight = eligible.reduce(
    (sum, id) => sum + (allocation[id] ?? 0),
    0,
  )

  if (eligibleWeight <= 0) return eligible[0]

  for (const strategyId of eligible) {
    cumulativeWeight += (allocation[strategyId] ?? 0) / eligibleWeight
    if (random <= cumulativeWeight) {
      return strategyId
    }
  }

  return eligible[0]
}
