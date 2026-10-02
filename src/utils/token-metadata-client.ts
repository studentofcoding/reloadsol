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

/** Mints per POST. The route caps a request at 500; stay well under it. */
export const METADATA_BATCH_CHUNK = 100

/**
 * Batch display metadata for `mints`, in POSTs of at most METADATA_BATCH_CHUNK.
 *
 * Throws when any POST fails (network error or non-2xx) so react-query treats
 * the query as failed and retries, instead of caching an empty Map as a
 * success for the whole staleTime.
 */
export async function fetchTokenMetadataBatch(
  mints: string[],
): Promise<Map<string, TokenDisplayMeta>> {
  const map = new Map<string, TokenDisplayMeta>()
  const unique = Array.from(new Set(mints.filter(Boolean)))
  if (unique.length === 0) return map

  for (let i = 0; i < unique.length; i += METADATA_BATCH_CHUNK) {
    const chunk = unique.slice(i, i + METADATA_BATCH_CHUNK)
    const response = await fetch('/api/jupiter/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mints: chunk }),
    })
    if (!response.ok) {
      throw new Error(`Token metadata batch failed: HTTP ${response.status}`)
    }

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
  }
  return map
}
