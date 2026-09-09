/** Client-side batch token metadata via POST /api/jupiter/metadata. */

export type TokenDisplayMeta = {
  symbol: string | null
  name: string | null
  logoURI: string | null
}

/** The metadata API returns these placeholders when Jupiter has no data. */
function cleanSymbol(symbol: unknown): string | null {
  if (typeof symbol !== 'string' || !symbol.trim()) return null
  return symbol === 'TOKEN' ? null : symbol
}

function cleanName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return null
  return name === 'Unknown Token' ? null : name
}

/**
 * True when a token row carries only the fabricated placeholder identity
 * ('Unknown' / 'TOKEN' / 'Unknown Token'). Such rows must never overwrite a
 * good symbol/name from the Jupiter portfolio feed.
 */
export function isPlaceholderTokenIdentity(input: {
  symbol?: string | null
  name?: string | null
} | null | undefined): boolean {
  if (!input) return true
  const symbol = (input.symbol ?? '').trim().toLowerCase()
  const name = (input.name ?? '').trim().toLowerCase()
  const symbolUsable =
    symbol !== '' && symbol !== 'unknown' && symbol !== 'token'
  const nameUsable =
    name !== '' && name !== 'unknown' && name !== 'unknown token'
  return !symbolUsable && !nameUsable
}

export async function fetchTokenMetadataBatch(
  mints: string[],
): Promise<Map<string, TokenDisplayMeta>> {
  const map = new Map<string, TokenDisplayMeta>()
  const unique = Array.from(new Set(mints.filter(Boolean)))
  if (unique.length === 0) return map

  try {
    const response = await fetch('/api/jupiter/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mints: unique }),
    })
    if (!response.ok) return map

    const json = await response.json()
    const results = (json?.results ?? {}) as Record<
      string,
      { data?: { symbol?: string; name?: string; logoURI?: string } }
    >
    for (const [mint, result] of Object.entries(results)) {
      const data = result?.data
      if (!data) continue
      map.set(mint, {
        symbol: cleanSymbol(data.symbol),
        name: cleanName(data.name),
        logoURI: typeof data.logoURI === 'string' ? data.logoURI : null,
      })
    }
  } catch (error) {
    console.warn('Token metadata batch fetch failed:', error)
  }
  return map
}
