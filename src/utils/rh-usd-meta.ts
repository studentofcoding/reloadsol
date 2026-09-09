import type { UserToken } from '@/utils/jupiter'
import { tokenInfo, GmgnApiError } from '@/utils/gmgn-api'
import { cacheGet, cacheSet } from '@/utils/redis-cache'
import {
  extractGmgnTokenUsdPrice,
  isEvmAddress,
  RH_BLOCKSCOUT_BASE,
  type RhTokenMeta,
} from '@/utils/rh-wallet-holdings'

// ---------------------------------------------------------------------------
// SERVER-ONLY RH price + metadata helpers. Kept out of rh-wallet-holdings.ts:
// that module is reachable from client bundles (useRhWalletTokens & friends),
// and gmgn-api / redis-cache (ioredis) are server dependencies that break the
// Next client build. Only server routes (ledger ingest/holdings, wallet-tokens)
// import this file.
// ---------------------------------------------------------------------------

export const RH_TOKEN_USD_TTL_S = 60
export const RH_PRICE_FILL_CAP = 15
export const RH_PRICE_FILL_CONCURRENCY = 2

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

/** Cached GMGN USD price for a RH token (0 when unknown, throws on RATE_LIMIT). */
export async function fetchRhTokenUsdCached(address: string): Promise<number> {
  const addr = String(address ?? '').trim().toLowerCase()
  const key = `rh:token-usd:${addr}`
  const cached = await cacheGet<number>(key)
  if (cached != null && cached > 0) return cached
  try {
    const info = await tokenInfo({ chain: 'robinhood', address: addr })
    const px = extractGmgnTokenUsdPrice(info)
    if (px > 0) void cacheSet(key, px, RH_TOKEN_USD_TTL_S)
    return px
  } catch (error) {
    if (error instanceof GmgnApiError && error.code === 'RATE_LIMIT') {
      throw error
    }
    return 0
  }
}

/**
 * Fill missing USD values in parallel (small pool) with a per-token cache.
 * Returns the input list with zero-price rows left as-is when unknown.
 */
export async function fillMissingRhUsd(
  tokens: UserToken[],
  opts?: { cap?: number; concurrency?: number },
): Promise<UserToken[]> {
  const cap = opts?.cap ?? RH_PRICE_FILL_CAP
  const concurrency = opts?.concurrency ?? RH_PRICE_FILL_CONCURRENCY
  const out = [...tokens]
  const missing = out
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !(t.usdValue > 0))
    .slice(0, cap)

  if (missing.length === 0) return out
  for (let i = 0; i < missing.length; i += concurrency) {
    const chunk = missing.slice(i, i + concurrency)
    let prices: number[]
    try {
      prices = await Promise.all(
        chunk.map(({ t }) => fetchRhTokenUsdCached(t.mintAddress)),
      )
    } catch (error) {
      // Rate limited: keep what's priced so far instead of burning the rest of
      // the window (and the request budget) on guaranteed 429s.
      if (error instanceof GmgnApiError && error.code === 'RATE_LIMIT') {
        console.warn('[rh-usd-meta] price fill rate limited, partial')
        break
      }
      throw error
    }
    chunk.forEach(({ t, i: idx }, j) => {
      const px = prices[j]
      if (px > 0) out[idx] = { ...t, usdValue: t.uiAmount * px }
    })
  }
  return out
}

/**
 * Token metadata (decimals/symbol/name/logo) for a RH ERC-20. GMGN is tried
 * first (the app's signed client; Blockscout now Cloudflare-challenges server
 * fetches), Blockscout second. Returns null when neither knows the token.
 */
export async function fetchRhTokenMeta(
  address: string,
  opts?: { fetchFn?: typeof fetch },
): Promise<RhTokenMeta | null> {
  const addr = String(address ?? '').trim().toLowerCase()
  if (!isEvmAddress(addr)) return null
  const fetchFn = opts?.fetchFn ?? fetch

  // GMGN /v1/token/info (field-tolerant)
  try {
    const info = await tokenInfo({ chain: 'robinhood', address: addr })
    const nested = asRecord(info.token) ?? asRecord(info.base_token)
    const tok = nested ?? info
    const decimalsRaw = tok.decimals ?? tok.decimals_number
    const symbol = String(tok.symbol ?? '')
    if (symbol || decimalsRaw != null) {
      const logo =
        typeof tok.logo === 'string'
          ? tok.logo
          : typeof tok.logo_url === 'string'
            ? tok.logo_url
            : undefined
      return {
        address: addr,
        symbol: symbol || undefined,
        name: typeof tok.name === 'string' && tok.name ? tok.name : undefined,
        decimals:
          decimalsRaw != null && String(decimalsRaw) !== ''
            ? Math.max(0, Math.floor(num(decimalsRaw)))
            : undefined,
        logoURI: logo,
      }
    }
  } catch {
    // fall through to Blockscout
  }

  // Blockscout /api/v2/tokens/{hash}
  try {
    const res = await fetchFn(`${RH_BLOCKSCOUT_BASE}/api/v2/tokens/${addr}`, {
      headers: { accept: 'application/json' },
    })
    if (res.ok) {
      const t = (await res.json()) as Record<string, unknown>
      const type = String(t.type ?? '').toUpperCase()
      if (type && type !== 'ERC-20') return null
      const symbol = String(t.symbol ?? '')
      return {
        address: addr,
        symbol: symbol || undefined,
        name: typeof t.name === 'string' && t.name ? t.name : undefined,
        decimals:
          t.decimals != null && String(t.decimals) !== ''
            ? Math.max(0, Math.floor(num(t.decimals)))
            : undefined,
        logoURI: typeof t.icon_url === 'string' ? t.icon_url : undefined,
      }
    }
  } catch {
    return null
  }
  return null
}
