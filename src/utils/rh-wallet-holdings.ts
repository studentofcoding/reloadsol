import type { UserToken } from '@/utils/jupiter'
import { isValidSolanaAddress } from '@/utils/solana-address'
import { createPublicClient, http, type Address } from 'viem'
import { RH_CHAIN, getRhRpcUrl } from '@/utils/dlmm/rh-univ2'

const EVM_RE = /^0x[a-fA-F0-9]{40}$/
export const RH_BLOCKSCOUT_BASE =
  'https://robinhoodchain.blockscout.com'

export function isEvmAddress(addr: string): boolean {
  return EVM_RE.test(addr.trim())
}

/** Sol or EVM wallet for SSE subscribe; EVM stored/matched lowercased. */
export function normalizeSubscribeWallet(raw: string): string | null {
  const addr = raw.trim()
  if (isEvmAddress(addr)) return addr.toLowerCase()
  if (isValidSolanaAddress(addr)) return addr
  return null
}

export function walletsMatch(a: string, b: string): boolean {
  if (a.startsWith('0x') || b.startsWith('0x')) {
    return a.toLowerCase() === b.toLowerCase()
  }
  return a === b
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Sort priced tokens first (USD desc), then unpriced. */
export function sortRhTokensByUsd(tokens: UserToken[]): UserToken[] {
  return [...tokens].sort((a, b) => {
    const aPriced = a.usdValue > 0
    const bPriced = b.usdValue > 0
    if (aPriced !== bPriced) return aPriced ? -1 : 1
    return b.usdValue - a.usdValue
  })
}

/**
 * Normalize a GMGN wallet_holdings row (flat or nested `token`).
 * Skips non-EVM, zero balance, and NFT-like rows.
 */
export function normalizeGmgnHolding(row: unknown): UserToken | null {
  const r = asRecord(row)
  if (!r) return null
  const tok = asRecord(r.token) ?? r

  const mint = String(
    tok.address ?? tok.token_address ?? r.address ?? r.token_address ?? '',
  )
    .trim()
    .toLowerCase()
  if (!isEvmAddress(mint)) return null

  const decimals = Math.max(0, Math.floor(num(tok.decimals ?? r.decimals ?? 18)))
  // NFT-ish: 0 decimals + tiny supply / balance of 1
  const supply = num(tok.total_supply ?? tok.supply ?? r.total_supply)
  const rawBal = String(
    r.balance_raw ?? r.amount_raw ?? r.balance ?? r.amount ?? tok.balance ?? '0',
  )
  let balanceRaw = 0
  let uiAmount = num(
    r.ui_amount ?? r.token_amount_ui ?? r.balance_ui ?? r.amount_ui,
  )
  if (uiAmount <= 0) {
    // human balance string from GMGN
    const human = num(r.balance ?? r.amount ?? tok.balance)
    if (human > 0 && human < 1e15) {
      uiAmount = human
      balanceRaw = Math.floor(human * 10 ** decimals)
    } else {
      try {
        balanceRaw = Number(BigInt(rawBal.split('.')[0] || '0'))
      } catch {
        balanceRaw = num(rawBal)
      }
      uiAmount = decimals > 0 ? balanceRaw / 10 ** decimals : balanceRaw
    }
  } else {
    balanceRaw = Math.floor(uiAmount * 10 ** decimals)
  }

  if (!(uiAmount > 0)) return null
  if (decimals === 0 && (supply <= 1 || uiAmount <= 1)) {
    return null // NFT-like
  }

  const usdValue = num(r.usd_value ?? r.value_usd ?? r.usdValue ?? tok.usd_value)
  const symbol = String(tok.symbol ?? r.symbol ?? '???')
  const name = String(tok.name ?? r.name ?? symbol)
  const logo =
    typeof tok.logo === 'string'
      ? tok.logo
      : typeof tok.logo_url === 'string'
        ? tok.logo_url
        : typeof r.logo === 'string'
          ? r.logo
          : undefined

  return {
    mintAddress: mint,
    balance: balanceRaw > 0 ? balanceRaw : Math.floor(uiAmount * 10 ** decimals),
    decimals,
    symbol,
    name,
    logoURI: logo,
    uiAmount,
    usdValue,
    isNFT: false,
  }
}

/**
 * Normalize Blockscout /api/v2/.../tokens item. ERC-20 only.
 */
export function normalizeBlockscoutErc20(row: unknown): UserToken | null {
  const r = asRecord(row)
  if (!r) return null
  const tok = asRecord(r.token)
  if (!tok) return null
  const type = String(tok.type ?? '').toUpperCase()
  if (type && type !== 'ERC-20') return null

  const mint = String(tok.address_hash ?? tok.address ?? '')
    .trim()
    .toLowerCase()
  if (!isEvmAddress(mint)) return null

  const decimals = Math.max(0, Math.floor(num(tok.decimals ?? 18)))
  let balanceRaw = 0
  try {
    balanceRaw = Number(BigInt(String(r.value ?? '0')))
  } catch {
    balanceRaw = num(r.value)
  }
  if (!(balanceRaw > 0)) return null
  const uiAmount = decimals > 0 ? balanceRaw / 10 ** decimals : balanceRaw
  if (!(uiAmount > 0)) return null

  const rate = num(tok.exchange_rate ?? r.exchange_rate)
  const usdFromFiat = num(r.fiat_value ?? r.value_usd)
  const usdValue =
    usdFromFiat > 0 ? usdFromFiat : rate > 0 ? uiAmount * rate : 0

  return {
    mintAddress: mint,
    balance: balanceRaw,
    decimals,
    symbol: String(tok.symbol ?? '???'),
    name: String(tok.name ?? tok.symbol ?? 'Unknown'),
    logoURI: typeof tok.icon_url === 'string' ? tok.icon_url : undefined,
    uiAmount,
    usdValue,
    isNFT: false,
  }
}

export function extractGmgnTokenUsdPrice(info: Record<string, unknown>): number {
  const priceObj = asRecord(info.price)
  if (priceObj) {
    const p = num(priceObj.price)
    if (p > 0) return p
  }
  return num(info.price)
}

export async function fetchBlockscoutErc20Tokens(
  wallet: string,
  opts?: { maxPages?: number; fetchFn?: typeof fetch },
): Promise<UserToken[]> {
  const fetchFn = opts?.fetchFn ?? fetch
  const maxPages = opts?.maxPages ?? 5
  const out: UserToken[] = []
  let url:
    | string
    | null = `${RH_BLOCKSCOUT_BASE}/api/v2/addresses/${wallet}/tokens?type=ERC-20`

  for (let page = 0; page < maxPages && url; page++) {
    const res = await fetchFn(url)
    if (!res.ok) break
    const data = (await res.json()) as {
      items?: unknown[]
      next_page_params?: Record<string, unknown> | null
    }
    for (const item of data.items ?? []) {
      const t = normalizeBlockscoutErc20(item)
      if (t) out.push(t)
    }
    const next = data.next_page_params
    if (!next || typeof next !== 'object') {
      url = null
      break
    }
    const qs = new URLSearchParams({ type: 'ERC-20' })
    for (const [k, v] of Object.entries(next)) {
      if (v != null) qs.set(k, String(v))
    }
    url = `${RH_BLOCKSCOUT_BASE}/api/v2/addresses/${wallet}/tokens?${qs}`
  }
  return out
}

/** Static metadata for a RH ERC-20 used by the raw-RPC fallback. */
export type RhTokenMeta = {
  address: string
  symbol?: string
  name?: string
  decimals?: number
  logoURI?: string
}

const BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * Last-resort holdings lookup via direct ethereum calls (no indexer):
 * balanceOf over a candidate token list. Candidates come from tokens the
 * wallet was previously seen holding (cached by the API route) plus the
 * quote currencies, so no GMGN/Blockscout availability is required.
 */
export async function fetchRpcErc20Tokens(
  wallet: string,
  candidates: RhTokenMeta[],
  opts?: { rpcUrl?: string; concurrency?: number },
): Promise<UserToken[]> {
  const client = createPublicClient({
    chain: RH_CHAIN,
    transport: http(opts?.rpcUrl ?? getRhRpcUrl()),
  })
  const account = wallet as Address
  const seen = new Set<string>()
  const unique = candidates.filter((c) => {
    const addr = String(c.address ?? '').trim().toLowerCase()
    if (!isEvmAddress(addr) || seen.has(addr)) return false
    seen.add(addr)
    return true
  })

  const out: UserToken[] = []
  const concurrency = Math.max(1, opts?.concurrency ?? 8)
  for (let i = 0; i < unique.length; i += concurrency) {
    const chunk = unique.slice(i, i + concurrency)
    const results = await Promise.all(
      chunk.map(async (c) => {
        try {
          const bal = await client.readContract({
            address: c.address as Address,
            abi: BALANCE_OF_ABI,
            functionName: 'balanceOf',
            args: [account],
          })
          return { c, bal }
        } catch {
          return null
        }
      }),
    )
    for (const r of results) {
      if (!r || r.bal <= BigInt(0)) continue
      const decimals = Math.max(0, Math.floor(r.c.decimals ?? 18))
      const balanceRaw = Number(r.bal)
      const uiAmount = decimals > 0 ? balanceRaw / 10 ** decimals : balanceRaw
      if (!(uiAmount > 0)) continue
      out.push({
        mintAddress: r.c.address.toLowerCase(),
        balance: balanceRaw,
        decimals,
        symbol: r.c.symbol ?? '???',
        name: r.c.name ?? r.c.symbol ?? 'Unknown',
        logoURI: r.c.logoURI,
        uiAmount,
        usdValue: 0,
        isNFT: false,
      })
    }
  }
  return out
}
