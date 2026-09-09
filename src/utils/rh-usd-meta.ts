import type { UserToken } from '@/utils/jupiter'
import { tokenInfo, GmgnApiError } from '@/utils/gmgn-api'
import { cacheGet, cacheSet } from '@/utils/redis-cache'
import {
  extractGmgnTokenUsdPrice,
  isEvmAddress,
  RH_BLOCKSCOUT_BASE,
  type RhTokenMeta,
} from '@/utils/rh-wallet-holdings'
import {
  RH_USDG,
  RH_WETH,
} from '@/utils/dlmm/rh-univ2'

// ---------------------------------------------------------------------------
// SERVER-ONLY RH price + metadata helpers. Kept out of rh-wallet-holdings.ts:
// that module is reachable from client bundles (useRhWalletTokens & friends),
// and gmgn-api / redis-cache (ioredis) are server dependencies that break the
// Next client build. Only server routes (ledger ingest/holdings, wallet-tokens)
// import this file.
// ---------------------------------------------------------------------------

export const RH_TOKEN_USD_TTL_S = Math.max(
  10,
  Number(process.env.RH_TOKEN_USD_TTL_S ?? 300),
)
export const RH_PRICE_FILL_CAP = Math.max(
  1,
  Number(process.env.RH_PRICE_FILL_CAP ?? 40),
)
export const RH_PRICE_FILL_CONCURRENCY = Math.max(
  1,
  Number(process.env.RH_PRICE_FILL_CONCURRENCY ?? 2),
)
/** How long a zero/unknown price is remembered (avoids refetch storms). */
const RH_PRICE_ZERO_TTL_S = 30
/** Goldsky-hosted RH UniV2 subgraph — free, rate-agnostic price source. */
const RH_UNIV2_SUBGRAPH =
  'https://api.goldsky.com/api/public/project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-v2-mainnet/0.1.0/gn'

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

// Per-process: right after a GMGN 429, skip further GMGN calls for ~1.5 s so a
// batch/request loop can't immediately hammer it again (subgraph leg still runs).
let gmgnRateLimitedUntil = 0

// ---------------------------------------------------------------------------
// UniV2 subgraph price leg. USDG is the $1 anchor; WETH crosses via USDG/WETH.
// ---------------------------------------------------------------------------

type SubPair = {
  tokenA: string
  tokenB: string
  decimalsA: number
  decimalsB: number
  reserveA: string
  reserveB: string
}

async function fetchRhPairs(token: string): Promise<SubPair[]> {
  const q = `{ pairs(first: 25, orderBy: reserveUSD, orderDirection: desc, where: { or: [{ token0: "${token}" }, { token1: "${token}" }] }) { reserve0 reserve1 token0 { id decimals } token1 { id decimals } } }`
  const res = await fetch(RH_UNIV2_SUBGRAPH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return []
  const data = (await res.json()) as { data?: { pairs?: unknown[] } }
  const pairs = data.data?.pairs ?? []
  const out: SubPair[] = []
  for (const raw of pairs) {
    const p = raw as {
      reserve0?: string
      reserve1?: string
      token0?: { id?: string; decimals?: string }
      token1?: { id?: string; decimals?: string }
    }
    const t0 = String(p.token0?.id ?? '').toLowerCase()
    const t1 = String(p.token1?.id ?? '').toLowerCase()
    const d0 = num(p.token0?.decimals)
    const d1 = num(p.token1?.decimals)
    const r0 = String(p.reserve0 ?? '')
    const r1 = String(p.reserve1 ?? '')
    if (!t0 || !t1 || !r0 || !r1) continue
    out.push({
      tokenA: t0,
      tokenB: t1,
      decimalsA: d0,
      decimalsB: d1,
      reserveA: r0,
      reserveB: r1,
    })
  }
  return out
}

const RH_USDG_LOWER = RH_USDG.toLowerCase()
const RH_WETH_LOWER = RH_WETH.toLowerCase()

let wethUsdCache = { at: 0, px: 0 }

/** USD per WETH via the USDG/WETH UniV2 pair (cached 2 min). */
async function fetchWethUsd(): Promise<number> {
  const now = Date.now()
  if (wethUsdCache.px > 0 && now - wethUsdCache.at < 120_000) {
    return wethUsdCache.px
  }
  const pairs = await fetchRhPairs(RH_WETH_LOWER)
  const pair = pairs.find((p) =>
    p.tokenA === RH_USDG_LOWER || p.tokenB === RH_USDG_LOWER,
  )
  if (!pair) return 0
  const isToken0 = pair.tokenA === RH_WETH_LOWER
  const baseReserve = isToken0
    ? Number(pair.reserveB)
    : Number(pair.reserveA)
  const baseDecimals = isToken0 ? pair.decimalsB : pair.decimalsA
  const wethReserve = isToken0
    ? Number(pair.reserveA)
    : Number(pair.reserveB)
  const wethDecimals = isToken0 ? pair.decimalsA : pair.decimalsB
  if (wethReserve <= 0 || baseReserve <= 0) return 0
  // USD per WETH = (usdg_reserve / 10^6) / (weth_reserve / 10^18)
  const usdPerWeth =
    (baseReserve / 10 ** baseDecimals) / (wethReserve / 10 ** wethDecimals)
  if (usdPerWeth > 0) wethUsdCache = { at: now, px: usdPerWeth }
  return usdPerWeth
}

/**
 * USD price of an RH token derived from its best UniV2 pair on Goldsky's RH
 * subgraph. USDG pairs anchor directly ($1); WETH pairs cross via USDG/WETH.
 * Returns null when the token has no usable pair (genuinely unpriceable here).
 */
export async function fetchRhUniV2UsdPrice(
  address: string,
): Promise<number | null> {
  const addr = String(address ?? '').trim().toLowerCase()
  if (!isEvmAddress(addr) || addr === RH_USDG_LOWER) return 1
  let wethUsd = 0
  try {
    const pairs = await fetchRhPairs(addr)
    // Prefer the deepest USDG pair; else deepest WETH pair crossed to USD.
    const usdg = pairs.find(
      (p) => p.tokenA === RH_USDG_LOWER || p.tokenB === RH_USDG_LOWER,
    )
    if (usdg) return usdFromPair(usdg, addr, 1)
    const weth = pairs.find(
      (p) => p.tokenA === RH_WETH_LOWER || p.tokenB === RH_WETH_LOWER,
    )
    if (weth) {
      wethUsd = await fetchWethUsd()
      if (wethUsd > 0) return usdFromPair(weth, addr, wethUsd)
    }
    return null
  } catch {
    return null
  }
}

/** USD per target token from a pair where target is one side. */
function usdFromPair(pair: SubPair, target: string, baseUsd: number): number {
  const targetIsA = pair.tokenA === target
  const targetReserve = targetIsA ? Number(pair.reserveA) : Number(pair.reserveB)
  const targetDecimals = targetIsA ? pair.decimalsA : pair.decimalsB
  const baseReserve = targetIsA ? Number(pair.reserveB) : Number(pair.reserveA)
  const baseDecimals = targetIsA ? pair.decimalsB : pair.decimalsA
  if (targetReserve <= 0 || baseReserve <= 0) return 0
  // base-units per token → × baseUsd
  return (
    ((baseReserve / 10 ** baseDecimals) / (targetReserve / 10 ** targetDecimals)) *
    baseUsd
  )
}

/**
 * Cached USD price for a RH token. Legs: Redis → GMGN tokenInfo → UniV2
 * subgraph (USDG/WETH anchors) → 0. GMGN 429s never zero the batch — they fall
 * through to the subgraph and trigger a short per-process cool-off.
 */
export async function fetchRhTokenUsdCached(address: string): Promise<number> {
  const addr = String(address ?? '').trim().toLowerCase()
  const key = `rh:token-usd:${addr}`
  const cached = await cacheGet<number>(key)
  if (cached != null && cached > 0) return cached

  let px = 0
  if (Date.now() >= gmgnRateLimitedUntil) {
    try {
      const info = await tokenInfo({ chain: 'robinhood', address: addr })
      px = extractGmgnTokenUsdPrice(info)
    } catch (error) {
      if (error instanceof GmgnApiError && error.code === 'RATE_LIMIT') {
        gmgnRateLimitedUntil = Date.now() + 1500
      }
    }
  }
  if (px <= 0) {
    px = (await fetchRhUniV2UsdPrice(addr).catch(() => null)) ?? 0
  }

  if (px > 0) void cacheSet(key, px, RH_TOKEN_USD_TTL_S)
  else void cacheSet(key, 0, RH_PRICE_ZERO_TTL_S)
  return px
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
  // Price the largest holdings first so the cap spends its budget on what the
  // user actually sees at the top of the list.
  const missing = out
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !(t.usdValue > 0))
    .sort((a, b) => b.t.uiAmount - a.t.uiAmount)
    .slice(0, cap)

  if (missing.length === 0) return out
  for (let i = 0; i < missing.length; i += concurrency) {
    const chunk = missing.slice(i, i + concurrency)
    const prices = await Promise.all(
      chunk.map(({ t }) => fetchRhTokenUsdCached(t.mintAddress)),
    )
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
