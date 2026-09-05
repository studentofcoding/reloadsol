/** Public Bybit v5 spot ticker. lastPrice is USDT ≈ USD. */

export function parseBybitTickerLast(json: unknown): number {
  const last = (
    json as { result?: { list?: Array<{ lastPrice?: string }> } }
  )?.result?.list?.[0]?.lastPrice
  const n = Number(last)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export async function fetchBybitSpotLast(symbol: string): Promise<number> {
  try {
    const res = await fetch(
      `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`,
      { cache: 'no-store' },
    )
    if (!res.ok) return 0
    return parseBybitTickerLast(await res.json())
  } catch {
    return 0
  }
}
