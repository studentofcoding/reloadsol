/**
 * DexScreener token volume fallback when Jupiter has no stats windows.
 * https://api.dexscreener.com/latest/dex/tokens/{mint}
 */

export type DexScreenerVolumeWindow = 'm5' | 'h1' | 'h24'

export type DexScreenerVolumeHints = {
  volume: number
  window: DexScreenerVolumeWindow
  pairAddress: string | null
}

function finiteOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

type DexPair = {
  pairAddress?: string
  liquidity?: { usd?: number }
  volume?: { m5?: number; h1?: number; h24?: number }
}

/** Pick best pair by liquidity, then m5 → h1 → h24 volume. */
export function parseDexScreenerTokenVolume(
  raw: unknown,
): DexScreenerVolumeHints | null {
  if (!raw || typeof raw !== 'object') return null
  const pairs = (raw as { pairs?: unknown }).pairs
  if (!Array.isArray(pairs) || pairs.length === 0) return null

  const typed = pairs.filter(
    (p): p is DexPair => p != null && typeof p === 'object',
  )
  if (typed.length === 0) return null

  typed.sort((a, b) => {
    const la = finiteOrNull(a.liquidity?.usd) ?? 0
    const lb = finiteOrNull(b.liquidity?.usd) ?? 0
    return lb - la
  })

  for (const pair of typed) {
    const m5 = finiteOrNull(pair.volume?.m5)
    if (m5 != null && m5 >= 0) {
      return {
        volume: m5,
        window: 'm5',
        pairAddress: typeof pair.pairAddress === 'string' ? pair.pairAddress : null,
      }
    }
    const h1 = finiteOrNull(pair.volume?.h1)
    if (h1 != null && h1 >= 0) {
      return {
        volume: h1,
        window: 'h1',
        pairAddress: typeof pair.pairAddress === 'string' ? pair.pairAddress : null,
      }
    }
    const h24 = finiteOrNull(pair.volume?.h24)
    if (h24 != null && h24 >= 0) {
      return {
        volume: h24,
        window: 'h24',
        pairAddress: typeof pair.pairAddress === 'string' ? pair.pairAddress : null,
      }
    }
  }

  return null
}

let lastDexRequestAt = 0
const DEX_MIN_INTERVAL_MS = 300

export async function fetchDexScreenerVolumeHints(
  mintAddress: string,
): Promise<DexScreenerVolumeHints | null> {
  const mint = mintAddress.trim()
  if (!mint) return null

  const now = Date.now()
  const wait = DEX_MIN_INTERVAL_MS - (now - lastDexRequestAt)
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait))
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      },
    )
    lastDexRequestAt = Date.now()
    clearTimeout(timeoutId)
    if (!res.ok) return null
    const json: unknown = await res.json()
    return parseDexScreenerTokenVolume(json)
  } catch {
    return null
  }
}
