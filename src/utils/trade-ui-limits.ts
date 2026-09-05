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
