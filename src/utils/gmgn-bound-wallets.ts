import type { GmgnTradeChain } from './gmgn-currencies'
import { userInfo } from './gmgn-api'

export type GmgnBoundWallets = {
  sol: string | null
  evm: string | null
}

/** Server-only: read public bound addresses from env (never PEM). */
export function getGmgnBoundWalletsFromEnv(): GmgnBoundWallets {
  const sol = process.env.GMGN_BOUND_SOL_ADDRESS?.trim() || null
  const evm = process.env.GMGN_BOUND_EVM_ADDRESS?.trim() || null
  return {
    sol: sol || null,
    evm: evm ? evm.toLowerCase() : null,
  }
}

export function boundAddressForChain(
  wallets: GmgnBoundWallets,
  chain: GmgnTradeChain,
): string | null {
  return chain === 'sol' ? wallets.sol : wallets.evm
}

export function isGmgnBoundSol(
  connected: string | null | undefined,
  boundSol: string | null | undefined,
): boolean {
  if (!connected?.trim() || !boundSol?.trim()) return false
  return connected.trim() === boundSol.trim()
}

export function isGmgnBoundEvm(
  connected: string | null | undefined,
  boundEvm: string | null | undefined,
): boolean {
  if (!connected?.trim() || !boundEvm?.trim()) return false
  return connected.trim().toLowerCase() === boundEvm.trim().toLowerCase()
}

const EVM_RE = /^0x[a-fA-F0-9]{40}$/
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

type WalletRow = { chain: string; address: string }

/** Pure parser for /v1/user/info — exported for the self-check. */
export function parseBoundWalletsFromUserInfo(
  data: unknown,
): GmgnBoundWallets {
  const out: GmgnBoundWallets = { sol: null, evm: null }
  if (!data || typeof data !== 'object') return out
  const root = data as Record<string, unknown>

  const rows: WalletRow[] = []
  const listCandidates = [root.wallets, root.wallet_list, root.addresses, root.list]
  for (const cand of listCandidates) {
    if (!Array.isArray(cand)) continue
    for (const item of cand) {
      if (!item || typeof item !== 'object') continue
      const r = item as Record<string, unknown>
      const address = String(
        r.address ?? r.wallet_address ?? r.wallet ?? '',
      ).trim()
      const chain = String(r.chain ?? r.network ?? '').trim().toLowerCase()
      if (!address) continue
      rows.push({ chain, address })
    }
  }

  // Map-shaped: { sol: { address }, robinhood: "0x…" }
  for (const chain of ['sol', 'robinhood', 'eth', 'base', 'bsc'] as const) {
    const v = root[chain]
    if (typeof v === 'string' && v.trim()) {
      rows.push({ chain, address: v.trim() })
    } else if (v && typeof v === 'object') {
      const addr = String(
        (v as Record<string, unknown>).address ??
          (v as Record<string, unknown>).wallet_address ??
          '',
      ).trim()
      if (addr) rows.push({ chain, address: addr })
    }
  }

  for (const row of rows) {
    if (!out.sol && (row.chain === 'sol' || (!row.chain && SOL_RE.test(row.address)))) {
      if (SOL_RE.test(row.address)) out.sol = row.address
    }
  }
  // Prefer robinhood, then any EVM chain address
  for (const prefer of ['robinhood', 'eth', 'base', 'bsc', '']) {
    if (out.evm) break
    for (const row of rows) {
      if (prefer && row.chain !== prefer) continue
      if (EVM_RE.test(row.address)) {
        out.evm = row.address.toLowerCase()
        break
      }
    }
  }
  return out
}

let cache: { at: number; value: GmgnBoundWallets } | null = null
const CACHE_MS = 60_000

/**
 * Env overrides win; otherwise fetch /v1/user/info and parse bound wallets.
 * Cached briefly so bound-wallets + trade routes do not hammer GMGN.
 */
export async function resolveGmgnBoundWallets(): Promise<GmgnBoundWallets> {
  const fromEnv = getGmgnBoundWalletsFromEnv()
  if (fromEnv.sol && fromEnv.evm) return fromEnv

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return {
      sol: fromEnv.sol ?? cache.value.sol,
      evm: fromEnv.evm ?? cache.value.evm,
    }
  }

  if (!process.env.GMGN_API_KEY?.trim()) {
    return fromEnv
  }

  try {
    const info = await userInfo()
    const parsed = parseBoundWalletsFromUserInfo(info)
    cache = { at: Date.now(), value: parsed }
    return {
      sol: fromEnv.sol ?? parsed.sol,
      evm: fromEnv.evm ?? parsed.evm,
    }
  } catch {
    return fromEnv
  }
}
