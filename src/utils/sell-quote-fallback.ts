export const SELL_QUOTE_VALID_MS = 30_000

export function sellAmountRaw(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return '0'
  return Math.trunc(amount).toString()
}

export function sellQuoteAllFailedBanner(successCount: number): string | null {
  if (successCount === 0) {
    // The desk path quotes Jupiter Swap V2 (Lite only if V2 fails) — Raptor is arbitrage-only, so
  // naming it here misattributed every failure.
  return 'Failed to get swap quotes. Please try again.'
  }
  return null
}

/** After Raptor parallel fetch: Jupiter only for misses with no still-valid quote. */
export function mintsNeedingJupiterQuote(
  mints: string[],
  raptorHits: Set<string>,
  existing: Record<string, { timestamp: number }>,
  now: number,
  validMs: number = SELL_QUOTE_VALID_MS,
): string[] {
  return mints.filter((mint) => {
    if (raptorHits.has(mint)) return false
    const prev = existing[mint]
    if (prev && now - prev.timestamp < validMs) return false
    return true
  })
}
