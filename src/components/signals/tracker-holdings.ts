import type { UserToken } from '@/utils/jupiter'

export type TrackerHolding = {
  usd: number
  amount: number
}

export function holdingMintKey(mint: string): string {
  return mint.trim().toLowerCase()
}

/** Map holdings list → mint lookup. Only tokens with uiAmount > 0. */
export function mapUserTokensToHoldings(
  tokens: UserToken[],
): Record<string, TrackerHolding> {
  const out: Record<string, TrackerHolding> = {}
  for (const token of tokens) {
    const mint = token.mintAddress?.trim()
    if (!mint || !(token.uiAmount > 0)) continue
    const key = holdingMintKey(mint)
    const usd = Number.isFinite(token.usdValue) ? token.usdValue : 0
    const prev = out[key]
    if (prev) {
      out[key] = { usd: prev.usd + usd, amount: prev.amount + token.uiAmount }
    } else {
      out[key] = { usd, amount: token.uiAmount }
    }
  }
  return out
}

export function lookupHolding(
  map: Record<string, TrackerHolding>,
  mint: string,
): TrackerHolding | undefined {
  if (!mint) return undefined
  return map[mint] ?? map[holdingMintKey(mint)]
}

export function formatHoldingUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '$0.00'
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export function sumHeldCatchUsd(
  catchMints: string[],
  holdings: Record<string, TrackerHolding>,
): { count: number; usd: number } {
  let count = 0
  let usd = 0
  for (const mint of catchMints) {
    const held = lookupHolding(holdings, mint)
    if (!held || !(held.amount > 0)) continue
    count += 1
    usd += held.usd
  }
  return { count, usd }
}
