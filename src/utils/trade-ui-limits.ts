/** Shared buy/sell UI caps so a batch stays quick (Kyber + one BatchExecutor tx). */

export const MAX_TRADE_TOKENS = 5
export const MIN_BUY_USD_PER_TOKEN = 5

export function capTradeTokens<T>(items: T[], max = MAX_TRADE_TOKENS): T[] {
  return items.length <= max ? items : items.slice(0, max)
}

/** True when total spend split across `tokenCount` is at least $5 per token. */
export function buyMeetsMinUsdPerToken(
  totalHuman: number,
  tokenCount: number,
  usdPerUnit: number,
): boolean {
  if (!(tokenCount > 0) || !(totalHuman > 0) || !(usdPerUnit > 0)) return false
  return (totalHuman / tokenCount) * usdPerUnit >= MIN_BUY_USD_PER_TOKEN
}

/**
 * Button gate: allow click while USD/spot is still loading; submit re-checks
 * with a fresh quote once price is known.
 */
export function buyMeetsMinUsdPerTokenOrPending(
  totalHuman: number,
  tokenCount: number,
  usdPerUnit: number,
): boolean {
  if (!(tokenCount > 0) || !(totalHuman > 0)) return false
  if (!(usdPerUnit > 0)) return true
  return buyMeetsMinUsdPerToken(totalHuman, tokenCount, usdPerUnit)
}

/** Spend units needed for $5 × tokens (at least one token). */
export function minBuyHumanAmount(
  tokenCount: number,
  usdPerUnit: number,
): number {
  if (!(usdPerUnit > 0)) return 0
  return (MIN_BUY_USD_PER_TOKEN * Math.max(1, tokenCount)) / usdPerUnit
}

/** Range-slider floor so 1% steps never go below the $5/token minimum. */
export function minBuySliderPercent(
  balance: number,
  tokenCount: number,
  usdPerUnit: number,
  maxPercent: number,
): number {
  if (!(balance > 0)) return 0
  const minHuman = minBuyHumanAmount(tokenCount, usdPerUnit)
  if (!(minHuman > 0)) return 0
  return Math.min(maxPercent, Math.ceil((minHuman / balance) * 100))
}
