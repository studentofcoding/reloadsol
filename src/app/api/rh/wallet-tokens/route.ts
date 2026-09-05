import { NextRequest, NextResponse, connection } from 'next/server'
import { tokenInfo, walletHoldings, GmgnApiError } from '@/utils/gmgn-api'
import type { UserToken } from '@/utils/jupiter'
import {
  extractGmgnTokenUsdPrice,
  fetchBlockscoutErc20Tokens,
  fetchRpcErc20Tokens,
  isEvmAddress,
  isRhHeldToken,
  normalizeGmgnHolding,
  parseRhSkipAddresses,
  rpcZeroAddresses,
  sortRhTokensByUsd,
  type RhTokenMeta,
} from '@/utils/rh-wallet-holdings'
import { RH_USDG, RH_USDG_DECIMALS, RH_WETH } from '@/utils/dlmm/rh-univ2'
import { cacheGet, cacheSet } from '@/utils/redis-cache'
import { portfolioKey } from '@/utils/portfolio-cache'
import { query } from '@/utils/db'


const PRICE_FILL_CAP = 15
const PRICE_FILL_CONCURRENCY = 2
const RESPONSE_TTL_S = 20
const RESPONSE_STALE_TTL_S = 120
const TOKEN_USD_TTL_S = 60
const SEEN_TOKENS_TTL_S = 30 * 24 * 60 * 60 // 30 days

export const maxDuration = 60

type RhTokensSource = 'gmgn' | 'blockscout' | 'rpc'

type CachedResponse = { tokens: UserToken[]; source: RhTokensSource }

const QUOTE_CANDIDATES: RhTokenMeta[] = [
  { address: RH_WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 },
  { address: RH_USDG, symbol: 'USDG', name: 'USDG', decimals: RH_USDG_DECIMALS },
]

function seenKey(wallet: string): string {
  return `rh:seen-tokens:${wallet}`
}

function toMeta(t: UserToken): RhTokenMeta {
  return {
    address: t.mintAddress,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    logoURI: t.logoURI,
  }
}

/**
 * Tokens the wallet has traded recently (from the app's trading history). Used
 * as RPC-fallback candidates so a wallet whose holdings aren't in GMGN/
 * Blockscout can still have its real tokens surfaced via balanceOf.
 */
async function getRhTradeCandidates(wallet: string): Promise<RhTokenMeta[]> {
  try {
    const { rows } = await query<{ data: unknown }>(
      `SELECT data FROM trading_records
       WHERE wallet_address = $1
       ORDER BY timestamp DESC
       LIMIT 300`,
      [wallet],
    )
    const seen = new Set<string>()
    const out: RhTokenMeta[] = []
    for (const row of rows) {
      const data = row.data as {
        tokens?: Array<{ mintAddress?: string }>
      } | null
      for (const t of data?.tokens ?? []) {
        const mint = String(t?.mintAddress ?? '').trim().toLowerCase()
        if (!isEvmAddress(mint) || seen.has(mint)) continue
        seen.add(mint)
        out.push({ address: mint })
        if (out.length >= 40) return out
      }
    }
    return out
  } catch (err) {
    console.warn('[rh/wallet-tokens] trade candidates failed:', err)
    return []
  }
}

async function pruneSeenZeros(
  wallet: string,
  zeroAddresses: string[],
): Promise<void> {
  if (zeroAddresses.length === 0) return
  try {
    const prev = (await cacheGet<RhTokenMeta[]>(seenKey(wallet))) ?? []
    if (prev.length === 0) return
    const drop = new Set(zeroAddresses.map((a) => a.toLowerCase()))
    const next = prev.filter((m) => !drop.has(m.address.toLowerCase()))
    if (next.length === prev.length) return
    await cacheSet(seenKey(wallet), next, SEEN_TOKENS_TTL_S)
  } catch {
    // best-effort
  }
}

/** Remember tokens the wallet holds so the raw-RPC fallback has candidates. */
async function persistSeenTokens(
  wallet: string,
  tokens: UserToken[],
): Promise<void> {
  try {
    const prev = (await cacheGet<RhTokenMeta[]>(seenKey(wallet))) ?? []
    const merged = new Map<string, RhTokenMeta>()
    for (const m of prev) merged.set(m.address.toLowerCase(), m)
    for (const t of tokens) {
      if (t.mintAddress && t.symbol && t.symbol !== '???') {
        merged.set(t.mintAddress.toLowerCase(), toMeta(t))
      }
    }
    await cacheSet(seenKey(wallet), Array.from(merged.values()), SEEN_TOKENS_TTL_S)
  } catch {
    // best-effort
  }
}

async function fetchTokenUsdCached(address: string): Promise<number> {
  const key = `rh:token-usd:${address.toLowerCase()}`
  const cached = await cacheGet<number>(key)
  if (cached != null && cached > 0) return cached
  try {
    const info = await tokenInfo({ chain: 'robinhood', address })
    const px = extractGmgnTokenUsdPrice(info)
    if (px > 0) void cacheSet(key, px, TOKEN_USD_TTL_S)
    return px
  } catch (error) {
    if (error instanceof GmgnApiError && error.code === 'RATE_LIMIT') {
      throw error
    }
    return 0
  }
}

/** Fill missing USD values in parallel (small pool) with a per-token price cache. */
async function fillMissingUsd(tokens: UserToken[]): Promise<UserToken[]> {
  const out = [...tokens]
  const missing = out
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !(t.usdValue > 0))
    .slice(0, PRICE_FILL_CAP)

  try {
    for (let i = 0; i < missing.length; i += PRICE_FILL_CONCURRENCY) {
      const chunk = missing.slice(i, i + PRICE_FILL_CONCURRENCY)
      const prices = await Promise.all(
        chunk.map(({ t }) => fetchTokenUsdCached(t.mintAddress)),
      )
      chunk.forEach(({ t, i: idx }, j) => {
        const px = prices[j]
        if (px > 0) out[idx] = { ...t, usdValue: t.uiAmount * px }
      })
    }
  } catch (error) {
    // Rate limited: keep what's priced so far instead of burning the rest of
    // the window (and the request budget) on guaranteed 429s.
    if (error instanceof GmgnApiError && error.code === 'RATE_LIMIT') {
      console.warn('[rh/wallet-tokens] price fill rate limited, returning partial')
    } else {
      throw error
    }
  }
  return out
}

export async function GET(request: NextRequest) {
  await connection()
  try {
    const wallet = request.nextUrl.searchParams.get('wallet')?.trim() ?? ''
    if (!isEvmAddress(wallet)) {
      return NextResponse.json(
        { success: false, error: 'wallet must be a 0x EVM address' },
        { status: 400 },
      )
    }
    const walletNorm = wallet.toLowerCase()

    // Post-trade refresh: bypass the response cache so the just-bought/sold
    // token shows up immediately instead of waiting out the TTL.
    const skipCache = request.nextUrl.searchParams.get('fresh') === '1'
    const skip = parseRhSkipAddresses(
      request.nextUrl.searchParams.get('skip'),
    )
    let rpcZeros: string[] = []

    const cacheKey = portfolioKey('robinhood', walletNorm, 'holdings')
    const staleKey = `${cacheKey}:stale`
    if (!skipCache) {
      const cached = await cacheGet<CachedResponse>(cacheKey)
      if (cached) {
        return NextResponse.json({
          success: true,
          tokens: cached.tokens,
          source: cached.source,
          wallet: walletNorm,
          cached: true,
        })
      }
    }

    let source: RhTokensSource = 'gmgn'
    let tokens: UserToken[] = []

    // 1) GMGN wallet_holdings (primary)
    try {
      if (process.env.GMGN_API_KEY?.trim() && process.env.GMGN_PRIVATE_KEY?.trim()) {
        const rows = await walletHoldings({
          chain: 'robinhood',
          wallet: walletNorm,
          limit: 100,
        })
        tokens = rows
          .map((r) => normalizeGmgnHolding(r))
          .filter((t): t is UserToken => t != null)
      }
    } catch (err) {
      // Rate limited (or any GMGN failure): fall through to Blockscout/RPC
      // instead of failing the request.
      if (!(err instanceof GmgnApiError && err.code === 'RATE_LIMIT')) {
        console.warn('[rh/wallet-tokens] GMGN holdings failed:', err)
      }
      tokens = []
    }

    // 2) Blockscout explorer API (fallback)
    if (tokens.length === 0) {
      source = 'blockscout'
      try {
        tokens = await fetchBlockscoutErc20Tokens(walletNorm)
        tokens = await fillMissingUsd(tokens)
      } catch (err) {
        console.warn('[rh/wallet-tokens] Blockscout holdings failed:', err)
        tokens = []
      }
    }

    // Remember holdings from indexer sources for the RPC fallback.
    if (tokens.length > 0) void persistSeenTokens(walletNorm, tokens)

    // 3) Direct RPC ethereum calls (last resort — no indexer available)
    if (tokens.length === 0) {
      source = 'rpc'
      try {
        const [seen, trade] = await Promise.all([
          cacheGet<RhTokenMeta[]>(seenKey(walletNorm)).catch(() => null),
          getRhTradeCandidates(walletNorm),
        ])
        const rpc = await fetchRpcErc20Tokens(
          walletNorm,
          [...QUOTE_CANDIDATES, ...(seen ?? []), ...trade],
          { skip },
        )
        tokens = rpc.tokens.filter(isRhHeldToken)
        rpcZeros = rpcZeroAddresses(rpc.probed, tokens)
        if (rpcZeros.length > 0) void pruneSeenZeros(walletNorm, rpcZeros)
        tokens = await fillMissingUsd(tokens)
      } catch (err) {
        console.warn('[rh/wallet-tokens] RPC holdings failed:', err)
        tokens = []
      }
    }

    tokens = sortRhTokensByUsd(tokens.filter(isRhHeldToken))

    // Cache a valid snapshot + a longer-lived last-known-good copy (SWR). Only
    // persist when a source of truth (indexer) found holdings — an empty shell
    // OR a degraded RPC-only fallback list (which only knows a few quote
    // candidates and can appear as "just USDG") must never be cached, or that
    // partial result would be frozen for the whole TTL/stale window.
    if (
      !skipCache &&
      source !== 'rpc' &&
      tokens.length > 0
    ) {
      const resp = { tokens, source } satisfies CachedResponse
      void cacheSet(cacheKey, resp, RESPONSE_TTL_S)
      void cacheSet(staleKey, resp, RESPONSE_STALE_TTL_S)
    }

    // All sources empty/failed: serve the last-known-good snapshot so a
    // transient indexer/RPC blip never surfaces an empty portfolio.
    if (!skipCache && tokens.length === 0) {
      const stale = await cacheGet<CachedResponse>(staleKey)
      if (stale) {
        return NextResponse.json({
          success: true,
          tokens: stale.tokens,
          source: stale.source,
          wallet: walletNorm,
          cached: true,
          stale: true,
        })
      }
    }

    return NextResponse.json({
      success: true,
      tokens,
      source,
      wallet: walletNorm,
      fresh: skipCache,
      rpcZeros,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
