import type { OpenBarPosition } from '@/utils/open-bar-positions'

/**
 * Provisional first paint for the open-positions bar.
 *
 * The bar's first render otherwise waits on a network holdings fetch, which is the whole reload
 * delay. Seeding it from the last observed list renders the chips immediately; the live query then
 * reconciles. This is stale-while-revalidate, so:
 * - the store is keyed by **wallet AND chain** (a wallet-only key would let Solana positions answer
 *   a Robinhood read — the same missing-dimension defect as a mint-keyed quote map),
 * - entries expire, so a wallet left behind cannot resurrect ancient chips,
 * - a cached list is never treated as fact: the hook only shows it until live inputs exist, never
 *   writes it back, and the percentages stay `—` until live prices land.
 */

const STORAGE_KEY = 'reloadsol_open_bar_positions_v1'
/** Older than this and the chips are more misleading than useful. */
export const OPEN_BAR_CACHE_MAX_AGE_MS = 10 * 60 * 1000

type CacheEntry = { positions: OpenBarPosition[]; updatedAt: string }
type CacheStore = Record<string, CacheEntry>

function cacheKey(walletAddress: string, chain: string): string {
  return `${walletAddress}:${chain}`
}

function readStore(): CacheStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as CacheStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: CacheStore): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // ignore quota / private mode
  }
}

/** Last observed positions for this wallet+chain, or `[]` when absent, malformed or expired. */
export function readOpenBarPositionsCache(
  walletAddress: string,
  chain: string,
): OpenBarPosition[] {
  if (!walletAddress) return []
  const entry = readStore()[cacheKey(walletAddress, chain)]
  if (!entry || !Array.isArray(entry.positions)) return []
  const age = Date.now() - Date.parse(entry.updatedAt)
  if (!Number.isFinite(age) || age > OPEN_BAR_CACHE_MAX_AGE_MS) return []
  return entry.positions
}

export function writeOpenBarPositionsCache(
  walletAddress: string,
  chain: string,
  positions: OpenBarPosition[],
): void {
  if (!walletAddress) return
  const store = readStore()
  store[cacheKey(walletAddress, chain)] = {
    positions,
    updatedAt: new Date().toISOString(),
  }
  writeStore(store)
}

export function clearOpenBarPositionsCache(
  walletAddress: string,
  chain: string,
): void {
  if (!walletAddress) return
  const store = readStore()
  delete store[cacheKey(walletAddress, chain)]
  writeStore(store)
}
