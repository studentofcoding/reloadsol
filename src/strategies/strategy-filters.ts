import type { TrendingBotStrategy } from './types'

export type StrategyMatchToken = {
  market_cap?: number | null
  organic_score?: number | null
  top_holders_pct?: number | null
}

/** Whether a token fits a trending_bot strategy band (conditions + filtering). */
export function tokenMatchesTrendingBotStrategy(
  token: StrategyMatchToken,
  strategy: TrendingBotStrategy,
): boolean {
  const marketCap = token.market_cap ?? 0
  const organicScore = token.organic_score ?? 0
  const topHolders = token.top_holders_pct ?? null

  const c = strategy.conditions
  if (c?.min_market_cap && marketCap < c.min_market_cap) return false
  if (c?.max_market_cap && marketCap > c.max_market_cap) return false
  if (c?.min_organic_score && organicScore < c.min_organic_score) return false

  const f = strategy.filtering
  if (f && f.enabled !== false) {
    if (f.mcap?.min && marketCap < f.mcap.min) return false
    if (f.mcap?.max && marketCap > f.mcap.max) return false
    if (f.organicScore?.min && organicScore < f.organicScore.min) return false
    if (f.topHoldersPercentage?.max) {
      if (topHolders == null || topHolders >= f.topHoldersPercentage.max) {
        return false
      }
    }
  }

  return true
}
